package dashboard

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func newCursorFixture(t *testing.T) *cursorSource {
	t.Helper()
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "state.vscdb"))
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatalf("create table: %v", err)
	}
	seed := []struct {
		key   string
		value string
	}{
		{"composerData:c1", `{"composerId":"c1","fullConversationHeadersOnly":[{"bubbleId":"b1"},{"bubbleId":"b2"}]}`},
		// Assistant turn with model and context occupancy; timestamp via RFC3339.
		{"bubbleId:b1", `{"bubbleId":"b1","createdAt":"2026-10-31T01:43:13.536Z","modelInfo":{"modelName":"Grok-4.7"},"tokensUsed":29943,"tokenLimit":256000,"tokenCount":{"inputTokens":0,"outputTokens":0}}`},
		// User turn without model evidence: skipped.
		{"bubbleId:b2", `{"bubbleId":"b2","createdAt":"2026-10-31T01:44:00.000Z","text":"hello"}`},
		// Malformed payload: skipped.
		{"bubbleId:b3", `{not json`},
		// Assistant turn outside any composer: unattributed session, timestamp fallback.
		{"bubbleId:b4", `{"bubbleId":"b4","startedAtMs":1793417977695,"modelInfo":{"modelName":"claude-4.5"},"tokensUsed":12000}`},
	}
	for _, item := range seed {
		if _, err := db.Exec(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`, item.key, item.value); err != nil {
			t.Fatalf("seed %s: %v", item.key, err)
		}
	}
	return &cursorSource{dbPath: filepath.Join(dir, "state.vscdb"), rows: map[string]nativeUsageRow{}}
}

func TestCursorSourceReadsContextEvidence(t *testing.T) {
	source := newCursorFixture(t)
	if err := source.scan(context.Background()); err != nil {
		t.Fatalf("scan: %v", err)
	}
	rows, err := source.status()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("row count = %d, want 2 (assistant turns only)", len(rows))
	}
	byID := map[string]nativeUsageRow{}
	for _, row := range rows {
		byID[row.ID] = row
	}
	first, ok := byID["cursor:b1"]
	if !ok {
		t.Fatalf("bubble b1 missing from rows: %v", byID)
	}
	if first.Model != "grok-4.7" {
		t.Fatalf("model = %q, want lowercased grok-4.7", first.Model)
	}
	if first.Session != "cursor:c1" {
		t.Fatalf("session = %q, want cursor:c1", first.Session)
	}
	if first.Status != "context_recorded" || first.UsageKnown {
		t.Fatalf("status/usage = %q/%v, want context_recorded/false", first.Status, first.UsageKnown)
	}
	if first.ContextTokens != 29943 || first.ContextLimit != 256000 {
		t.Fatalf("context = %d/%d, want 29943/256000", first.ContextTokens, first.ContextLimit)
	}
	want := time.Date(2026, 10, 31, 1, 43, 13, 536000000, time.UTC).UnixMilli()
	if first.Completed != want {
		t.Fatalf("completed = %d, want %d", first.Completed, want)
	}
	if _, ok := byID["cursor:b2"]; ok {
		t.Fatal("user bubble b2 must not become context evidence")
	}
	unattributed, ok := byID["cursor:b4"]
	if !ok {
		t.Fatalf("bubble b4 missing from rows")
	}
	if unattributed.Session != "cursor:unattributed" {
		t.Fatalf("unattributed session = %q", unattributed.Session)
	}
	if unattributed.Completed != 1793417977695 {
		t.Fatalf("startedAtMs fallback = %d", unattributed.Completed)
	}
}

func TestCursorSourceIncrementalReadIsIdempotent(t *testing.T) {
	source := newCursorFixture(t)
	if err := source.scan(context.Background()); err != nil {
		t.Fatalf("first scan: %v", err)
	}
	again, err := source.status()
	if err != nil {
		t.Fatalf("first status: %v", err)
	}
	if len(again) != 2 {
		t.Fatalf("refold changed row count: %d", len(again))
	}
	db, err := sql.Open("sqlite", source.dbPath)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO cursorDiskKV (key, value) VALUES ('bubbleId:b5', '{"bubbleId":"b5","createdAt":"2026-10-31T02:00:00.000Z","modelInfo":{"modelName":"gpt-6.1"},"tokensUsed":5000}')`); err != nil {
		t.Fatalf("insert b5: %v", err)
	}
	if err := source.scan(context.Background()); err != nil {
		t.Fatalf("second scan: %v", err)
	}
	third, err := source.status()
	if err != nil {
		t.Fatalf("second status: %v", err)
	}
	if len(third) != 3 {
		t.Fatalf("row count after insert = %d, want 3", len(third))
	}
}

func TestCursorContextEvidenceAggregation(t *testing.T) {
	rows := []nativeUsageRow{
		{ID: "c1", Harness: "cursor", Session: "s1", Model: "grok-4.7", Status: "context_recorded", Unit: "request", Attempt: -1, Completed: 1793417977695, ContextTokens: 29943, ContextLimit: 256000},
		{ID: "c2", Harness: "cursor", Session: "s2", Model: "claude-4.5", Status: "context_recorded", Unit: "request", Attempt: -1, Completed: 1793504000000, ContextTokens: 12000, ContextLimit: 200000},
		// Doubao activity rows never appear as context evidence.
		{ID: "d1", Harness: "doubao_work", Status: "activity_only", Unit: "activity", Completed: 1793504000000},
	}
	query := EventQuery{Since: time.UnixMilli(1793417977000)}
	evidence := cursorContextEvidence(rows, query)
	if len(evidence) != 1 {
		t.Fatalf("evidence groups = %d, want 1", len(evidence))
	}
	entry := evidence[0]
	if entry.Harness != "cursor" || entry.Requests != 2 || entry.Sessions != 2 {
		t.Fatalf("entry = %+v", entry)
	}
	if entry.Models["grok-4.7"] != 1 || entry.Models["claude-4.5"] != 1 {
		t.Fatalf("models = %+v", entry.Models)
	}
	if entry.ContextTokens != 41943 || entry.ContextLimit != 256000 {
		t.Fatalf("context totals = %d/%d", entry.ContextTokens, entry.ContextLimit)
	}
	// A query window before all rows yields no evidence.
	empty := cursorContextEvidence(rows, EventQuery{Until: time.UnixMilli(1000)})
	if len(empty) != 0 {
		t.Fatalf("empty window returned %d groups", len(empty))
	}
}
