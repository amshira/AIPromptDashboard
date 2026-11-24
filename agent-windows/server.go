package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- who may connect ----------

// allowListener drops connections from any address outside the allow list before a single byte of TLS is
// exchanged: to everyone else the port looks closed or broken.
type allowListener struct {
	net.Listener
	allow []*net.IPNet
	log   *log.Logger
	mu    sync.Mutex
	last  map[string]time.Time
}

func (l *allowListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		host, _, _ := net.SplitHostPort(c.RemoteAddr().String())
		ip := net.ParseIP(host)
		ok := false
		for _, n := range l.allow {
			if ip != nil && n.Contains(ip) {
				ok = true
				break
			}
		}
		if ok {
			return c, nil
		}
		if tc, isTCP := c.(*net.TCPConn); isTCP {
			_ = tc.SetLinger(0) // reset, not a polite close
		}
		_ = c.Close()
		l.note(host)
	}
}

// note logs a refused address at most once an hour, so a scan cannot fill the disk.
func (l *allowListener) note(host string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if t, seen := l.last[host]; seen && time.Since(t) < time.Hour {
		return
	}
	if len(l.last) > 1000 {
		l.last = map[string]time.Time{}
	}
	l.last[host] = time.Now()
	l.log.Printf("refused a connection from %s (not in allow list)", host)
}

// ---------- request signatures ----------

// Signature: Authorization: Signature t=<unix seconds>,n=<random hex>,s=<hex HMAC-SHA256>
// over "GET\n<path>\n<raw query>\n<t>\n<n>". A signature is good for two minutes and only once.
const maxSkew = 2 * time.Minute

type verifier struct {
	key  []byte
	mu   sync.Mutex
	seen map[string]time.Time
}

func newVerifier(secretHex string) *verifier {
	k, _ := hex.DecodeString(secretHex)
	return &verifier{key: k, seen: map[string]time.Time{}}
}

func sign(key []byte, method, path, rawQuery, t, n string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(method + "\n" + path + "\n" + rawQuery + "\n" + t + "\n" + n))
	return hex.EncodeToString(m.Sum(nil))
}

func (v *verifier) check(r *http.Request, now time.Time) error {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Signature ") {
		return errors.New("no signature")
	}
	parts := map[string]string{}
	for _, p := range strings.Split(strings.TrimPrefix(h, "Signature "), ",") {
		if k, val, ok := strings.Cut(strings.TrimSpace(p), "="); ok {
			parts[k] = val
		}
	}
	t, n, s := parts["t"], parts["n"], parts["s"]
	sec, err := strconv.ParseInt(t, 10, 64)
	if err != nil || len(n) < 16 || len(n) > 64 || len(s) != 64 {
		return errors.New("malformed signature")
	}
	if d := now.Sub(time.Unix(sec, 0)); d > maxSkew || d < -maxSkew {
		return errors.New("signature expired (check the clocks)")
	}
	want := sign(v.key, r.Method, r.URL.EscapedPath(), r.URL.RawQuery, t, n)
	if !hmac.Equal([]byte(want), []byte(s)) {
		return errors.New("bad signature")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for k, at := range v.seen {
		if now.Sub(at) > 2*maxSkew {
			delete(v.seen, k)
		}
	}
	if _, dup := v.seen[n]; dup {
		return errors.New("replayed request")
	}
	if len(v.seen) > 100_000 {
		return errors.New("too many requests")
	}
	v.seen[n] = now
	return nil
}

// ---------- the API ----------

type server struct {
	cfg    *Config
	auth   *verifier
	cursor *cursorStore
	codex  *codexStore
	log    *log.Logger
	busy   chan struct{}
	// how a received exe is put in place; applyUpdate by default (Windows task-based swap), replaced in tests
	stage func([]byte) error
	// how a remote stop is carried out; scheduleStop by default (sc stop via a Scheduled Task), replaced in tests
	halt func() error
}

