package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// codexStore reads local Codex rollouts (%USERPROFILE%\.codex) the same way cursorStore reads Cursor.
// auth.json is never opened. SQLite next to the rollouts is not used as a source of text.
type codexStore struct {
	profilesDir string
	registry    bool
	settle      time.Duration
	now         func() time.Time
	host        string
	stateDir    string
	mu          sync.Mutex
	idx         map[string]*codexHome // keyed by .codex home path
	live        map[string]*codexSess // keyed by session id; messages, never written to disk
	ingests     int
}

type codexProfile struct {
	name, user, account string
	homes               []string
}

type codexHome struct {
	Stamp   map[string]fileStamp `json:"stamp"` // path -> size/mod
	Files   map[string]codexFile `json:"files"` // session id -> file
	built   bool
	recheck time.Time
	rows    []rowMeta
}

type codexFile struct {
	Path    string    `json:"path"`
	Session string    `json:"session"`
	Size    int64     `json:"size"`
	Mod     int64     `json:"mod"`
	Offset  int64     `json:"offset"`
	Model   string    `json:"model,omitempty"`
	Cwd     string    `json:"cwd,omitempty"`
	Parent  string    `json:"parent,omitempty"`
	Rows    []rowMeta `json:"rows"`
}

type turnUsage struct {
	in, out, cache int
	real           bool
}

type codexSess struct {
	id, model, cwd, parent string
	msgs                   []msg
	usage                  []turnUsage // per prompt turn, from token_count
}

const codexIndexVersion = 1

func newCodexStore(profilesDir string, settle time.Duration) *codexStore {
	host, _ := os.Hostname()
	return &codexStore{
		profilesDir: profilesDir,
		registry:    strings.EqualFold(filepath.Clean(profilesDir), filepath.Clean(defaultProfilesDir())),
		settle:      settle,
		now:         time.Now,
		host:        host,
		idx:         map[string]*codexHome{},
		live:        map[string]*codexSess{},
	}
}

func sourceNameCodex(profile string) string {
	n := strings.Trim(nameBad.ReplaceAllString(strings.ToLower(profile), "-"), "-.")
	if len(n) > 50 {
		n = n[:50]
	}
	return "codex-" + n
}

func (s *codexStore) profiles() []codexProfile {
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
	var out []codexProfile
	seen := map[string]bool{}
	for _, o := range all {
		user := filepath.Base(o.dir)
		name := sourceNameCodex(user)
		if skipProfiles[strings.ToLower(user)] || seen[name] {
			continue
		}
		homes := codexHomes(o.dir)
		if len(homes) == 0 {
			continue
		}
		has := false
		for _, h := range homes {
			if len(listRollouts(h)) > 0 {
				has = true
				break
			}
		}
		if !has {
			continue
		}
		seen[name] = true
		out = append(out, codexProfile{name: name, user: user, account: o.account, homes: homes})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func (s *codexStore) find(name string) (codexProfile, error) {
	for _, p := range s.profiles() {
		if p.name == name {
			return p, nil
		}
	}
	return codexProfile{}, errUnknownSource
}

func codexHomes(userDir string) []string {
	var homes []string
	seen := map[string]bool{}
	add := func(p string) {
		p = filepath.Clean(p)
		if p == "" || seen[strings.ToLower(p)] {
			return
		}
		st, err := os.Stat(p)
		if err != nil || !st.IsDir() {
			return
		}
		seen[strings.ToLower(p)] = true
		homes = append(homes, p)
	}
	add(filepath.Join(userDir, ".codex"))
	if extra := os.Getenv("CODEX_HOME"); extra != "" && strings.EqualFold(os.Getenv("USERPROFILE"), userDir) {
		add(extra)
	}
	return homes
}

func listRollouts(home string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(path string) {
		n := filepath.Base(path)
		if n == "auth.json" || strings.EqualFold(n, "auth.json") {
			return
		}
		if !strings.HasPrefix(n, "rollout-") {
			return
		}
		if !strings.HasSuffix(n, ".jsonl") && !strings.HasSuffix(n, ".json") {
			return
		}
		if seen[path] {
			return
		}
		seen[path] = true
		out = append(out, path)
	}
	walk := func(root string) {
		_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			add(path)
			return nil
		})
	}
	walk(filepath.Join(home, "sessions"))
	walk(filepath.Join(home, "archived_sessions"))
	ents, _ := os.ReadDir(home)
	for _, e := range ents {
		if !e.IsDir() {
			add(filepath.Join(home, e.Name()))
		}
	}
	sort.Strings(out)
	return out
}

