package dashboard

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestNativeImportHTTPBoundary(t *testing.T) {
	dir := t.TempDir()
	handler, err := Handler(Options{LogPath: filepath.Join(dir, "runtime.jsonl"), NativeUsage: true})
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"version":1,"rows":[{"id":"fixture","session":"s","status":"completed","completed_at_ms":1793318400000,"fresh_input_tokens":1,"output_tokens":2,"cache_read_tokens":0,"cache_write_tokens":0}]}`)
	for _, origin := range []string{"https://external.invalid", "http://127.0.0.1:8765"} {
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8765/api/native-usage/import", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if origin == "https://external.invalid" && response.Code != 403 {
			t.Fatal("cross origin accepted")
		}
		if origin == "http://127.0.0.1:8765" && response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	saved, err := os.ReadFile(filepath.Join(dir, "grok-bot-usage.json"))
	if err != nil {
		t.Fatal(err)
	}
	rows, err := parseGrokImport(saved)
	if err != nil || len(rows) != 1 || rows[0].Attempt != -1 {
		t.Fatal(err)
	}
	if _, err := parseGrokImport([]byte(`{"version":1,"rows":[{"id":"x","session":"s","status":"completed","completed_at_ms":1}]}`)); err == nil {
		t.Fatal("missing usage accepted as zero")
	}
	invalid := []byte(`{"version":1,"rows":[{"id":"x","session":"s","status":"completed","completed_at_ms":1}]}`)
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8765/api/native-usage/import", bytes.NewReader(invalid))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://127.0.0.1:8765")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid import accepted: %d", response.Code)
	}
	after, err := os.ReadFile(filepath.Join(dir, "grok-bot-usage.json"))
	if err != nil || !bytes.Equal(after, saved) {
		t.Fatalf("rejected import changed saved snapshot: %v", err)
	}
}
