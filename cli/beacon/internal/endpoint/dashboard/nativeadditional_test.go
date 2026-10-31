package dashboard

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/endpoint/schema"
	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/tokens"
)

func TestWorkBuddyRequestIdentityAndCache(t *testing.T) {
	data := []byte(`{"id":"item-a","sessionId":"session","timestamp":1793318400000,"message":{"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":60}},"providerData":{"messageId":"response-1","conversationRequestId":"turn","model":"deepseek-v4.1-flash","usage":{"outputTokensDetails":[{"reasoning_tokens":10}]}}}`)
	row, ok, err := parseWorkBuddyLine(data)
	if err != nil || !ok {
		t.Fatal(err)
	}
	if row.Input != 40 || row.CacheRead != 60 || row.Reasoning != 10 || row.Attempt != -1 {
		t.Fatal(row)
	}
	report := tokens.AggregateScopedWithContexts(nativeEvents([]nativeUsageRow{row}, EventQuery{}), nil, "", tokens.Options{})
	if report.Totals.TotalTokens() != 120 {
		t.Fatal(report.Totals)
	}
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, append(append(data, '\n'), append(data, '\n')...), 0600); err != nil {
		t.Fatal(err)
	}
	rows, err := readWorkBuddy(context.Background(), path)
	if err != nil || len(rows) != 1 {
		t.Fatalf("duplicate request rows: %d %v", len(rows), err)
	}
}
func TestWorkBuddyMissingAndInvalidUsage(t *testing.T) {
	if _, ok, err := parseWorkBuddyLine([]byte(`{"type":"function_call_result","content":"not retained"}`)); err != nil || ok {
		t.Fatal("non usage record included")
	}
	if _, _, err := parseWorkBuddyLine([]byte(`{"sessionId":"s","message":{"usage":{"input_tokens":2,"output_tokens":1,"cache_read_input_tokens":3}}}`)); err == nil {
		t.Fatal("invalid disjoint usage accepted")
	}
}
func TestNativeSourceAuthorityAvoidsDoubleCounting(t *testing.T) {
	row := nativeUsageRow{UsageKnown: true, ID: "r", Harness: "deepseek_harness", Session: "s", Completed: 1793318400000, Input: 10, Output: 2, Attempt: -1}
	events := nativeEvents([]nativeUsageRow{row}, EventQuery{})
	audit := schema.NewEvent(schema.NewEventOptions{Action: "command.executed", Harness: schema.HarnessInfo{Name: "deepseek_harness"}})
	audit.Session = &schema.SessionInfo{ID: "s"}
	merged := mergeNativeEvents(append(events, audit), events)
	if len(merged) != 2 {
		t.Fatal("audit activity lost or usage duplicated")
	}
	report := tokens.AggregateScopedWithContexts(merged, nil, "", tokens.Options{})
	if report.Totals.TotalTokens() != 12 {
		t.Fatal(report.Totals)
	}
	converted, ok := nativeRowFromEvent(events[0])
	if !ok || converted.Input != 10 || converted.Attempt != -1 {
		t.Fatal("DeepSeek event mapping failed")
	}
}
