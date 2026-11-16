package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func envLine(ts, typ string, payload any) string {
	raw, _ := json.Marshal(map[string]any{"timestamp": ts, "type": typ, "payload": payload})
	return string(raw)
}

func writeRollout(t *testing.T, users, user, session, file string, lines ...string) string {
	t.Helper()
	dir := filepath.Join(users, user, ".codex", "sessions", "2026", "11", "15")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, file)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	return path
}

func sampleTurn(session, t0, t1, prompt, answer string, in, cached, out int) []string {
	return []string{
		envLine(t0, "session_meta", map[string]any{"id": session, "cwd": `C:\proj`, "cli_version": "0.1.0"}),
		envLine(t0, "turn_context", map[string]any{"model": "gpt-5.1-codex"}),
		envLine(t0, "response_item", map[string]any{
			"type": "message", "role": "user",
			"content": []map[string]string{{"type": "input_text", "text": prompt}},
		}),
		envLine(t1, "response_item", map[string]any{
			"type": "message", "role": "assistant",
			"content": []map[string]string{{"type": "output_text", "text": answer}},
		}),
		envLine(t1, "event_msg", map[string]any{
			"type": "token_count",
			"info": map[string]any{
				"last_token_usage":  map[string]int{"input_tokens": in, "cached_input_tokens": cached, "output_tokens": out},
				"total_token_usage": map[string]int{"input_tokens": in + 50, "cached_input_tokens": cached, "output_tokens": out + 10},
			},
		}),
	}
}

