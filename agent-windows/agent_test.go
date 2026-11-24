package main

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------- a Cursor profile on disk ----------

type fakeCursor struct {
	t  *testing.T
	db *sql.DB
}

func newProfile(t *testing.T, users string, user string) *fakeCursor {
	f := filepath.Join(users, user, cursorDB)
	if err := os.MkdirAll(filepath.Dir(f), 0o700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(f))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`); err != nil {
		t.Fatal(err)
	}
	return &fakeCursor{t, db}
}

func (c *fakeCursor) put(key string, v any) {
	raw, ok := v.([]byte)
	if !ok {
		raw, _ = json.Marshal(v)
	}
	if _, err := c.db.Exec(`INSERT INTO cursorDiskKV VALUES (?, ?)`, key, raw); err != nil {
		c.t.Fatal(err)
	}
}

// blob stores a message the way current Cursor does and returns its 32-byte id.
func (c *fakeCursor) blob(m any) []byte {
	raw, _ := json.Marshal(m)
	id := sha256.Sum256(raw)
	c.put("agentKv:blob:"+hex.EncodeToString(id[:]), raw)
	return id[:]
}

// state: protobuf with field 1 = each message id, plus an unrelated varint field.
func state(ids ...[]byte) string {
	var b []byte
	for _, id := range ids {
		b = append(b, 0x0a, 32)
		b = append(b, id...)
	}
	b = append(b, 0x50, 0x01) // field 10 = 1
	return "~" + base64.StdEncoding.EncodeToString(b)
}

func ms(t time.Time) float64 { return float64(t.UnixMilli()) }

func TestSourcesDoesNotReopenCursorWhileWalGrows(t *testing.T) {
	users := t.TempDir()
	c := newProfile(t, users, "A.User")
	id := c.blob(map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "<user_query>hi</user_query>"}}})
	c.put("composerData:chat-1", map[string]any{
		"composerId": "chat-1", "lastUpdatedAt": ms(time.Now()), "conversationState": state(id),
	})
	st := newCursorStore(users, 90*time.Second)
	if _, err := st.sources(); err != nil {
		t.Fatal(err)
	}
	st.mu.Lock()
	parses := 0
	for _, ix := range st.idx {
		parses = ix.parses
	}
	st.mu.Unlock()
	if parses == 0 {
		t.Fatal("first sources() should build the index")
	}
	wal := filepath.Join(users, "A.User", cursorDB+"-wal")
	if err := os.WriteFile(wal, []byte("grown"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := st.sources(); err != nil {
		t.Fatal(err)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, ix := range st.idx {
		if ix.parses != parses {
			t.Fatalf("heartbeat reopened Cursor's database: parses %d -> %d", parses, ix.parses)
		}
	}
}

func TestCursorChatsBecomeTurns(t *testing.T) {
	users := t.TempDir()
	c := newProfile(t, users, "P.Ng")
	now := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
	ids := [][]byte{
		c.blob(map[string]any{"role": "system", "content": "You are an AI coding assistant"}),
		c.blob(map[string]any{"role": "user", "content": "<user_info>OS: win32, workspace C:\\Users\\P.Ng\\repo</user_info>"}),
		c.blob(map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "<timestamp>Wednesday, Nov 11, 2026, 11:30 AM (UTC+3:30)</timestamp>\n<user_query>\nچرا تست خطا می‌ده؟\n</user_query>"}}}),
		c.blob(map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "reasoning", "text": "look at the test"},
			map[string]any{"type": "tool-call", "toolCallId": "t1", "toolName": "run_terminal_cmd", "args": map[string]any{"command": "go test"}},
		}}),
		c.blob(map[string]any{"role": "tool", "content": []any{map[string]any{"type": "tool-result", "toolCallId": "t1", "toolName": "run_terminal_cmd", "result": strings.Repeat("FAIL ", 20000)}}}),
		c.blob(map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "the clock was wrong"}}}),
		c.blob(map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "<timestamp>Wednesday, Nov 11, 2026, 11:40 AM (UTC+3:30)</timestamp><user_query>ok</user_query>"}}}),
		c.blob(map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "done"}}}),
	}
	c.put("composerData:chat-1", map[string]any{
		"composerId": "chat-1", "createdAt": ms(now.Add(-time.Hour)), "lastUpdatedAt": ms(now.Add(-10 * time.Minute)),
		"conversationState": state(ids...), "modelConfig": map[string]any{"modelName": "claude-opus-5-5"},
	})
	// a chat still answering: its last turn waits
	busy := c.blob(map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "<user_query>still running</user_query>"}}})
	c.put("composerData:chat-2", map[string]any{"composerId": "chat-2", "lastUpdatedAt": ms(now.Add(-5 * time.Second)), "conversationState": state(busy)})
	// an empty draft
	c.put("composerData:chat-3", map[string]any{"composerId": "chat-3", "lastUpdatedAt": ms(now)})

	st := newCursorStore(users, 90*time.Second)
	st.now = func() time.Time { return now }
	src, _ := st.sources()
	list := src["sources"].([]sourceInfo)
	if len(list) != 1 || list[0].Name != "cursor-p.ng" || list[0].Chats != 1 {
		t.Fatalf("sources: %+v", list)
	}
	rows, err := st.rows("cursor-p.ng", "", "", 50)
	if err != nil || len(rows) != 2 {
		t.Fatalf("rows: %v %d", err, len(rows))
	}
	// turn 1 dated by its <timestamp> (11:30 Tehran = 08:00 UTC); the last turn by the chat's last activity
	if rows[0].Timestamp != "2026-11-11T08:00:00.000Z" || rows[1].Timestamp != "2026-11-11T08:50:00.000Z" {
		t.Fatalf("timestamps: %s %s", rows[0].Timestamp, rows[1].Timestamp)
	}
	var d struct {
		Client  string `json:"client"`
		Request struct {
			System   string `json:"system"`
			Metadata struct {
				UserID string `json:"user_id"`
			} `json:"metadata"`
			Messages []struct {
				Role    string           `json:"role"`
				Content []map[string]any `json:"content"`
			} `json:"messages"`
		} `json:"request"`
	}
	if err := json.Unmarshal([]byte(rows[0].Data), &d); err != nil {
		t.Fatal(err)
	}
	if d.Client != "cursor" || !strings.Contains(d.Request.System, `\Users\P.Ng\`) || !strings.Contains(d.Request.Metadata.UserID, `"session_id":"chat-1"`) {
		t.Fatalf("meta: %+v", d)
	}
	// system prompt left out; context as a reminder; the typed text alone; tool output whole
	m := d.Request.Messages
	if len(m) != 5 {
		t.Fatalf("turn 1 has %d messages", len(m))
	}
	if txt := m[0].Content[0]["text"].(string); !strings.HasPrefix(txt, "<system-reminder><user_info>") {
		t.Fatalf("context: %q", txt)
	}
	if txt := m[1].Content[0]["text"].(string); !strings.HasSuffix(txt, "</system-reminder>\nچرا تست خطا می‌ده؟") {
		t.Fatalf("prompt: %q", txt)
	}
	if m[2].Content[0]["type"] != "thinking" || m[2].Content[1]["type"] != "tool_use" || m[2].Content[1]["input"].(map[string]any)["command"] != "go test" {
		t.Fatalf("assistant: %+v", m[2].Content)
	}
	if r := m[3].Content[0]; r["type"] != "tool_result" || len(r["content"].(string)) != 100000 {
		t.Fatal("tool result was cut")
	}
	if rows[1].ID != "cursor:chat-1:1" {
		t.Fatalf("ids: %s", rows[1].ID)
	}
	// estimated tokens: Cursor keeps none, so the row carries a size estimate of its own turn
	var tk struct {
		Tokens struct {
			In        int  `json:"input_tokens"`
			Out       int  `json:"output_tokens"`
			Estimated bool `json:"estimated"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal([]byte(rows[0].Data), &tk); err != nil {
		t.Fatal(err)
	}
	if !tk.Tokens.Estimated || tk.Tokens.In == 0 || tk.Tokens.Out == 0 {
		t.Fatalf("tokens: %+v", tk.Tokens)
	}
	// paging: strictly after (ts, id)
	if more, _ := st.rows("cursor-p.ng", rows[0].Timestamp, rows[0].ID, 50); len(more) != 1 || more[0].ID != rows[1].ID {
		t.Fatalf("paging: %+v", more)
	}
	if _, err := st.rows("cursor-..\\..\\windows", "", "", 5); err != errUnknownSource {
		t.Fatal("unknown source accepted")
	}
}