func (s *codexStore) sources() (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []sourceInfo{}
	for _, p := range s.profiles() {
		info := sourceInfo{Name: p.name, Profile: p.user, Kind: "codex", Account: p.account}
		var last time.Time
		chats := map[string]bool{}
		for _, home := range p.homes {
			ix, err := s.indexHome(home)
			if err != nil {
				info.Error = err.Error()
				continue
			}
			for id, f := range ix.Files {
				if len(f.Rows) > 0 {
					chats[id] = true
				}
				if st, err := os.Stat(f.Path); err == nil && st.ModTime().After(last) {
					last = st.ModTime()
				}
			}
		}
		info.Chats = len(chats)
		if !last.IsZero() {
			info.LastUse = iso(last)
		}
		out = append(out, info)
	}
	return map[string]any{"sources": out, "agent": agentInfo{Host: s.host, Version: version}}, nil
}

func (s *codexStore) oldest(name string) (*string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.find(name)
	if err != nil {
		return nil, err
	}
	rows, err := s.allRows(p)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return &rows[0].Timestamp, nil
}

func (s *codexStore) rows(name, ts, id string, limit int) ([]Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.find(name)
	if err != nil {
		return nil, err
	}
	all, err := s.allRows(p)
	if err != nil {
		return nil, err
	}
	i := sort.Search(len(all), func(i int) bool {
		r := all[i]
		return r.Timestamp > ts || (r.Timestamp == ts && r.ID > id)
	})
	page := all[i:]
	if len(page) > limit {
		page = page[:limit]
	}
	if len(page) == 0 {
		return []Row{}, nil
	}
	return s.build(p, page)
}

func (s *codexStore) allRows(p codexProfile) ([]rowMeta, error) {
	var rows []rowMeta
	for _, home := range p.homes {
		ix, err := s.indexHome(home)
		if err != nil {
			return nil, err
		}
		rows = append(rows, ix.rows...)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Timestamp != rows[j].Timestamp {
			return rows[i].Timestamp < rows[j].Timestamp
		}
		return rows[i].ID < rows[j].ID
	})
	return rows, nil
}

