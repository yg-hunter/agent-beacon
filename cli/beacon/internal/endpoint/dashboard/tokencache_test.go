package dashboard

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/tokens"
)

func TestTokenCacheInvalidatesSourcesAndScope(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.jsonl")
	overrides := filepath.Join(t.TempDir(), "overrides.json")
	if err := os.WriteFile(path, []byte("initial"), 0600); err != nil {
		t.Fatal(err)
	}
	cache := &tokenReportCache{}
	calls := 0
	build := func() (tokens.Report, error) { calls++; return tokens.Report{TotalEvents: calls}, nil }
	load := func(query string) {
		t.Helper()
		if _, err := cache.load(query, []string{path, overrides}, build); err != nil {
			t.Fatal(err)
		}
	}
	load("all")
	load("all")
	if calls != 1 {
		t.Fatalf("unchanged sources: got %d builds", calls)
	}
	if err := os.WriteFile(path, []byte("appended event"), 0600); err != nil {
		t.Fatal(err)
	}
	load("all")
	if err := os.WriteFile(overrides, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	load("all")
	load("cursor")
	if calls != 4 {
		t.Fatalf("source/query invalidation: got %d builds", calls)
	}
}

func TestTokenCacheDoesNotCacheFailureOrChangesDuringRead(t *testing.T) {
	cache := &tokenReportCache{}
	path := filepath.Join(t.TempDir(), "runtime.jsonl")
	if _, err := cache.load("q", []string{path}, func() (tokens.Report, error) { return tokens.Report{}, errors.New("read failed") }); err == nil {
		t.Fatal("missing error")
	}
	calls := 0
	build := func() (tokens.Report, error) {
		calls++
		if err := os.WriteFile(path, make([]byte, calls), 0600); err != nil {
			return tokens.Report{}, err
		}
		return tokens.Report{}, nil
	}
	for range 2 {
		if _, err := cache.load("q", []string{path}, build); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 2 {
		t.Fatalf("cached changing read: %d builds", calls)
	}
}