func TestOlderCursorBubbles(t *testing.T) {
	users := t.TempDir()
	c := newProfile(t, users, "old")
	c.put("composerData:b1", map[string]any{"composerId": "b1", "lastUpdatedAt": 1, "fullConversationHeadersOnly": []any{map[string]any{"bubbleId": "u1"}, map[string]any{"bubbleId": "a1"}}})
	c.put("bubbleId:b1:u1", map[string]any{"bubbleId": "u1", "type": 1, "text": "hello", "createdAt": "2026-11-01T10:00:00.000Z"})
	c.put("bubbleId:b1:a1", map[string]any{"bubbleId": "a1", "type": 2, "text": "hi", "thinking": map[string]any{"text": "hmm"},
		"toolFormerData": map[string]any{"toolCallId": "x", "name": "read_file", "rawArgs": `{"path":"a.go"}`, "result": "package a"}})
	st := newCursorStore(users, time.Second)
	rows, err := st.rows("cursor-old", "", "", 10)
	if err != nil || len(rows) != 1 {
		t.Fatalf("%v %d", err, len(rows))
	}
	for _, want := range []string{`"text":"hello"`, `"thinking":"hmm"`, `"name":"read_file"`, `"path":"a.go"`, `"content":"package a"`} {
		if !strings.Contains(rows[0].Data, want) {
			t.Fatalf("missing %s", want)
		}
	}
}