func (s *codexStore) indexHome(home string) (*codexHome, error) {
	ix := s.loadHome(home)
	files := listRollouts(home)
	stamp := map[string]fileStamp{}
	for _, path := range files {
		stamp[path] = stampOf(path)
	}
	unchanged := ix.built && len(stamp) == len(ix.Stamp)
	if unchanged {
		for p, st := range stamp {
			if ix.Stamp[p] != st {
				unchanged = false
				break
			}
		}
	}
	if unchanged {
		if ix.recheck.IsZero() || s.now().Before(ix.recheck) {
			return ix, nil
		}
		// the file stopped changing and the settle window has passed: include the last turn
		allLive := true
		for id, f := range ix.Files {
			live := s.live[id]
			if live == nil {
				allLive = false
				break
			}
			f.Rows = live.turns(false)
			ix.Files[id] = f
		}
		if allLive {
			var rows []rowMeta
			for _, f := range ix.Files {
				rows = append(rows, f.Rows...)
			}
			sort.Slice(rows, func(i, j int) bool {
				if rows[i].Timestamp != rows[j].Timestamp {
					return rows[i].Timestamp < rows[j].Timestamp
				}
				return rows[i].ID < rows[j].ID
			})
			ix.rows, ix.recheck = rows, time.Time{}
			s.saveHome(home, ix)
			return ix, nil
		}
	}

	byPath := map[string]string{}
	for id, f := range ix.Files {
		byPath[f.Path] = id
	}
	seen := map[string]bool{}
	recheck := time.Time{}
	for _, path := range files {
		st := stamp[path]
		sid := byPath[path]
		if sid == "" {
			sid = peekSession(path)
			if sid == "" {
				sid = sessionFromName(path)
			}
			if other, ok := ix.Files[sid]; ok && other.Path != path {
				// archive move (or a copy): keep the session, retarget the path
				if other.Size == st.Size && other.Offset <= st.Size {
					f := other
					f.Path, f.Size, f.Mod = path, st.Size, st.Mod
					ix.Files[sid] = f
					seen[sid] = true
					continue
				}
				f := other
				f.Path = path
				ix.Files[sid] = f
			}
		}
		f := ix.Files[sid]
		if f.Session == "" {
			f.Session = sid
		}
		live := s.live[sid]
		need := f.Path != path || f.Size != st.Size || f.Mod != st.Mod || live == nil
		if !need {
			seen[sid] = true
			continue
		}
		from := int64(0)
		if live != nil && f.Path == path && st.Size >= f.Offset && f.Offset > 0 {
			from = f.Offset
		} else {
			live = &codexSess{id: sid, model: f.Model, cwd: f.Cwd, parent: f.Parent}
		}
		off, err := live.ingest(path, from)
		s.ingests++
		if err != nil {
			return nil, err
		}
		f.Path, f.Size, f.Mod, f.Offset = path, st.Size, st.Mod, off
		f.Session, f.Model, f.Cwd, f.Parent = live.id, live.model, live.cwd, live.parent
		if live.id != "" && live.id != sid {
			delete(ix.Files, sid)
			sid = live.id
			f.Session = sid
		}
		hot := s.now().Sub(time.Unix(0, st.Mod)) < s.settle
		f.Rows = live.turns(hot) // last turn omitted while the file is still settling and has no token_count yet
		s.live[sid] = live
		ix.Files[sid] = f
		seen[sid] = true
		if hot {
			recheck = s.now().Add(s.settle)
		}
	}
	for id, f := range ix.Files {
		if !seen[id] {
			if _, err := os.Stat(f.Path); err != nil {
				delete(ix.Files, id)
				delete(s.live, id)
			}
		}
	}
	var rows []rowMeta
	for _, f := range ix.Files {
		rows = append(rows, f.Rows...)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Timestamp != rows[j].Timestamp {
			return rows[i].Timestamp < rows[j].Timestamp
		}
		return rows[i].ID < rows[j].ID
	})
	ix.Stamp, ix.Files, ix.rows, ix.built, ix.recheck = stamp, ix.Files, rows, true, recheck
	s.saveHome(home, ix)
	return ix, nil
}

func (s *codexStore) build(p codexProfile, page []rowMeta) ([]Row, error) {
	out := make([]Row, 0, len(page))
	size := 0
	for _, r := range page {
		live := s.live[r.Chat]
		if live == nil {
			var path string
			for _, home := range p.homes {
				if ix := s.idx[home]; ix != nil {
					if f, ok := ix.Files[r.Chat]; ok {
						path = f.Path
						break
					}
				}
			}
			if path == "" {
				continue
			}
			live = &codexSess{id: r.Chat}
			if _, err := live.ingest(path, 0); err != nil {
				return nil, err
			}
			s.live[r.Chat] = live
		}
		row := Row{ID: r.ID, Timestamp: r.Timestamp, Provider: "codex", Model: r.Model, Status: "success"}
		row.Data = s.rowData(p, live, r)
		if len(out) > 0 && size+len(row.Data) > pageBytes {
			break
		}
		size += len(row.Data)
		out = append(out, row)
	}
	return out, nil
}