func TestCodexChatsBecomeTurns(t *testing.T) {
	users := t.TempDir()
	sid := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	writeRollout(t, users, "A.Nazari", sid, "rollout-2026-11-15T09-00-00-"+sid+".jsonl",
		append(
			sampleTurn(sid, "2026-11-15T09:00:00.000Z", "2026-11-15T09:00:05.000Z", "hello codex", "hi", 100, 20, 8),
			envLine("2026-11-15T09:01:00.000Z", "response_item", map[string]any{
				"type": "message", "role": "user",
				"content": []map[string]string{{"type": "input_text", "text": "again"}},
			}),
			envLine("2026-11-15T09:01:02.000Z", "response_item", map[string]any{
				"type": "reasoning", "summary": []map[string]string{{"text": "think"}},
			}),
			envLine("2026-11-15T09:01:03.000Z", "response_item", map[string]any{
				"type": "function_call", "call_id": "c1", "name": "shell", "arguments": `{"command":"dir"}`,
			}),
			envLine("2026-11-15T09:01:04.000Z", "response_item", map[string]any{
				"type": "function_call_output", "call_id": "c1", "output": "ok",
			}),
			envLine("2026-11-15T09:01:05.000Z", "response_item", map[string]any{
				"type": "message", "role": "assistant",
				"content": []map[string]string{{"type": "output_text", "text": "done"}},
			}),
			envLine("2026-11-15T09:01:06.000Z", "event_msg", map[string]any{
				"type": "token_count",
				"info": map[string]any{"last_token_usage": map[string]int{"input_tokens": 40, "cached_input_tokens": 0, "output_tokens": 12}},
			}),
		)...,
	)
	_ = os.WriteFile(filepath.Join(users, "A.Nazari", ".codex", "auth.json"), []byte(`{"tokens":"secret"}`), 0o600)

	st := newCodexStore(users, 90*time.Second)
	st.now = func() time.Time { return time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC) }
	src, err := st.sources()
	if err != nil {
		t.Fatal(err)
	}
	list := src["sources"].([]sourceInfo)
	if len(list) != 1 || list[0].Name != "codex-a.nazari" || list[0].Kind != "codex" || list[0].Chats != 1 {
		t.Fatalf("sources: %+v", list)
	}

	rows, err := st.rows("codex-a.nazari", "", "", 50)
	if err != nil || len(rows) != 2 {
		t.Fatalf("rows: %v %d", err, len(rows))
	}
	if rows[0].ID != "codex:"+sid+":0" || rows[1].ID != "codex:"+sid+":1" {
		t.Fatalf("ids: %s %s", rows[0].ID, rows[1].ID)
	}
	if rows[0].Provider != "codex" || rows[0].Model != "gpt-5.1-codex" {
		t.Fatalf("row0: %+v", rows[0])
	}
	var d map[string]any
	if json.Unmarshal([]byte(rows[0].Data), &d) != nil {
		t.Fatal(rows[0].Data)
	}
	if d["client"] != "codex" {
		t.Fatalf("client %v", d["client"])
	}
	tok := d["tokens"].(map[string]any)
	if tok["input_tokens"] != float64(80) || tok["cache_read_input_tokens"] != float64(20) || tok["output_tokens"] != float64(8) {
		t.Fatalf("tokens %+v", tok)
	}
	if _, ok := tok["estimated"]; ok {
		t.Fatal("real usage marked estimated")
	}
	req := d["request"].(map[string]any)
	sys := req["system"].(string)
	if !strings.Contains(sys, `C:\Users\A.Nazari\`) || strings.Contains(sys, "subagent") {
		t.Fatalf("system %q", sys)
	}
	msgs := req["messages"].([]any)
	if len(msgs) < 1 {
		t.Fatal("no messages")
	}

	var d2 map[string]any
	_ = json.Unmarshal([]byte(rows[1].Data), &d2)
	tok2 := d2["tokens"].(map[string]any)
	if tok2["input_tokens"] != float64(40) || tok2["output_tokens"] != float64(12) {
		t.Fatalf("turn2 tokens %+v", tok2)
	}
	msgs2 := d2["request"].(map[string]any)["messages"].([]any)
	if len(msgs2) <= len(msgs) {
		t.Fatalf("second turn should include the first: %d vs %d", len(msgs2), len(msgs))
	}
}

func TestCodexSkipsInjectedUserAndKeepsAuthClosed(t *testing.T) {
	users := t.TempDir()
	sid := "11111111-1111-1111-1111-111111111111"
	writeRollout(t, users, "bob", sid, "rollout-2026-11-15T10-00-00-"+sid+".jsonl",
		envLine("2026-11-15T10:00:00Z", "session_meta", map[string]any{"id": sid}),
		envLine("2026-11-15T10:00:01Z", "response_item", map[string]any{
			"type": "message", "role": "user",
			"content": []map[string]string{{"type": "input_text", "text": "<environment_context>cwd</environment_context>"}},
		}),
		envLine("2026-11-15T10:00:02Z", "response_item", map[string]any{
			"type": "message", "role": "user",
			"content": []map[string]string{{"type": "input_text", "text": "# AGENTS.md\nrules"}},
		}),
		envLine("2026-11-15T10:00:03Z", "response_item", map[string]any{
			"type": "message", "role": "user",
			"content": []map[string]string{{"type": "input_text", "text": "real question"}},
		}),
		envLine("2026-11-15T10:00:04Z", "response_item", map[string]any{
			"type": "message", "role": "assistant",
			"content": []map[string]string{{"type": "output_text", "text": "ans"}},
		}),
	)
	st := newCodexStore(users, 0)
	rows, err := st.rows("codex-bob", "", "", 10)
	if err != nil || len(rows) != 1 {
		t.Fatalf("want 1 turn, got %d %v", len(rows), err)
	}
	var d map[string]any
	_ = json.Unmarshal([]byte(rows[0].Data), &d)
	msgs := d["request"].(map[string]any)["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("injected should be dropped, got %d msgs: %s", len(msgs), rows[0].Data)
	}
}

func TestCodexArchiveMoveIsSameChat(t *testing.T) {
	users := t.TempDir()
	sid := "22222222-2222-2222-2222-222222222222"
	path := writeRollout(t, users, "ann", sid, "rollout-2026-11-15T11-00-00-"+sid+".jsonl",
		sampleTurn(sid, "2026-11-15T11:00:00Z", "2026-11-15T11:00:02Z", "q", "a", 10, 0, 4)...,
	)
	st := newCodexStore(users, 0)
	st.stateDir = t.TempDir()
	first, err := st.rows("codex-ann", "", "", 10)
	if err != nil || len(first) != 1 {
		t.Fatalf("first: %v %d", err, len(first))
	}
	ingests := st.ingests
	arch := filepath.Join(users, "ann", ".codex", "archived_sessions")
	if err := os.MkdirAll(arch, 0o700); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(arch, filepath.Base(path))
	if err := os.Rename(path, dest); err != nil {
		t.Fatal(err)
	}
	st2 := newCodexStore(users, 0)
	st2.stateDir = st.stateDir
	second, err := st2.rows("codex-ann", "", "", 10)
	if err != nil || len(second) != 1 {
		t.Fatalf("after archive: %v %d", err, len(second))
	}
	if second[0].ID != first[0].ID {
		t.Fatalf("id changed on archive: %s -> %s", first[0].ID, second[0].ID)
	}
	if st2.ingests != 0 {
		t.Fatalf("archive move reparsed: %d (first process had %d)", st2.ingests, ingests)
	}
}

func TestCodexIncrementalAppend(t *testing.T) {
	users := t.TempDir()
	sid := "33333333-3333-3333-3333-333333333333"
	file := "rollout-2026-11-15T12-00-00-" + sid + ".jsonl"
	path := writeRollout(t, users, "cam", sid, file,
		sampleTurn(sid, "2026-11-15T12:00:00Z", "2026-11-15T12:00:02Z", "one", "ok", 5, 0, 2)...,
	)
	st := newCodexStore(users, 0)
	st.stateDir = t.TempDir()
	a, err := st.rows("codex-cam", "", "", 10)
	if err != nil || len(a) != 1 {
		t.Fatalf("first: %v %d", err, len(a))
	}
	n := st.ingests
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	extra := strings.Join([]string{
		envLine("2026-11-15T12:01:00Z", "response_item", map[string]any{
			"type": "message", "role": "user",
			"content": []map[string]string{{"type": "input_text", "text": "two"}},
		}),
		envLine("2026-11-15T12:01:01Z", "response_item", map[string]any{
			"type": "message", "role": "assistant",
			"content": []map[string]string{{"type": "output_text", "text": "ok2"}},
		}),
	}, "\n") + "\n"
	if _, err := f.WriteString(extra); err != nil {
		t.Fatal(err)
	}
	f.Close()
	b, err := st.rows("codex-cam", "", "", 10)
	if err != nil || len(b) != 2 {
		t.Fatalf("append: %v %d", err, len(b))
	}
	if st.ingests != n+1 {
		t.Fatalf("append should ingest once more, %d -> %d", n, st.ingests)
	}
	if b[0].ID != a[0].ID {
		t.Fatalf("first id changed")
	}
}

func TestCodexAndCursorSourcesTogether(t *testing.T) {
	users := t.TempDir()
	c := newProfile(t, users, "mix")
	u := c.blob(map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "<user_query>hi</user_query>"}}})
	a := c.blob(map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "ok"}}})
	c.put("composerData:x", map[string]any{"composerId": "x", "lastUpdatedAt": float64(time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC).UnixMilli()), "conversationState": state(u, a)})

	sid := "44444444-4444-4444-4444-444444444444"
	writeRollout(t, users, "mix", sid, "rollout-2026-11-15T13-00-00-"+sid+".jsonl",
		sampleTurn(sid, "2026-11-15T13:00:00Z", "2026-11-15T13:00:01Z", "codex hi", "yo", 3, 0, 1)...,
	)

	cur := newCursorStore(users, 0)
	cod := newCodexStore(users, 0)
	res, err := mergeSources(cur, cod)
	if err != nil {
		t.Fatal(err)
	}
	list := res["sources"].([]sourceInfo)
	names := map[string]string{}
	for _, s := range list {
		names[s.Name] = s.Kind
	}
	if names["cursor-mix"] != "cursor" || names["codex-mix"] != "codex" {
		t.Fatalf("merged %+v", list)
	}
}

func TestCodexSubagentSystem(t *testing.T) {
	users := t.TempDir()
	sid := "55555555-5555-5555-5555-555555555555"
	writeRollout(t, users, "dev", sid, "rollout-2026-11-15T14-00-00-"+sid+".jsonl",
		envLine("2026-11-15T14:00:00Z", "session_meta", map[string]any{"id": sid, "parent_thread_id": "parent-1"}),
		envLine("2026-11-15T14:00:01Z", "response_item", map[string]any{
			"type": "message", "role": "user",
			"content": []map[string]string{{"type": "input_text", "text": "explore"}},
		}),
		envLine("2026-11-15T14:00:02Z", "response_item", map[string]any{
			"type": "message", "role": "assistant",
			"content": []map[string]string{{"type": "output_text", "text": "ok"}},
		}),
	)
	st := newCodexStore(users, 0)
	rows, err := st.rows("codex-dev", "", "", 5)
	if err != nil || len(rows) != 1 {
		t.Fatalf("%v %d", err, len(rows))
	}
	var d map[string]any
	_ = json.Unmarshal([]byte(rows[0].Data), &d)
	sys := d["request"].(map[string]any)["system"].(string)
	if !strings.Contains(sys, "You are a Codex subagent of session parent-1") {
		t.Fatalf("system %q", sys)
	}
}