// TestIndexAvoidsRework: an unchanged database is never reopened, a change reparses only the chat that moved,
// and a fresh process loads the turn list from disk instead of parsing every chat again.
func TestIndexAvoidsRework(t *testing.T) {
	users := t.TempDir()
	c := newProfile(t, users, "lite")
	mk := func(id string, upd time.Time, text string) {
		u := c.blob(map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "<user_query>" + text + "</user_query>"}}})
		a := c.blob(map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "ok"}}})
		c.put("composerData:"+id, map[string]any{"composerId": id, "lastUpdatedAt": ms(upd), "conversationState": state(u, a)})
	}
	base := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	mk("chat-1", base, "one")
	mk("chat-2", base, "two")

	stDir := t.TempDir()
	now := base.Add(time.Hour)
	st := newCursorStore(users, time.Second)
	st.stateDir = stDir
	st.now = func() time.Time { return now }
	db := st.profiles()[0].db

	if _, err := st.rows("cursor-lite", "", "", 50); err != nil {
		t.Fatal(err)
	}
	if n := st.idx[db].parses; n != 2 {
		t.Fatalf("first build parsed %d chats, want 2", n)
	}
	if _, err := st.rows("cursor-lite", "", "", 50); err != nil {
		t.Fatal(err)
	}
	if n := st.idx[db].parses; n != 2 {
		t.Fatalf("unchanged database reparsed: %d", n)
	}
	mk("chat-1", now.Add(-time.Minute), "one again")
	if _, err := st.rows("cursor-lite", "", "", 50); err != nil {
		t.Fatal(err)
	}
	if n := st.idx[db].parses; n != 3 {
		t.Fatalf("one chat changed but total parses is %d, want 3", n)
	}

	st2 := newCursorStore(users, time.Second)
	st2.stateDir = stDir
	st2.now = func() time.Time { return now }
	rows, err := st2.rows("cursor-lite", "", "", 50)
	if err != nil || len(rows) != 2 {
		t.Fatalf("reload: %v %d", err, len(rows))
	}
	if n := st2.idx[db].parses; n != 0 {
		t.Fatalf("fresh process reparsed %d chats, want 0", n)
	}
}

func TestParseCursorTime(t *testing.T) {
	for in, want := range map[string]string{
		"Sunday, Nov 1, 2026, 8:48 PM (UTC+4)":         "2026-11-01T16:48:00Z",
		"Wednesday, Nov 11, 2026, 11:30 AM (UTC+3:30)": "2026-11-11T08:00:00Z",
		"Monday, Nov 2, 2026, 1:05 AM (UTC-5)":         "2026-11-02T06:05:00Z",
	} {
		if got := parseCursorTime(in).UTC().Format(time.RFC3339); got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
	}
	if !parseCursorTime("garbage").IsZero() {
		t.Error("garbage parsed")
	}
}

// ---------- security ----------

const testSecret = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

func signed(path, query string, at time.Time, nonce string) *http.Request {
	r := httptest.NewRequest("GET", path+"?"+query, nil)
	key, _ := hex.DecodeString(testSecret)
	t := strconv.FormatInt(at.Unix(), 10)
	r.Header.Set("Authorization", "Signature t="+t+",n="+nonce+",s="+sign(key, "GET", path, query, t, nonce))
	return r
}