func (s *codexStore) rowData(p codexProfile, live *codexSess, r rowMeta) string {
	end := r.End
	if end > len(live.msgs) {
		end = len(live.msgs)
	}
	sessionMeta, _ := json.Marshal(map[string]string{"device_id": s.host, "session_id": live.id})
	sys := fmt.Sprintf(`Codex on %s, Windows profile C:\Users\%s\`, s.host, p.user)
	if live.cwd != "" {
		sys += ", cwd " + live.cwd
	}
	if live.parent != "" {
		sys = "You are a Codex subagent of session " + live.parent + ".\n" + sys
	}
	tok := map[string]any{"input_tokens": r.In, "output_tokens": r.Out}
	if r.Cache > 0 {
		tok["cache_read_input_tokens"] = r.Cache
	}
	if !r.Real {
		tok["estimated"] = true
	}
	data, _ := json.Marshal(map[string]any{
		"client":    "codex",
		"timestamp": r.Timestamp,
		"request": map[string]any{
			"model":    r.Model,
			"system":   sys,
			"metadata": map[string]string{"user_id": string(sessionMeta)},
			"messages": live.msgs[:end],
		},
		"tokens":   tok,
		"response": map[string]any{},
	})
	return string(data)
}

func (live *codexSess) turns(hot bool) []rowMeta {
	var starts []int
	for i, m := range live.msgs {
		if m.prompt {
			starts = append(starts, i)
		}
	}
	if len(starts) == 0 {
		return nil
	}
	model := live.model
	if model == "" {
		model = "codex"
	}
	var rows []rowMeta
	prev := time.Time{}
	for k, start := range starts {
		end := len(live.msgs)
		last := k == len(starts)-1
		if !last {
			end = starts[k+1]
		} else if hot && !(k < len(live.usage) && live.usage[k].real) {
			break
		}
		at := live.msgs[start].at
		if at.IsZero() || (!prev.IsZero() && at.Before(prev)) {
			if prev.IsZero() {
				at = time.Unix(0, 0).UTC()
			} else {
				at = prev
			}
		}
		prev = at
		in, out := estTurnTokens(live.msgs[start:end])
		cache := 0
		real := false
		if k < len(live.usage) && live.usage[k].real {
			in, out, cache, real = live.usage[k].in, live.usage[k].out, live.usage[k].cache, true
		}
		rows = append(rows, rowMeta{
			ID:        fmt.Sprintf("codex:%s:%d", live.id, k),
			Timestamp: iso(at),
			Model:     model,
			Chat:      live.id,
			End:       end,
			In:        in,
			Out:       out,
			Cache:     cache,
			Real:      real,
		})
	}
	return rows
}

func (live *codexSess) ingest(path string, from int64) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return from, err
	}
	defer f.Close()
	if from > 0 {
		if _, err := f.Seek(from, io.SeekStart); err != nil {
			return from, err
		}
	}
	br := bufio.NewReader(f)
	off := from
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 && (err == nil || (err == io.EOF && bytes.HasSuffix(line, []byte("\n")))) {
			off += int64(len(line))
			live.apply(bytes.TrimSpace(line))
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return off, err
		}
	}
	return off, nil
}

type envelope struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type sessionMetaPayload struct {
	ID             string `json:"id"`
	Timestamp      string `json:"timestamp"`
	Cwd            string `json:"cwd"`
	Originator     string `json:"originator"`
	CLIVersion     string `json:"cli_version"`
	Source         string `json:"source"`
	ModelProvider  string `json:"model_provider"`
	ParentThreadID string `json:"parent_thread_id"`
}

type turnContextPayload struct {
	Model  string `json:"model"`
	Effort string `json:"effort"`
}

func (live *codexSess) apply(raw []byte) {
	if len(raw) == 0 {
		return
	}
	var env envelope
	if json.Unmarshal(raw, &env) == nil && env.Type != "" {
		switch env.Type {
		case "session_meta":
			live.applyMeta(env.Payload, env.Timestamp)
		case "turn_context":
			var tc turnContextPayload
			if json.Unmarshal(env.Payload, &tc) == nil && tc.Model != "" {
				live.model = tc.Model
			}
		case "response_item":
			live.applyItem(env.Payload, env.Timestamp)
		case "event_msg":
			live.applyEvent(env.Payload)
		}
		return
	}
	var meta sessionMetaPayload
	if json.Unmarshal(raw, &meta) == nil && meta.ID != "" && live.id == "" {
		live.applyMeta(raw, meta.Timestamp)
		return
	}
	live.applyItem(raw, "")
}

func (live *codexSess) applyMeta(raw json.RawMessage, ts string) {
	var m sessionMetaPayload
	if json.Unmarshal(raw, &m) != nil {
		return
	}
	if m.ID != "" {
		live.id = m.ID
	}
	if m.Cwd != "" {
		live.cwd = m.Cwd
	}
	if m.ParentThreadID != "" {
		live.parent = m.ParentThreadID
	}
	if ts == "" {
		ts = m.Timestamp
	}
}

func (live *codexSess) applyEvent(raw json.RawMessage) {
	var p struct {
		Type string `json:"type"`
		Info struct {
			Last *struct {
				Input  int `json:"input_tokens"`
				Cached int `json:"cached_input_tokens"`
				Output int `json:"output_tokens"`
			} `json:"last_token_usage"`
		} `json:"info"`
	}
	if json.Unmarshal(raw, &p) != nil || p.Type != "token_count" || p.Info.Last == nil {
		return
	}
	in, cached, out := p.Info.Last.Input, p.Info.Last.Cached, p.Info.Last.Output
	if cached > 0 && in >= cached {
		in -= cached
	}
	n := 0
	for _, m := range live.msgs {
		if m.prompt {
			n++
		}
	}
	if n == 0 {
		return
	}
	k := n - 1
	for len(live.usage) <= k {
		live.usage = append(live.usage, turnUsage{})
	}
	live.usage[k] = turnUsage{in: in, out: out, cache: cached, real: true}
}

func unwrapItem(raw json.RawMessage) json.RawMessage {
	var wrap struct {
		Item json.RawMessage `json:"item"`
	}
	if json.Unmarshal(raw, &wrap) == nil && len(wrap.Item) > 2 && wrap.Item[0] == '{' {
		return wrap.Item
	}
	return raw
}

func (live *codexSess) applyItem(raw json.RawMessage, ts string) {
	raw = unwrapItem(raw)
	var it struct {
		Type      string          `json:"type"`
		Role      string          `json:"role"`
		Content   json.RawMessage `json:"content"`
		Summary   json.RawMessage `json:"summary"`
		CallID    string          `json:"call_id"`
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
		Output    json.RawMessage `json:"output"`
		Action    json.RawMessage `json:"action"`
		Command   json.RawMessage `json:"command"`
	}
	if json.Unmarshal(raw, &it) != nil || it.Type == "" {
		return
	}
	at := parseISOTime(ts)
	call := it.CallID
	if call == "" {
		call = it.ID
	}
	switch it.Type {
	case "message":
		text := textFromContent(it.Content)
		if strings.EqualFold(it.Role, "user") || it.Role == "" {
			if skipCodexUser(text) {
				return
			}
			live.msgs = append(live.msgs, msg{
				Role:    "user",
				Content: []map[string]any{{"type": "text", "text": text}},
				prompt:  true,
				at:      at,
			})
			return
		}
		if strings.TrimSpace(text) == "" {
			return
		}
		live.msgs = append(live.msgs, msg{
			Role:    "assistant",
			Content: []map[string]any{{"type": "text", "text": text}},
			at:      at,
		})
	case "reasoning":
		th := textFromSummary(it.Summary)
		if strings.TrimSpace(th) == "" {
			th = textFromContent(it.Content)
		}
		if strings.TrimSpace(th) == "" {
			return
		}
		live.msgs = append(live.msgs, msg{
			Role:    "assistant",
			Content: []map[string]any{{"type": "thinking", "thinking": th}},
			at:      at,
		})
	case "function_call", "custom_tool_call", "custom_tool_use":
		name := it.Name
		if name == "" {
			name = "tool"
		}
		live.msgs = append(live.msgs, msg{
			Role:    "assistant",
			Content: []map[string]any{{"type": "tool_use", "id": call, "name": name, "input": jsonOrText(it.Arguments)}},
			at:      at,
		})
	case "local_shell_call":
		in := it.Action
		if len(in) == 0 {
			in = it.Command
		}
		live.msgs = append(live.msgs, msg{
			Role:    "assistant",
			Content: []map[string]any{{"type": "tool_use", "id": call, "name": "shell", "input": jsonOrText(in)}},
			at:      at,
		})
	case "function_call_output", "custom_tool_call_output", "local_shell_call_output":
		live.msgs = append(live.msgs, msg{
			Role:    "user",
			Content: []map[string]any{{"type": "tool_result", "tool_use_id": call, "content": textFromContent(it.Output)}},
			at:      at,
		})
	}
}

func skipCodexUser(text string) bool {
	t := strings.TrimSpace(text)
	if t == "" {
		return true
	}
	if strings.Contains(t, "<environment_context>") {
		return true
	}
	if strings.HasPrefix(t, "# AGENTS.md") || strings.HasPrefix(t, "<AGENTS.md") {
		return true
	}
	if strings.Contains(t, "<skills_instructions") {
		return true
	}
	return false
}

func textFromContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			switch p.Type {
			case "input_text", "output_text", "text", "":
				b.WriteString(p.Text)
			case "input_image", "image":
				b.WriteString("[image]")
			}
		}
		return b.String()
	}
	return strings.Trim(string(raw), `"`)
}

func textFromSummary(raw json.RawMessage) string {
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			b.WriteString(p.Text)
		}
		return b.String()
	}
	var o struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &o) == nil {
		return o.Text
	}
	return ""
}

