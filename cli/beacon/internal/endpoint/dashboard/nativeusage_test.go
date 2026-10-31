package dashboard

import (
	"context"
	"database/sql"
	"encoding/json"
	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/tokens"
	"path/filepath"
	"testing"
	"time"
)

func nativeFixture(t *testing.T) *nativeUsageSource {
	t.Helper()
	path := filepath.Join(t.TempDir(), "db.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, q := range []string{`CREATE TABLE session(id TEXT,title TEXT,parent_id TEXT,directory TEXT,time_deleted INTEGER)`, `INSERT INTO session VALUES('s','Fixture','','project',NULL)`, `CREATE TABLE model_usage(id TEXT,session_id TEXT,model_id TEXT,status TEXT,task_type TEXT,agent TEXT,logical_request_id TEXT,attempt_index INTEGER,completed_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,cache_creation_input_tokens INTEGER,reasoning_tokens INTEGER,duration_ms INTEGER,time_to_first_token_ms INTEGER,provider_total_tokens INTEGER)`, `INSERT INTO model_usage VALUES('r','s','GLM-5.3','completed','interactive','zcode-agent','logical',0,1793318400000,100,20,60,0,10,1000,200,120)`} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	return &nativeUsageSource{enabled: true, dbPath: path, importPath: filepath.Join(t.TempDir(), "import.json")}
}
func TestNativeZCodeNormalizeAndRefresh(t *testing.T) {
	source := nativeFixture(t)
	rows, warnings := source.read(context.Background())
	if len(rows) != 1 || len(warnings) > 0 {
		t.Fatal(len(rows), warnings)
	}
	report := tokens.AggregateScopedWithContexts(nativeEvents(rows, EventQuery{}), nil, "", tokens.Options{})
	if report.Totals.InputTokens != 40 || report.Totals.TotalTokens() != 120 || report.Totals.ReasoningOutputTokens != 10 {
		t.Fatal(report.Totals)
	}
	if rows[0].Model != "glm-5.3" || len(report.ByAgentModel) != 1 || len(report.ByAgentProject) != 1 {
		t.Fatal("missing normalized cross dimensions")
	}
	source.lastRead = time.Time{}
	rows, _ = source.read(context.Background())
	if len(rows) != 1 {
		t.Fatal("duplicate rows")
	}
	db, err := sql.Open("sqlite", source.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE model_usage SET input_tokens=200,completed_at=completed_at+1000`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	source.lastRead = time.Time{}
	rows, _ = source.read(context.Background())
	if len(rows) != 1 || rows[0].Input != 140 {
		t.Fatal("correction not replaced")
	}
	if len(nativeEvents(rows, EventQuery{Harness: "cursor"})) != 0 || len(nativeEvents(rows, EventQuery{Session: "zcode:s"})) != 1 {
		t.Fatal("scope leaked")
	}
}
func TestNativeSchemaFailureVisible(t *testing.T) {
	source := nativeFixture(t)
	db, err := sql.Open("sqlite", source.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DROP TABLE model_usage`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	rows, warnings := source.read(context.Background())
	if len(rows) > 0 || len(warnings) == 0 {
		t.Fatal("schema failure hidden")
	}
}
func TestGrokImportValidation(t *testing.T) {
	row := nativeUsageRow{ID: "r", Session: "s", Completed: 1793318400000, Input: 100, Output: 20, Status: "completed"}
	payload := func(rows []nativeUsageRow) []byte {
		data, err := json.Marshal(map[string]interface{}{"version": 1, "rows": rows})
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	rows, err := parseGrokImport(payload([]nativeUsageRow{row}))
	if err != nil || rows[0].Harness != "grok_bot" || rows[0].Session != "grok_bot:s" {
		t.Fatal(err)
	}
	if _, err := parseGrokImport(payload([]nativeUsageRow{row, row})); err == nil {
		t.Fatal("duplicate ID accepted")
	}
	row.Input = -1
	if _, err := parseGrokImport(payload([]nativeUsageRow{row})); err == nil {
		t.Fatal("negative usage accepted")
	}
}
func TestNativeRequestDimensions(t *testing.T) {
	rows := []nativeUsageRow{{ID: "a", Harness: "zcode", Session: "zcode:s", UsageKnown: true, Input: 10, Output: 1, Completed: 1793318400000, Task: "interactive", Status: "completed"}, {ID: "b", Harness: "zcode", Session: "zcode:child", UsageKnown: true, Input: 20, Output: 2, Attempt: 1, Completed: 1793318400001, Task: "subagent_child", Status: "error"}}
	report := summarizeNative(rows, nil, EventQuery{})
	if len(report.Groups["task"]) != 2 || len(report.Groups["outcome"]) != 2 || len(report.Groups["retry"]) != 2 {
		t.Fatal(report.Groups)
	}
	if tokens.AggregateScopedWithContexts(nativeEvents(rows, EventQuery{}), nil, "", tokens.Options{}).Totals.TotalTokens() != 33 {
		t.Fatal("double counted")
	}
}