func TestSignatures(t *testing.T) {
	v := newVerifier(testSecret)
	now := time.Now()
	if err := v.check(signed("/p/v1/sources", "", now, "0123456789abcdef01"), now); err != nil {
		t.Fatal(err)
	}
	if v.check(signed("/p/v1/sources", "", now, "0123456789abcdef01"), now) == nil {
		t.Error("replay accepted")
	}
	if v.check(signed("/p/v1/sources", "", now.Add(-3*time.Minute), "aaaaaaaaaaaaaaaaaa"), now) == nil {
		t.Error("old signature accepted")
	}
	r := signed("/p/v1/rows", "source=a", now, "bbbbbbbbbbbbbbbbbb")
	r.URL.RawQuery = "source=b" // the query is part of what is signed
	if v.check(r, now) == nil {
		t.Error("changed query accepted")
	}
	if v.check(httptest.NewRequest("GET", "/p/v1/sources", nil), now) == nil {
		t.Error("unsigned accepted")
	}
}

func TestEverythingElseIsAnEmpty404(t *testing.T) {
	cfg := &Config{Port: 40000, Prefix: "abcdefghijklmnopqrstuvwx", Secret: testSecret, Allow: []string{"127.0.0.1"}, ProfilesDir: t.TempDir()}
	s := newServer(cfg, log.New(io.Discard, "", 0))
	for _, r := range []*http.Request{
		httptest.NewRequest("GET", "/", nil),
		httptest.NewRequest("GET", "/agent/v1/sources", nil),
		httptest.NewRequest("GET", "/abcdefghijklmnopqrstuvwx/v1/sources", nil),
		httptest.NewRequest("POST", "/abcdefghijklmnopqrstuvwx/v1/sources", nil),
		signed("/abcdefghijklmnopqrstuvwx/v1/nope", "", time.Now(), "cccccccccccccccccc"),
	} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 404 || w.Body.Len() != 0 || w.Header().Get("Server") != "" {
			t.Errorf("%s %s: %d %q", r.Method, r.URL, w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, signed("/abcdefghijklmnopqrstuvwx/v1/sources", "", time.Now(), "dddddddddddddddddd"))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"sources":[]`) {
		t.Errorf("signed request: %d %s", w.Code, w.Body.String())
	}
}

func signedBody(path, query string, body []byte, at time.Time, nonce string) *http.Request {
	r := httptest.NewRequest("POST", path+"?"+query, bytes.NewReader(body))
	key, _ := hex.DecodeString(testSecret)
	t := strconv.FormatInt(at.Unix(), 10)
	r.Header.Set("Authorization", "Signature t="+t+",n="+nonce+",s="+sign(key, "POST", path, query, t, nonce))
	return r
}

func TestApplyUpdateStagesAndSchedules(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "pd-agent.exe")
	if err := os.WriteFile(exe, []byte("MZ-old-version"), 0o755); err != nil {
		t.Fatal(err)
	}
	var gotExe, gotPkg string
	err := applyUpdateAt(exe, []byte("MZ-new-version"), func(e, pkg string) error {
		gotExe, gotPkg = e, pkg
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// the running exe is left untouched; the new bytes are staged beside it as a data file (not *.exe)
	if b, _ := os.ReadFile(exe); string(b) != "MZ-old-version" {
		t.Fatalf("running exe must not be overwritten by the agent: %q", b)
	}
	if b, _ := os.ReadFile(exe + updatePkgSuffix); string(b) != "MZ-new-version" {
		t.Fatalf("new bytes not staged: %q", b)
	}
	if gotExe != exe || gotPkg != exe+updatePkgSuffix {
		t.Fatalf("schedule got %q %q", gotExe, gotPkg)
	}

	// if scheduling the swap fails, the staged file is cleaned up so nothing is left half-done
	if err := applyUpdateAt(exe, []byte("MZ-newer"), func(string, string) error { return errUnknownSource }); err == nil {
		t.Fatal("expected the schedule error to propagate")
	}
	if _, err := os.Stat(exe + updatePkgSuffix); !os.IsNotExist(err) {
		t.Fatalf("staged file should be removed on failure: %v", err)
	}
}

func TestUpdatePushAppliesAndRestarts(t *testing.T) {
	cfg := &Config{Port: 40000, Prefix: "abcdefghijklmnopqrstuvwx", Secret: testSecret, Allow: []string{"127.0.0.1"}, ProfilesDir: t.TempDir()}
	s := newServer(cfg, log.New(io.Discard, "", 0))
	var got []byte
	s.stage = func(b []byte) error { got = b; return nil }
	base := "/abcdefghijklmnopqrstuvwx/v1/update"
	exe := []byte("MZthis-is-a-new-agent")
	sum := sha256.Sum256(exe)
	h := hex.EncodeToString(sum[:])

	// right sha, right signature: handed to the swap, 200
	w := httptest.NewRecorder()
	s.ServeHTTP(w, signedBody(base, "h="+h, exe, time.Now(), "ee11ee11ee11ee11ee"))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"restarting":true`) {
		t.Fatalf("apply: %d %s", w.Code, w.Body.String())
	}
	if string(got) != string(exe) {
		t.Fatalf("staged bytes: %q", got)
	}

	// wrong sha: refused, nothing staged
	got = nil
	bad := sha256.Sum256([]byte("something else"))
	w = httptest.NewRecorder()
	s.ServeHTTP(w, signedBody(base, "h="+hex.EncodeToString(bad[:]), exe, time.Now(), "ff22ff22ff22ff22ff"))
	if w.Code != 400 || got != nil {
		t.Fatalf("sha mismatch should be refused: %d staged=%q", w.Code, got)
	}

	// a GET to the update path is just a 404, like any wrong method
	w = httptest.NewRecorder()
	s.ServeHTTP(w, signed(base, "h="+h, time.Now(), "aa33aa33aa33aa33aa"))
	if w.Code != 404 {
		t.Fatalf("GET on update: %d", w.Code)
	}
}

