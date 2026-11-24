package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Row is what the dashboard ingests: the shape of a 9router requestDetails row. One row per chat turn (a prompt
// of the person and everything Cursor did for it), carrying the whole chat up to the end of that turn.
type Row struct {
	ID           string  `json:"id"`
	Timestamp    string  `json:"timestamp"`
	Provider     string  `json:"provider"`
	Model        string  `json:"model"`
	ConnectionID *string `json:"connectionId"`
	Status       string  `json:"status"`
	Data         string  `json:"data"`
}

var errUnknownSource = errors.New("unknown source")

// Where Cursor keeps every chat of a Windows profile.
var cursorDB = filepath.Join("AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb")

var skipProfiles = map[string]bool{"public": true, "default": true, "default user": true, "all users": true}

type cursorStore struct {
	profilesDir string
	// also the profiles Windows has registered elsewhere (only for the real C:\Users, not in tests)
	registry bool
	settle   time.Duration
	now      func() time.Time
	host     string
	// where each database's index survives a restart; empty keeps it in memory only
	stateDir string
	mu       sync.Mutex
	idx      map[string]*dbIndex
}

// dbIndex: the turns of one Cursor database, without their text. Text is read only for the rows of a page.
type dbIndex struct {
	Stamp   fileStamp            `json:"stamp"`
	Chats   map[string]chatIndex `json:"chats"`
	Email   string               `json:"email,omitempty"`
	Plan    string               `json:"plan,omitempty"`
	built   bool                 // whether this process has reconciled the index at least once
	recheck time.Time            // when a chat still answering may have settled; zero when none is
	rows    []rowMeta            // every chat's rows, sorted by (Timestamp, ID)
	parses  int                  // chats parsed since start, for the test
}

// fileStamp: how to tell a database changed without opening it. Times are unix nanoseconds so the whole stamp
// compares with == and survives a JSON round trip.
type fileStamp struct {
	Size    int64 `json:"size"`
	WalSize int64 `json:"walSize"`
	Mod     int64 `json:"mod"`
	WalMod  int64 `json:"walMod"`
}

type chatIndex struct {
	FP      string    `json:"fp"` // lastUpdatedAt:length, so a changed chat is reparsed and a settled one is not
	Settled bool      `json:"settled"`
	Rows    []rowMeta `json:"rows"`
}

type rowMeta struct {
	ID        string `json:"id"`
	Timestamp string `json:"ts"`
	Model     string `json:"model"`
	Chat      string `json:"chat"`
	End       int    `json:"end"` // messages up to and including this turn, for slicing when the page is built
	// Cursor stores no real token usage, so these are estimates of this turn's own new text (~4 chars/token):
	// input = what the person and tools added, output = what the model produced. Additive across turns.
	In  int `json:"in"`
	Out int `json:"out"`
	// Codex fills these from token_count; Cursor leaves them zero / estimated.
	Cache int  `json:"cache,omitempty"`
	Real  bool `json:"real,omitempty"`
}

// pageBytes bounds one rows answer; a page always carries at least one row.
const pageBytes = 24 << 20

func newCursorStore(profilesDir string, settle time.Duration) *cursorStore {
	host, _ := os.Hostname()
	return &cursorStore{
		profilesDir: profilesDir,
		registry:    strings.EqualFold(filepath.Clean(profilesDir), filepath.Clean(defaultProfilesDir())),
		settle:      settle,
		now:         time.Now,
		host:        host,
		idx:         map[string]*dbIndex{},
	}
}

var nameBad = regexp.MustCompile(`[^a-z0-9._-]+`)

func sourceName(profile string) string {
	n := strings.Trim(nameBad.ReplaceAllString(strings.ToLower(profile), "-"), "-.")
	if len(n) > 50 {
		n = n[:50]
	}
	return "cursor-" + n
}

// profile: one Windows profile that has Cursor. account is DOMAIN\user when Windows knows it.
type profile struct{ name, user, account, db string }

// osProfile: a profile folder, from C:\Users or from Windows' own profile list.
type osProfile struct{ dir, account string }

// profiles: every profile folder under C:\Users, plus every profile Windows has registered anywhere else
// (another drive, a renamed folder). Only those with a Cursor database count.
func (s *cursorStore) profiles() []profile {
	var all []osProfile
	if s.registry {
		all = registeredProfiles()
	}
	entries, _ := os.ReadDir(s.profilesDir)
	for _, e := range entries {
		if e.IsDir() {
			all = append(all, osProfile{dir: filepath.Join(s.profilesDir, e.Name())})
		}
	}
	var out []profile
	seen := map[string]bool{}
	for _, o := range all {
		user := filepath.Base(o.dir)
		name := sourceName(user)
		if skipProfiles[strings.ToLower(user)] || seen[name] {
			continue
		}
		f := filepath.Join(o.dir, cursorDB)
		if st, err := os.Stat(f); err == nil && !st.IsDir() {
			seen[name] = true
			out = append(out, profile{name: name, user: user, account: o.account, db: f})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func (s *cursorStore) find(name string) (profile, error) {
	for _, p := range s.profiles() {
		if p.name == name {
			return p, nil
		}
	}
	return profile{}, errUnknownSource
}

// sourceInfo: who a profile is, for the dashboard's list of PCs. Never any chat text.
type sourceInfo struct {
	Name    string `json:"name"`
	Profile string `json:"profile"`
	Kind    string `json:"kind,omitempty"` // "cursor" or "codex"
	// DOMAIN\user of the Windows account
	Account string `json:"account,omitempty"`
	// the Cursor account signed in on this profile, and its plan
	Email   string `json:"email,omitempty"`
	Plan    string `json:"plan,omitempty"`
	Chats   int    `json:"chats"`
	LastUse string `json:"last_used,omitempty"`
	Error   string `json:"error,omitempty"`
}

// agentInfo: which PC this is.
type agentInfo struct {
	Host    string `json:"host"`
	Version string `json:"version"`
}

// cursorAccount reads only these two keys of Cursor's settings; the login tokens next to them are never read.
func cursorAccount(db *sql.DB) (email, plan string) {
	q, err := db.Query(`SELECT key, CAST(value AS TEXT) FROM ItemTable WHERE key IN ('cursorAuth/cachedEmail', 'cursorAuth/stripeMembershipType')`)
	if err != nil {
		return "", ""
	}
	defer q.Close()
	for q.Next() {
		var k, v string
		if q.Scan(&k, &v) != nil {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) > 200 {
			v = v[:200]
		}
		if k == "cursorAuth/cachedEmail" {
			email = v
		} else {
			plan = v
		}
	}
	return email, plan
}

func (s *cursorStore) sources() (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []sourceInfo{}
	for _, p := range s.profiles() {
		info := sourceInfo{Name: p.name, Profile: p.user, Kind: "cursor", Account: p.account}
		// last use is the file clock only — Stat does not keep a handle
		var last time.Time
		for _, f := range []string{p.db, p.db + "-wal"} {
			if st, err := os.Stat(f); err == nil && st.ModTime().After(last) {
				last = st.ModTime()
			}
		}
		if !last.IsZero() {
			info.LastUse = iso(last)
		}
		ix := s.idx[p.db]
		if ix == nil {
			ix = s.loadIndex(p.db)
			s.idx[p.db] = ix
		}
		// first answer may build the index; later "are you up?" checks must not reopen
		// Cursor's 200 MB database. Cursor writes the -wal file continuously while it
		// is running, so treating that as "changed" used to open sqlite every minute
		// and the updater then saw the files as in use.
		if !ix.built {
			var err error
			ix, err = s.index(p)
			if err != nil {
				info.Error = err.Error()
			}
		}
		if ix != nil {
			info.Email, info.Plan = ix.Email, ix.Plan
			for _, ch := range ix.Chats {
				if len(ch.Rows) > 0 {
					info.Chats++
				}
			}
		}
		out = append(out, info)
	}
	return map[string]any{"sources": out, "agent": agentInfo{Host: s.host, Version: version}}, nil
}

func (s *cursorStore) oldest(name string) (*string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.find(name)
	if err != nil {
		return nil, err
	}
	ix, err := s.index(p)
	if err != nil || len(ix.rows) == 0 {
		return nil, err
	}
	return &ix.rows[0].Timestamp, nil
}

// rows: the rows strictly after (ts, id) in (timestamp, id) order, as the dashboard pages through them.
// Only the chats of this page are read for their text.
func (s *cursorStore) rows(name, ts, id string, limit int) ([]Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.find(name)
	if err != nil {
		return nil, err
	}
	ix, err := s.index(p)
	if err != nil {
		return nil, err
	}
	i := sort.Search(len(ix.rows), func(i int) bool {
		r := ix.rows[i]
		return r.Timestamp > ts || (r.Timestamp == ts && r.ID > id)
	})
	page := ix.rows[i:]
	if len(page) > limit {
		page = page[:limit]
	}
	if len(page) == 0 {
		return []Row{}, nil
	}
	return s.build(p, page)
}

func stampOf(file string) fileStamp {
	var st fileStamp
	if fi, err := os.Stat(file); err == nil {
		st.Size, st.Mod = fi.Size(), fi.ModTime().UnixNano()
	}
	if fi, err := os.Stat(file + "-wal"); err == nil {
		st.WalSize, st.WalMod = fi.Size(), fi.ModTime().UnixNano()
	}
	return st
}

// index brings a database's turn list up to date. Nothing is opened while neither the database nor its -wal
// changed and no chat waits to settle; otherwise only chats whose lastUpdatedAt or size changed are parsed.
// The turn list (ids, times, model, message counts), but never the text, is kept on disk so a restart does
// not reparse chats that have not changed.
func (s *cursorStore) index(p profile) (*dbIndex, error) {
	ix := s.idx[p.db]
	if ix == nil {
		ix = s.loadIndex(p.db)
		s.idx[p.db] = ix
	}
	stamp := stampOf(p.db)
	now := s.now()
	if ix.built && stamp == ix.Stamp && (ix.recheck.IsZero() || now.Before(ix.recheck)) {
		return ix, nil
	}

	db, cleanup, err := openReadOnly(p.db)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	defer db.Close()
	ix.Email, ix.Plan = cursorAccount(db)
	q, err := db.Query(`SELECT substr(key, 14),
		CASE WHEN json_valid(CAST(value AS TEXT)) THEN json_extract(CAST(value AS TEXT), '$.lastUpdatedAt') END,
		length(value)
		FROM cursorDiskKV WHERE key LIKE 'composerData:%'`)
	if err != nil {
		return nil, fmt.Errorf("unknown Cursor database layout: %w", err)
	}
	type head struct{ id, fp string }
	var heads []head
	for q.Next() {
		var id string
		var upd any
		var n int64
		if err := q.Scan(&id, &upd, &n); err != nil {
			q.Close()
			return nil, err
		}
		heads = append(heads, head{id, fmt.Sprintf("%v:%d", upd, n)})
	}
	q.Close()

	get, err := db.Prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
	if err != nil {
		return nil, err
	}
	defer get.Close()
	chats := map[string]chatIndex{}
	var recheck time.Time
	for _, h := range heads {
		if old, ok := ix.Chats[h.id]; ok && old.Settled && old.FP == h.fp {
			chats[h.id] = old // unchanged and already finished: keep its turns, read nothing
			continue
		}
		var raw []byte
		if get.QueryRow("composerData:"+h.id).Scan(&raw) != nil {
			continue
		}
		var c composer
		if json.Unmarshal(raw, &c) != nil || c.ComposerID == "" {
			continue
		}
		ix.parses++
		metas, settled := s.turns(&c, chatMessages(db, &c))
		if !settled {
			at := time.UnixMilli(int64(c.LastUpdatedAt)).Add(s.settle)
			if !at.After(now) {
				at = now.Add(s.settle)
			}
			if recheck.IsZero() || at.Before(recheck) {
				recheck = at
			}
		}
		chats[h.id] = chatIndex{FP: h.fp, Settled: settled, Rows: metas}
	}

	var rows []rowMeta
	for _, ch := range chats {
		rows = append(rows, ch.Rows...)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Timestamp != rows[j].Timestamp {
			return rows[i].Timestamp < rows[j].Timestamp
		}
		return rows[i].ID < rows[j].ID
	})
	ix.Chats, ix.rows = chats, rows
	ix.Stamp, ix.built, ix.recheck = stamp, true, recheck
	s.saveIndex(p.db, ix)
	return ix, nil
}

// build reads only the chats of a page and returns its rows with their text.
func (s *cursorStore) build(p profile, page []rowMeta) ([]Row, error) {
	db, cleanup, err := openReadOnly(p.db)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	defer db.Close()
	type loaded struct {
		c    composer
		msgs []msg
	}
	chats := map[string]*loaded{}
	out := make([]Row, 0, len(page))
	size := 0
	for _, r := range page {
		l, ok := chats[r.Chat]
		if !ok {
			var raw []byte
			if err := db.QueryRow(`SELECT value FROM cursorDiskKV WHERE key = ?`, "composerData:"+r.Chat).Scan(&raw); err != nil {
				// deleted or compacted since the index was built: skip this turn, do not 500 the whole page
				continue
			}
			l = &loaded{}
			if err := json.Unmarshal(raw, &l.c); err != nil {
				continue
			}
			l.msgs = chatMessages(db, &l.c)
			chats[r.Chat] = l
		}
		row := Row{ID: r.ID, Timestamp: r.Timestamp, Provider: "cursor", Model: r.Model, Status: "success"}
		row.Data = s.rowData(p, &l.c, l.msgs, r)
		if len(out) > 0 && size+len(row.Data) > pageBytes {
			break
		}
		size += len(row.Data)
		out = append(out, row)
	}
	return out, nil
}

// indexVersion guards the on-disk index: a format change here makes old files rebuild instead of mislead.
const indexVersion = 2

func (s *cursorStore) indexFile(db string) string {
	if s.stateDir == "" {
		return ""
	}
	h := sha256.Sum256([]byte(strings.ToLower(db)))
	return filepath.Join(s.stateDir, "index-"+hex.EncodeToString(h[:8])+".json")
}

func (s *cursorStore) loadIndex(db string) *dbIndex {
	fresh := &dbIndex{Chats: map[string]chatIndex{}}
	f := s.indexFile(db)
	if f == "" {
		return fresh
	}
	raw, err := os.ReadFile(f)
	if err != nil {
		return fresh
	}
	var on struct {
		Version int `json:"version"`
		dbIndex
	}
	if json.Unmarshal(raw, &on) != nil || on.Version != indexVersion || on.Chats == nil {
		return fresh
	}
	ix := &on.dbIndex
	ix.built = true // disk index is enough for "are you up?"; do not reopen Cursor on start
	for _, ch := range ix.Chats {
		ix.rows = append(ix.rows, ch.Rows...)
	}
	sort.Slice(ix.rows, func(i, j int) bool {
		if ix.rows[i].Timestamp != ix.rows[j].Timestamp {
			return ix.rows[i].Timestamp < ix.rows[j].Timestamp
		}
		return ix.rows[i].ID < ix.rows[j].ID
	})
	return ix
}

func (s *cursorStore) saveIndex(db string, ix *dbIndex) {
	f := s.indexFile(db)
	if f == "" {
		return
	}
	raw, err := json.Marshal(struct {
		Version int `json:"version"`
		*dbIndex
	}{indexVersion, ix})
	if err != nil {
		return
	}
	tmp := f + ".tmp"
	if os.WriteFile(tmp, raw, 0o600) == nil {
		_ = os.Rename(tmp, f)
	}
}

func openReadOnly(file string) (*sql.DB, func(), error) {
	nop := func() {}
	snap, cleanup, err := snapshotSQLite(file)
	if err == nil {
		db, err := openSQLite(snap, false)
		if err == nil {
			return db, cleanup, nil
		}
		cleanup()
	}
	// live file: nolock so Cursor can keep writing; a torn WAL is why rows() used to 500
	db, err2 := openSQLite(file, true)
	if err2 != nil {
		if err != nil {
			return nil, nop, fmt.Errorf("%v (also live: %w)", err, err2)
		}
		return nil, nop, err2
	}
	return db, nop, nil
}

func openSQLite(file string, nolock bool) (*sql.DB, error) {
	dsn := "file:" + filepath.ToSlash(file) + "?mode=ro&_pragma=busy_timeout(5000)&_pragma=query_only(true)"
	if nolock {
		dsn += "&nolock=1"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

func snapshotSQLite(src string) (string, func(), error) {
	dir, err := os.MkdirTemp("", "pd-c-")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	base := filepath.Join(dir, filepath.Base(src))
	for _, extra := range []string{"", "-wal", "-shm"} {
		from := src + extra
		if _, err := os.Stat(from); err != nil {
			continue
		}
		if err := copyFile(from, base+extra); err != nil {
			cleanup()
			return "", nil, err
		}
	}
	return base, cleanup, nil
}


// ---------- one chat ----------

type composer struct {
	ComposerID          string   `json:"composerId"`
	CreatedAt           float64  `json:"createdAt"`
	LastUpdatedAt       float64  `json:"lastUpdatedAt"`
	ConversationState   string   `json:"conversationState"`
	GeneratingBubbleIDs []string `json:"generatingBubbleIds"`
	ModelConfig         struct {
		ModelName string `json:"modelName"`
	} `json:"modelConfig"`
	FullConversationHeadersOnly []struct {
		BubbleID string `json:"bubbleId"`
	} `json:"fullConversationHeadersOnly"`
	Conversation []json.RawMessage `json:"conversation"` // very old versions: bubbles inline
}

// msg is a message in the Anthropic shape the dashboard already reads.
type msg struct {
	Role    string           `json:"role"`
	Content []map[string]any `json:"content"`
	prompt  bool             // a message the person typed: a turn starts here
	at      time.Time        // when it was typed, if known
}

// chatMessages reads a chat's messages, trying the current conversationState format first and the older
// bubble format when that yields nothing.
func chatMessages(db *sql.DB, c *composer) []msg {
	msgs := agentMessages(db, c.ConversationState)
	if countPrompts(msgs) == 0 {
		msgs = bubbleMessages(db, c)
	}
	return msgs
}

// turns indexes a chat into one row per turn (a prompt and everything Cursor did for it), without text.
// settled is false while the last turn may still be running, in which case that turn is left out until it ends.
// A row id is cursor:{composerId}:{turn}, stable across runs so the dashboard upserts rather than duplicates.
func (s *cursorStore) turns(c *composer, msgs []msg) ([]rowMeta, bool) {
	var starts []int
	for i, m := range msgs {
		if m.prompt {
			starts = append(starts, i)
		}
	}
	if len(starts) == 0 {
		return nil, true
	}
	settled := len(c.GeneratingBubbleIDs) == 0 && s.now().Sub(time.UnixMilli(int64(c.LastUpdatedAt))) >= s.settle
	model := c.ModelConfig.ModelName
	if model == "" || model == "default" {
		model = "cursor-auto"
	}
	var rows []rowMeta
	prev := time.UnixMilli(int64(c.CreatedAt))
	for k, start := range starts {
		end := len(msgs)
		last := k == len(starts)-1
		if !last {
			end = starts[k+1]
		} else if !settled {
			break
		}
		at := msgs[start].at
		if at.IsZero() || at.Before(prev) {
			at = prev
		}
		prev = at
		if last && c.LastUpdatedAt > 0 {
			// the last turn is dated by its last activity, so a turn that goes on later is read again
			if u := time.UnixMilli(int64(c.LastUpdatedAt)); u.After(at) {
				at = u
			}
		}
		in, out := estTurnTokens(msgs[start:end])
		rows = append(rows, rowMeta{
			ID:        fmt.Sprintf("cursor:%s:%d", c.ComposerID, k),
			Timestamp: iso(at),
			Model:     model,
			Chat:      c.ComposerID,
			End:       end,
			In:        in,
			Out:       out,
		})
	}
	return rows, settled
}

// estTurnTokens estimates a turn's tokens from its own new messages: assistant text counts as output, the
// person's and tools' text as input. Cursor keeps no real usage, so this is a size proxy at ~4 characters/token.
func estTurnTokens(msgs []msg) (in, out int) {
	for _, m := range msgs {
		t := estTokens(msgText(m))
		if m.Role == "assistant" {
			out += t
		} else {
			in += t
		}
	}
	return in, out
}

func estTokens(text string) int {
	n := len([]rune(text))
	if n == 0 {
		return 0
	}
	return (n + 3) / 4
}

// msgText joins the text-bearing content of a message (text, thinking, tool-result content); block type names
// and tool ids are left out, and non-string tool inputs are not counted.
func msgText(m msg) string {
	var b strings.Builder
	for _, c := range m.Content {
		for _, k := range []string{"text", "thinking", "content"} {
			if s, ok := c[k].(string); ok && s != "" {
				if b.Len() > 0 {
					b.WriteByte(' ')
				}
				b.WriteString(s)
			}
		}
	}
	return b.String()
}

// rowData builds the row body for one turn: the whole chat up to the end of that turn, in the 9router shape.
func (s *cursorStore) rowData(p profile, c *composer, msgs []msg, r rowMeta) string {
	end := r.End
	if end > len(msgs) {
		end = len(msgs)
	}
	sessionMeta, _ := json.Marshal(map[string]string{"device_id": s.host, "session_id": c.ComposerID})
	// the dashboard reads the person (OS account) from a C:\Users\<name> path, wherever the profiles really are
	system := fmt.Sprintf(`Cursor on %s, Windows profile C:\Users\%s\`, s.host, p.user)
	data, _ := json.Marshal(map[string]any{
		"client":    "cursor",
		"timestamp": r.Timestamp,
		"request": map[string]any{
			"model":    r.Model,
			"system":   system,
			"metadata": map[string]string{"user_id": string(sessionMeta)},
			"messages": msgs[:end],
		},
		"tokens":   map[string]any{"input_tokens": r.In, "output_tokens": r.Out, "estimated": true},
		"response": map[string]any{},
	})
	return string(data)
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func countPrompts(m []msg) int {
	n := 0
	for _, x := range m {
		if x.prompt {
			n++
		}
	}
	return n
}

// ---------- current Cursor: conversationState -> agentKv blobs ----------

// conversationState is "~" + base64 protobuf; its field 1 lists, in order, the SHA-256 ids of the messages,
// each stored as agentKv:blob:<hex> (JSON). A blob that is not JSON is a node with a list of its own.
func agentMessages(db *sql.DB, state string) []msg {
	if !strings.HasPrefix(state, "~") {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(state[1:])
	if err != nil {
		return nil
	}
	get, err := db.Prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
	if err != nil {
		return nil
	}
	defer get.Close()
	var out []msg
	seen := map[string]bool{}
	var walk func(buf []byte, depth int)
	walk = func(buf []byte, depth int) {
		for _, ref := range protoRefs(buf) {
			h := hex.EncodeToString(ref)
			var v []byte
			if get.QueryRow("agentKv:blob:"+h).Scan(&v) != nil {
				continue
			}
			var b blobMsg
			if json.Unmarshal(v, &b) == nil && b.Role != "" {
				if m, ok := b.toMsg(); ok {
					out = append(out, m...)
				}
				continue
			}
			if depth < 3 && !seen[h] {
				seen[h] = true
				walk(v, depth+1)
			}
		}
	}
	walk(raw, 0)
	return out
}

// protoRefs: the 32-byte values of field 1 of a protobuf message, in order.
func protoRefs(b []byte) [][]byte {
	var out [][]byte
	i := 0
	varint := func() (uint64, bool) {
		var v uint64
		for s := uint(0); i < len(b) && s < 64; s += 7 {
			x := b[i]
			i++
			v |= uint64(x&0x7f) << s
			if x < 0x80 {
				return v, true
			}
		}
		return 0, false
	}
	for i < len(b) {
		tag, ok := varint()
		if !ok {
			return out
		}
		switch tag & 7 {
		case 0:
			if _, ok := varint(); !ok {
				return out
			}
		case 1:
			i += 8
		case 2:
			n, ok := varint()
			if !ok || uint64(len(b)-i) < n {
				return out
			}
			if tag>>3 == 1 && n == 32 {
				out = append(out, b[i:i+32])
			}
			i += int(n)
		case 5:
			i += 4
		default:
			return out
		}
	}
	return out
}

type blobMsg struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type part struct {
	Type       string          `json:"type"`
	Text       string          `json:"text"`
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName"`
	Args       json.RawMessage `json:"args"`
	Input      json.RawMessage `json:"input"`
	Result     json.RawMessage `json:"result"`
}

var (
	queryRe = regexp.MustCompile(`(?s)<user_query>\s*(.*?)\s*</user_query>`)
	stampRe = regexp.MustCompile(`<timestamp>([^<]*)</timestamp>`)
)

func (b blobMsg) parts() []part {
	var s string
	if json.Unmarshal(b.Content, &s) == nil {
		return []part{{Type: "text", Text: s}}
	}
	var ps []part
	_ = json.Unmarshal(b.Content, &ps)
	return ps
}

func (b blobMsg) toMsg() ([]msg, bool) {
	switch b.Role {
	case "user":
		var sb strings.Builder
		for _, p := range b.parts() {
			switch p.Type {
			case "text":
				sb.WriteString(p.Text)
			case "image", "file":
				sb.WriteString("[image]")
			}
		}
		return []msg{userText(sb.String())}, true
	case "assistant":
		var content []map[string]any
		for _, p := range b.parts() {
			switch p.Type {
			case "text":
				if strings.TrimSpace(p.Text) != "" {
					content = append(content, map[string]any{"type": "text", "text": p.Text})
				}
			case "reasoning":
				if strings.TrimSpace(p.Text) != "" {
					content = append(content, map[string]any{"type": "thinking", "thinking": p.Text})
				}
			case "tool-call":
				in := p.Args
				if len(in) == 0 {
					in = p.Input
				}
				content = append(content, map[string]any{"type": "tool_use", "id": p.ToolCallID, "name": p.ToolName, "input": jsonOrText(in)})
			}
		}
		if len(content) == 0 {
			return nil, false
		}
		return []msg{{Role: "assistant", Content: content}}, true
	case "tool":
		var content []map[string]any
		for _, p := range b.parts() {
			if p.Type == "tool-result" {
				content = append(content, map[string]any{"type": "tool_result", "tool_use_id": p.ToolCallID, "content": textOf(p.Result)})
			}
		}
		if len(content) == 0 {
			return nil, false
		}
		return []msg{{Role: "user", Content: content}}, true
	}
	return nil, false // system: Cursor's own instructions, as 9router leaves them out too
}

// userText: what the person typed is inside <user_query>; the rest (time, rules, open files, notices) is
// context Cursor adds, shown as a reminder, not as the person's words.
func userText(t string) msg {
	var asked []string
	for _, m := range queryRe.FindAllStringSubmatch(t, -1) {
		asked = append(asked, m[1])
	}
	rest := strings.TrimSpace(queryRe.ReplaceAllString(t, ""))
	text := strings.Join(asked, "\n\n")
	if rest != "" {
		text = "<system-reminder>" + rest + "</system-reminder>\n" + text
	}
	m := msg{Role: "user", Content: []map[string]any{{"type": "text", "text": text}}, prompt: len(asked) > 0}
	if s := stampRe.FindStringSubmatch(rest); s != nil {
		m.at = parseCursorTime(s[1])
	}
	return m
}

// parseCursorTime reads "Sunday, Nov 1, 2026, 8:48 PM (UTC+4)" or "(UTC+3:30)".
func parseCursorTime(s string) time.Time {
	s = strings.TrimSpace(s)
	open := strings.LastIndex(s, "(UTC")
	if open < 0 {
		return time.Time{}
	}
	base, zone := strings.TrimSpace(s[:open]), strings.TrimSuffix(s[open+4:], ")")
	t, err := time.Parse("Monday, Jan 2, 2006, 3:04 PM", base)
	if err != nil {
		return time.Time{}
	}
	off := 0
	if zone != "" {
		sign := 1
		if zone[0] == '-' {
			sign = -1
		}
		h, m, _ := strings.Cut(zone[1:], ":")
		var hh, mm int
		fmt.Sscanf(h, "%d", &hh)
		fmt.Sscanf(m, "%d", &mm)
		off = sign * (hh*3600 + mm*60)
	}
	return t.Add(-time.Duration(off) * time.Second)
}

func jsonOrText(raw json.RawMessage) any {
	var v any
	if len(raw) == 0 || json.Unmarshal(raw, &v) != nil {
		return map[string]any{}
	}
	if s, ok := v.(string); ok {
		var inner any
		if json.Unmarshal([]byte(s), &inner) == nil {
			return inner
		}
		return map[string]any{"args": s}
	}
	return v
}

func textOf(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(raw)
}

// ---------- older Cursor: bubbles ----------

type bubble struct {
	BubbleID  string          `json:"bubbleId"`
	Type      int             `json:"type"` // 1 = the person, 2 = Cursor
	Text      string          `json:"text"`
	CreatedAt string          `json:"createdAt"`
	Thinking  json.RawMessage `json:"thinking"`
	Tool      *struct {
		ToolCallID string `json:"toolCallId"`
		Name       string `json:"name"`
		RawArgs    string `json:"rawArgs"`
		Params     string `json:"params"`
		Result     string `json:"result"`
	} `json:"toolFormerData"`
}

func bubbleMessages(db *sql.DB, c *composer) []msg {
	var bs []bubble
	for _, raw := range c.Conversation {
		var b bubble
		if json.Unmarshal(raw, &b) == nil {
			bs = append(bs, b)
		}
	}
	if len(bs) == 0 {
		q, err := db.Query(`SELECT value FROM cursorDiskKV WHERE key LIKE ?`, "bubbleId:"+c.ComposerID+":%")
		if err != nil {
			return nil
		}
		byID := map[string]bubble{}
		for q.Next() {
			var v []byte
			var b bubble
			if q.Scan(&v) == nil && json.Unmarshal(v, &b) == nil {
				byID[b.BubbleID] = b
				bs = append(bs, b)
			}
		}
		q.Close()
		if len(c.FullConversationHeadersOnly) > 0 {
			bs = bs[:0]
			for _, h := range c.FullConversationHeadersOnly {
				if b, ok := byID[h.BubbleID]; ok {
					bs = append(bs, b)
				}
			}
		} else {
			sort.SliceStable(bs, func(i, j int) bool { return bs[i].CreatedAt < bs[j].CreatedAt })
		}
	}
	var out []msg
	for _, b := range bs {
		if b.Type == 1 {
			if strings.TrimSpace(b.Text) == "" {
				continue
			}
			at, _ := time.Parse(time.RFC3339Nano, b.CreatedAt)
			out = append(out, msg{Role: "user", Content: []map[string]any{{"type": "text", "text": b.Text}}, prompt: true, at: at})
			continue
		}
		var content []map[string]any
		var th string
		if json.Unmarshal(b.Thinking, &th) != nil {
			var o struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal(b.Thinking, &o)
			th = o.Text
		}
		if strings.TrimSpace(th) != "" {
			content = append(content, map[string]any{"type": "thinking", "thinking": th})
		}
		if strings.TrimSpace(b.Text) != "" {
			content = append(content, map[string]any{"type": "text", "text": b.Text})
		}
		var result *msg
		if t := b.Tool; t != nil && t.Name != "" {
			args := t.RawArgs
			if args == "" {
				args = t.Params
			}
			raw, _ := json.Marshal(args)
			content = append(content, map[string]any{"type": "tool_use", "id": t.ToolCallID, "name": t.Name, "input": jsonOrText(raw)})
			if t.Result != "" {
				result = &msg{Role: "user", Content: []map[string]any{{"type": "tool_result", "tool_use_id": t.ToolCallID, "content": t.Result}}}
			}
		}
		if len(content) > 0 {
			out = append(out, msg{Role: "assistant", Content: content})
		}
		if result != nil {
			out = append(out, *result)
		}
	}
	return out
}
