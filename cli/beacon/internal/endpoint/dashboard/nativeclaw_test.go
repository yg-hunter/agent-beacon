package dashboard

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/tokens"
)

func writeClawFixture(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestClawLegacyDisjointUsageAndCompanionExclusion(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".openclaw-autoclaw", "agents", "main", "sessions", "session.jsonl")
	text := `{"type":"session","cwd":"project"}
{"type":"message","id":"response","timestamp":"2026-10-28T02:04:15.037Z","message":{"role":"assistant","model":"zai_auto","usage":{"input":10,"output":3,"cacheRead":20,"cacheWrite":2,"reasoningTokens":1,"totalTokens":35}}}
`
	writeClawFixture(t, path, text+text) // A replay must not duplicate usage.
	writeClawFixture(t, filepath.Join(filepath.Dir(path), "session.trajectory.jsonl"), text)
	source := &nativeUsageSource{nativeHome: home}
	for i := 0; i < 2; i++ {
		rows, warnings := source.readAdditional(context.Background())
		if len(warnings) != 0 || len(rows) != 1 {
			t.Fatalf("rows=%d warnings=%v", len(rows), warnings)
		}
		row := rows[0]
		if row.Input != 10 || row.CacheRead != 20 || row.Project != "project" || row.Unit != "request" || row.Agent != "main" {
			t.Fatal(row)
		}
		report := tokens.AggregateScopedWithContexts(nativeEvents(rows, EventQuery{}), nil, "", tokens.Options{})
		if report.Totals.TotalTokens() != 35 {
			t.Fatal(report.Totals)
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	rows, _ := source.readAdditional(context.Background())
	if len(rows) != 0 {
		t.Fatal("deleted source retained")
	}
}

func TestClawRunSnapshotReplacesInsteadOfAccumulating(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "AppData", "Roaming", "AutoClaw-official", "accounts", "fixture", "runtime", "runtime.sqlite")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, query := range []string{
		`PRAGMA journal_mode=WAL`,
		`CREATE TABLE work_sessions(session_id TEXT,title TEXT)`,
		`INSERT INTO work_sessions VALUES('session','Run fixture')`,
		`CREATE TABLE work_runs(run_id TEXT,session_id TEXT,status TEXT,connection_model TEXT,workspace_root TEXT,updated_at TEXT,usage_json TEXT,merged_into_run_id TEXT)`,
		`INSERT INTO work_runs VALUES('run','session','completed','model','project','2026-10-28T02:04:15.037Z','{"input":10,"output":3,"cacheRead":20,"cacheWrite":2,"totalTokens":35,"llmMs":1000,"ttftMs":200,"ttftSteps":4}',NULL)`,
		`CREATE TABLE neutral_session_entries(payload TEXT)`,
		`INSERT INTO neutral_session_entries VALUES('{"data":{"usage":{"input":9999,"output":9999}}}')`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	source := &nativeUsageSource{nativeHome: home}
	rows, warnings := source.readAdditional(context.Background())
	if len(rows) != 1 || len(warnings) != 0 || rows[0].Unit != "run" || rows[0].Title != "Run fixture" {
		t.Fatal(rows, warnings)
	}
	id := rows[0].ID
	report := tokens.AggregateScopedWithContexts(nativeEvents(rows, EventQuery{}), nil, "", tokens.Options{})
	if report.Totals.TotalTokens() != 35 || len(report.Utilization) != 0 {
		t.Fatal("run usage lost or mistaken for one context window", report)
	}
	if _, err := db.Exec(`UPDATE work_runs SET usage_json='{"input":11,"output":3,"cacheRead":20,"cacheWrite":2,"totalTokens":36}'`); err != nil {
		t.Fatal(err)
	}
	rows, warnings = source.readAdditional(context.Background())
	if len(rows) != 1 || len(warnings) != 0 || rows[0].ID != id || rows[0].Input != 11 {
		t.Fatal("WAL snapshot correction lost", rows, warnings)
	}
	// Even if a future decoder populates cumulative latency, run data must not
	// pollute request latency denominators.
	rows[0].Duration, rows[0].TTFT = 1000, 200
	summary := summarizeNative(rows, nil, EventQuery{})
	if summary.Groups["unit"][0].Key != "run" || summary.Groups["unit"][0].Tokens != 36 || summary.Groups["unit"][0].TimedRequests != 0 || summary.Groups["unit"][0].TTFTRequests != 0 {
		t.Fatal(summary.Groups)
	}
	if len(nativeEvents(rows, EventQuery{Harness: "cursor"})) != 0 {
		t.Fatal("scope leaked")
	}
}

func TestDoubaoActivityNeverFabricatesTokens(t *testing.T) {
	home := t.TempDir()
	for _, agent := range []string{"main", "worker"} {
		path := filepath.Join(home, "AppData", "Local", "DoubaoWork", "User Data", "Default", ".doubaowork", "agent_mode", "workspace", ".sessions", "task", "agents", agent, "system", "trajectory.jsonl")
		writeClawFixture(t, path, "{\"role\":\"user\",\"content\":\"private\"}\n{\"role\":\"assistant\",\"tool_calls\":[{\"id\":\"tool\"}]}\n")
	}
	source := &nativeUsageSource{nativeHome: home}
	rows, warnings := source.readAdditional(context.Background())
	if len(rows) != 2 || len(warnings) != 0 {
		t.Fatal(rows, warnings)
	}
	for _, row := range rows {
		if row.UsageKnown || row.Session != "doubao_work:Default:task" {
			t.Fatal("invalid activity identity or usage", row)
		}
	}
	events := nativeEvents(rows, EventQuery{})
	if events[0].GenAI != nil || events[0].Event.Action != "session.activity" {
		t.Fatal("activity became a model request")
	}
	report := tokens.AggregateScopedWithContexts(events, nil, "", tokens.Options{})
	if report.Totals.TotalTokens() != 0 || len(report.ByHarness) != 0 {
		t.Fatal("invented a zero-usage Agent", report.ByHarness)
	}
	summary := summarizeNative(rows, nil, EventQuery{})
	if len(summary.Activity) != 1 || len(summary.Groups) != 0 || summary.Activity[0].Sessions != 1 || summary.Activity[0].Workers != 2 || summary.Activity[0].Messages != 4 || summary.Activity[0].ToolCalls != 2 {
		t.Fatal(summary)
	}
	if len(summarizeNative(rows, nil, EventQuery{Since: time.Now().Add(time.Hour)}).Activity) != 0 {
		t.Fatal("activity time filter leaked")
	}
}

func TestClawInvalidCountersAndPartialTail(t *testing.T) {
	for _, data := range []string{
		`{"input":1,"output":2,"cacheRead":3,"totalTokens":2}`,
		`{"input":1,"output":-2}`,
		`{"input":1}`,
		`{"input":1,"output":2,"reasoningTokens":3}`,
	} {
		path := filepath.Join(t.TempDir(), "main", "sessions", "s.jsonl")
		writeClawFixture(t, path, `{"type":"message","id":"r","timestamp":"2026-10-28T02:04:15Z","message":{"role":"assistant","usage":`+data+`}}`)
		if _, err := readLegacyClaw(context.Background(), path); err == nil {
			t.Fatal("invalid usage accepted", data)
		}
	}
	path := filepath.Join(t.TempDir(), "main", "sessions", "s.jsonl")
	writeClawFixture(t, path, "{\"type\":\"message\",\"id\":\"r\",\"timestamp\":\"2026-10-28T02:04:15Z\",\"message\":{\"role\":\"assistant\",\"usage\":{\"input\":1,\"output\":2}}}\n{\"partial\":")
	rows, err := readLegacyClaw(context.Background(), path)
	if err == nil || len(rows) != 1 {
		t.Fatal("validated prefix lost or malformed tail hidden", rows, err)
	}
}