func TestStopPushSchedulesHalt(t *testing.T) {
	cfg := &Config{Port: 40000, Prefix: "abcdefghijklmnopqrstuvwx", Secret: testSecret, Allow: []string{"127.0.0.1"}, ProfilesDir: t.TempDir()}
	s := newServer(cfg, log.New(io.Discard, "", 0))
	called := false
	s.halt = func() error { called = true; return nil }
	base := "/abcdefghijklmnopqrstuvwx/v1/stop"
	w := httptest.NewRecorder()
	s.ServeHTTP(w, signedBody(base, "", nil, time.Now(), "ff44ff44ff44ff44ff"))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"stopping":true`) || !called {
		t.Fatalf("stop: %d %s called=%v", w.Code, w.Body.String(), called)
	}
	w = httptest.NewRecorder()
	s.ServeHTTP(w, signed(base, "", time.Now(), "aa55aa55aa55aa55aa"))
	if w.Code != 404 {
		t.Fatalf("GET on stop: %d", w.Code)
	}
}

func TestWatchHungExitsWhenAReadStalls(t *testing.T) {
	oldLimit, oldExit := hungLimit, exitNow
	defer func() { hungLimit, exitNow = oldLimit, oldExit }()
	hungLimit = 20 * time.Millisecond
	code := -1
	exitNow = func(c int) { code = c }
	watchHung(log.New(io.Discard, "", 0), make(chan struct{}))
	if code != 1 {
		t.Fatalf("stuck read should exit 1, got %d", code)
	}
}

func TestWatchHungStopsWhenTheReadFinishes(t *testing.T) {
	oldLimit, oldExit := hungLimit, exitNow
	defer func() { hungLimit, exitNow = oldLimit, oldExit }()
	hungLimit = time.Second
	code := -1
	exitNow = func(c int) { code = c }
	done := make(chan struct{})
	go watchHung(log.New(io.Discard, "", 0), done)
	close(done)
	time.Sleep(30 * time.Millisecond)
	if code != -1 {
		t.Fatalf("a finished read must not restart the service, got %d", code)
	}
}

func TestOnlyAllowedAddressesConnect(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	allow, _ := parseAllow([]string{"10.1.2.3"})
	al := &allowListener{Listener: ln, allow: allow, log: log.New(io.Discard, "", 0), last: map[string]time.Time{}}
	defer al.Close()
	go func() { _, _ = al.Accept() }()
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if n, err := c.Read(make([]byte, 1)); n != 0 || err == nil || strings.Contains(err.Error(), "timeout") {
		t.Fatalf("connection from a foreign address was not dropped: %d %v", n, err)
	}
}

func TestConfig(t *testing.T) {
	dir := t.TempDir()
	cfg, err := newConfig(dir, []string{"10.1.2.10"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port < 40000 || cfg.Port >= 60000 || len(cfg.Prefix) < 20 || len(cfg.Secret) != 64 {
		t.Fatalf("%+v", cfg)
	}
	code, err := pairingCode(cfg, dir)
	if err != nil || !strings.HasPrefix(code, "pda1.") {
		t.Fatal(code, err)
	}
	raw, _ := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(code, "pda1."))
	var p map[string]any
	_ = json.Unmarshal(raw, &p)
	fp, _ := certFingerprint(dir)
	if p["cert"] != fp || p["secret"] != cfg.Secret || p["prefix"] != cfg.Prefix {
		t.Fatalf("pairing: %v", p)
	}
	for _, bad := range [][]string{{}, {"not-an-ip"}} {
		if _, err := newConfig(t.TempDir(), bad, 0); err == nil {
			t.Errorf("allow %v accepted", bad)
		}
	}
}