func parseISOTime(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t
	}
	return time.Time{}
}

func peekSession(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	br := bufio.NewReaderSize(f, 8<<10)
	line, _ := br.ReadBytes('\n')
	var env envelope
	if json.Unmarshal(bytes.TrimSpace(line), &env) == nil && env.Type == "session_meta" {
		var m sessionMetaPayload
		if json.Unmarshal(env.Payload, &m) == nil {
			return m.ID
		}
	}
	var m sessionMetaPayload
	if json.Unmarshal(bytes.TrimSpace(line), &m) == nil {
		return m.ID
	}
	return ""
}

func sessionFromName(path string) string {
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	rest := strings.TrimPrefix(base, "rollout-")
	t := strings.Index(rest, "T")
	if t < 0 {
		return rest
	}
	after := rest[t+1:]
	parts := strings.SplitN(after, "-", 4)
	if len(parts) == 4 && parts[3] != "" {
		return parts[3]
	}
	return rest
}

func (s *codexStore) indexFile(home string) string {
	if s.stateDir == "" {
		return ""
	}
	h := sha256.Sum256([]byte(strings.ToLower(home)))
	return filepath.Join(s.stateDir, "codex-"+hex.EncodeToString(h[:8])+".json")
}

func (s *codexStore) loadHome(home string) *codexHome {
	if ix, ok := s.idx[home]; ok {
		return ix
	}
	fresh := &codexHome{Stamp: map[string]fileStamp{}, Files: map[string]codexFile{}}
	f := s.indexFile(home)
	if f == "" {
		s.idx[home] = fresh
		return fresh
	}
	raw, err := os.ReadFile(f)
	if err != nil {
		s.idx[home] = fresh
		return fresh
	}
	var on struct {
		Version int `json:"version"`
		codexHome
	}
	if json.Unmarshal(raw, &on) != nil || on.Version != codexIndexVersion || on.Files == nil {
		s.idx[home] = fresh
		return fresh
	}
	ix := &on.codexHome
	if ix.Stamp == nil {
		ix.Stamp = map[string]fileStamp{}
	}
	for _, f := range ix.Files {
		ix.rows = append(ix.rows, f.Rows...)
	}
	sort.Slice(ix.rows, func(i, j int) bool {
		if ix.rows[i].Timestamp != ix.rows[j].Timestamp {
			return ix.rows[i].Timestamp < ix.rows[j].Timestamp
		}
		return ix.rows[i].ID < ix.rows[j].ID
	})
	ix.built = true
	s.idx[home] = ix
	return ix
}

func (s *codexStore) saveHome(home string, ix *codexHome) {
	f := s.indexFile(home)
	if f == "" {
		return
	}
	raw, err := json.Marshal(struct {
		Version int `json:"version"`
		*codexHome
	}{codexIndexVersion, ix})
	if err != nil {
		return
	}
	tmp := f + ".tmp"
	if os.WriteFile(tmp, raw, 0o600) == nil {
		_ = os.Rename(tmp, f)
	}
}

func mergeSources(cur *cursorStore, cod *codexStore) (map[string]any, error) {
	a, err := cur.sources()
	if err != nil {
		return nil, err
	}
	b, err := cod.sources()
	if err != nil {
		return nil, err
	}
	sa, _ := a["sources"].([]sourceInfo)
	sb, _ := b["sources"].([]sourceInfo)
	out := make([]sourceInfo, 0, len(sa)+len(sb))
	out = append(out, sa...)
	out = append(out, sb...)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return map[string]any{"sources": out, "agent": a["agent"]}, nil
}