func newServer(cfg *Config, logger *log.Logger) *server {
	return &server{
		cfg:    cfg,
		auth:   newVerifier(cfg.Secret),
		cursor: newCursorStore(cfg.ProfilesDir, time.Duration(cfg.SettleSeconds)*time.Second),
		codex:  newCodexStore(cfg.ProfilesDir, time.Duration(cfg.SettleSeconds)*time.Second),
		log:    logger,
		busy:   make(chan struct{}, 2),
		stage:  applyUpdate,
		halt:   scheduleStop,
	}
}

// ServeHTTP answers only signed GETs on /<prefix>/v1/<endpoint>. Every other request, a bad signature
// included, gets the same empty 404, so the port gives nothing away.
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	notFound := func() { w.WriteHeader(http.StatusNotFound) }
	base := "/" + s.cfg.Prefix + "/v1/"
	if !strings.HasPrefix(r.URL.Path, base) {
		notFound()
		return
	}
	// everything is a signed GET; POSTs are the update push and a remote stop
	endpoint := strings.TrimPrefix(r.URL.Path, base)
	wantMethod := http.MethodGet
	if endpoint == "update" || endpoint == "stop" {
		wantMethod = http.MethodPost
	}
	if r.Method != wantMethod {
		notFound()
		return
	}
	if err := s.auth.check(r, time.Now()); err != nil {
		s.log.Printf("rejected a request from %s: %v", r.RemoteAddr, err)
		notFound()
		return
	}
	select {
	case s.busy <- struct{}{}:
		defer func() { <-s.busy }()
	default:
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	// sqlite can sit in a read after the HTTP deadline; if that happens, leave so Windows
	// restarts the service. the update POST is excluded: it is large and already restarts itself.
	if endpoint != "update" && endpoint != "stop" {
		finished := make(chan struct{})
		defer close(finished)
		go watchHung(s.log, finished)
	}
	q := r.URL.Query()
	if endpoint == "update" {
		s.handleUpdate(w, r, q.Get("h"))
		return
	}
	if endpoint == "stop" {
		s.handleStop(w)
		return
	}
	var body any
	var err error
	switch endpoint {
	case "sources":
		body, err = mergeSources(s.cursor, s.codex)
	case "oldest":
		var o *string
		o, err = s.oldest(q.Get("source"))
		body = map[string]any{"oldest": o}
	case "rows":
		limit, _ := strconv.Atoi(q.Get("limit"))
		if limit < 1 || limit > 50 {
			limit = 10
		}
		var rows []Row
		rows, err = s.rows(q.Get("source"), q.Get("ts"), q.Get("id"), limit)
		body = map[string]any{"rows": rows}
	case "keys":
		// Cursor has no api keys: the Windows profile is the person
		body = map[string]any{"keys": []any{}, "usage": []any{}}
	default:
		notFound()
		return
	}
	if errors.Is(err, errUnknownSource) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if err != nil {
		s.log.Printf("%s: %v", r.URL.Path[len(base):], err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(body)
}

func (s *server) oldest(name string) (*string, error) {
	if strings.HasPrefix(name, "codex-") {
		return s.codex.oldest(name)
	}
	return s.cursor.oldest(name)
}

func (s *server) rows(name, ts, id string, limit int) ([]Row, error) {
	if strings.HasPrefix(name, "codex-") {
		return s.codex.rows(name, ts, id, limit)
	}
	return s.cursor.rows(name, ts, id, limit)
}

// an agent exe is ~12 MB; cap the upload well above that and never near memory
const maxUpdateBytes = 64 << 20

// handleUpdate receives a new agent exe from the dashboard, checks it against the SHA-256 the (signed) request
// names, and hands it to the platform swap. On Windows the swap is done by a one-shot Scheduled Task that
// stops the service, copies the file into place and starts it again; this agent never runs the new exe itself.
func (s *server) handleUpdate(w http.ResponseWriter, r *http.Request, wantSHA string) {
	if len(wantSHA) != 64 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxUpdateBytes+1))
	if err != nil || len(body) == 0 || len(body) > maxUpdateBytes {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	sum := sha256.Sum256(body)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), wantSHA) {
		s.log.Printf("update refused: sha-256 does not match")
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if len(body) < 2 || body[0] != 'M' || body[1] != 'Z' { // a Windows exe begins with "MZ"
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if err := s.stage(body); err != nil {
		s.log.Printf("update failed to stage: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	s.log.Printf("update staged (%d bytes); the service will be restarted to apply it", len(body))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "restarting": true, "version": version})
}

// handleStop asks Windows to stop the PD Agent service (Scheduled Task + sc stop), then answers so the
// dashboard can hang up before the listener goes down. Recovery does not bounce a clean sc stop.
func (s *server) handleStop(w http.ResponseWriter) {
	if err := s.halt(); err != nil {
		s.log.Printf("stop failed: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	s.log.Printf("stop scheduled; Windows will set the service to Stopped")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "stopping": true, "version": version})
}

// the staged exe (a data file, never named *.exe so it is not treated as runnable) and the one-shot
// Scheduled Task that performs the swap
const (
	updatePkgSuffix = ".pkg"
	updateTaskName  = "PDAgentUpdate"
	updateScript    = "pd-update.cmd"
	stopTaskName    = "PDAgentStop"
	stopScript      = "pd-stop.cmd"
)

// applyUpdateAt writes the new bytes next to the running exe and asks the platform to swap them in. The agent
// only ever writes a data file; a Windows-signed tool (cmd via a Scheduled Task) does the copy and the restart.
func applyUpdateAt(exe string, body []byte, schedule func(exe, pkg string) error) error {
	pkg := exe + updatePkgSuffix
	if err := os.WriteFile(pkg, body, 0o644); err != nil {
		return err
	}
	if err := schedule(exe, pkg); err != nil {
		_ = os.Remove(pkg)
		return err
	}
	return nil
}

// serve runs until ctx is cancelled.
func serve(ctx context.Context, cfg *Config, dir string, logger *log.Logger) error {
	cert, err := tls.LoadX509KeyPair(filepath.Join(dir, certFile), filepath.Join(dir, keyFile))
	if err != nil {
		return err
	}
	allow, err := parseAllow(cfg.Allow)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", ":"+strconv.Itoa(cfg.Port))
	if err != nil {
		return err
	}
	al := &allowListener{Listener: ln, allow: allow, log: logger, last: map[string]time.Time{}}
	tl := tls.NewListener(al, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13})
	h := newServer(cfg, logger)
	h.cursor.stateDir = dir // the index (turn lists, never text) lives next to the config so a restart is cheap
	h.codex.stateDir = dir
	cleanupUpdateArtifacts() // drop the staged file and task left by a previous update
	srv := &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		// the update push uploads the whole exe, so the body read gets the generous timeout, not 10s
		ReadTimeout:    2 * time.Minute,
		WriteTimeout:   2 * time.Minute,
		IdleTimeout:    30 * time.Second,
		MaxHeaderBytes: 8 << 10,
		ErrorLog:       log.New(discard{}, "", 0), // TLS noise from probes
	}
	go func() {
		<-ctx.Done()
		sc, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sc)
	}()
	logger.Printf("listening on port %d for %s", cfg.Port, strings.Join(cfg.Allow, ", "))
	if err := srv.Serve(tl); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// a normal dashboard pull finishes in well under this; past it the handler is stuck (usually Cursor sqlite).
var hungLimit = 3 * time.Minute

// swapped in tests; os.Exit in production so the service recovery policy can start a fresh process.
var exitNow = os.Exit

func watchHung(log *log.Logger, done <-chan struct{}) {
	t := time.NewTimer(hungLimit)
	defer t.Stop()
	select {
	case <-done:
	case <-t.C:
		log.Printf("a dashboard read ran too long; exiting so Windows restarts the service")
		exitNow(1)
	}
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }
