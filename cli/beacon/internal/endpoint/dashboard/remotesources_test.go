package dashboard

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestRemoteSourceStorePersistsAndRedacts(t *testing.T) {
	dir := t.TempDir()
	store := &remoteSourceStore{path: filepath.Join(dir, "remote-sources.json")}
	entry, err := store.add("lab box", "http://192.168.1.20:8765", "tok-1")
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if entry.Token != "tok-1" {
		t.Fatalf("entry token = %q", entry.Token)
	}
	redacted := entry.redacted()
	if _, ok := redacted["token"]; ok {
		t.Fatal("redacted entry must not carry the token")
	}
	reloaded := &remoteSourceStore{path: store.path}
	list := reloaded.list()
	if len(list) != 1 || list[0].Token != "tok-1" {
		t.Fatalf("reloaded = %+v", list)
	}
	if !reloaded.remove(entry.ID) {
		t.Fatal("remove failed")
	}
	if len(reloaded.list()) != 0 {
		t.Fatal("remove did not persist")
	}
}

func TestRemoteSourceAddValidatesURL(t *testing.T) {
	store := &remoteSourceStore{}
	for _, bad := range []string{"", "ftp://x", "http://", "not a url"} {
		if _, err := store.add("n", bad, "t"); err == nil {
			t.Fatalf("add(%q) unexpectedly succeeded", bad)
		}
	}
}

// The registry endpoints must never echo the stored token back to the browser.
func TestRemoteSourcesHandlersRedactToken(t *testing.T) {
	store := &remoteSourceStore{}
	handler, err := Handler(Options{LogPath: filepath.Join(t.TempDir(), "runtime.jsonl"), RemoteSources: store})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/remote-sources",
		strings.NewReader(`{"name":"lab","url":"http://127.0.0.1:1","token":"sekrit"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST = %d: %s", rec.Code, rec.Body.String())
	}
	var added map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &added); err != nil {
		t.Fatalf("decode add response: %v", err)
	}
	if _, ok := added["token"]; ok {
		t.Fatal("add response leaked the token")
	}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/remote-sources", nil))
	if strings.Contains(rec.Body.String(), "sekrit") {
		t.Fatal("list response leaked the token")
	}
	var list struct {
		Sources []map[string]interface{} `json:"sources"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.Sources) != 1 || list.Sources[0]["has_token"] != true {
		t.Fatalf("list = %+v", list.Sources)
	}
}

// Remote exposure (RemoteToken): token-gated and frozen to read-only.
func TestRemoteAccessGate(t *testing.T) {
	store := &remoteSourceStore{}
	handler, err := Handler(Options{RemoteToken: "s3cret", LogPath: filepath.Join(t.TempDir(), "runtime.jsonl"), RemoteSources: store})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/status", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET without token = %d, want 401", rec.Code)
	}
	rec = httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	request.Header.Set("X-Beacon-Token", "wrong")
	handler.ServeHTTP(rec, request)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET with wrong token = %d, want 401", rec.Code)
	}
	rec = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/status", nil)
	request.Header.Set("X-Beacon-Token", "s3cret")
	handler.ServeHTTP(rec, request)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET with token = %d, want 200", rec.Code)
	}
	// Remote mode is read-only: even an authenticated mutation is refused.
	rec = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/remote-sources", strings.NewReader(`{}`))
	request.Header.Set("X-Beacon-Token", "s3cret")
	handler.ServeHTTP(rec, request)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("POST with token = %d, want 403", rec.Code)
	}
	// The one-time ?token= query sets the cookie so the remote's own browser UI
	// keeps working without headers.
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/status?token=s3cret", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET with query token = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Header().Get("Set-Cookie"), "beacon_remote_token=s3cret") {
		t.Fatalf("query token did not set the cookie: %q", rec.Header().Get("Set-Cookie"))
	}
}

// The local viewer proxies /api/summary to the remote with the stored token.
func TestRemoteSummaryProxySendsStoredToken(t *testing.T) {
	var gotToken string
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Beacon-Token")
		if r.URL.Path != "/api/summary" {
			t.Errorf("remote path = %q", r.URL.Path)
		}
		// A real beacon rejects requests whose token does not match.
		if gotToken != "tok-9" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"active_sessions": 3, "total_events": 100}`))
	}))
	defer remote.Close()
	store := &remoteSourceStore{}
	handler, err := Handler(Options{LogPath: filepath.Join(t.TempDir(), "runtime.jsonl"), RemoteSources: store})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/remote-sources",
		strings.NewReader(`{"name":"lab","url":"`+remote.URL+`","token":"tok-9"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("add = %d: %s", rec.Code, rec.Body.String())
	}
	var added struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &added); err != nil {
		t.Fatalf("decode add: %v", err)
	}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/remote-sources/"+added.ID+"/summary", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("summary = %d: %s", rec.Code, rec.Body.String())
	}
	if gotToken != "tok-9" {
		t.Fatalf("proxied token = %q, want tok-9", gotToken)
	}
	var summary map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	if summary["active_sessions"] != float64(3) {
		t.Fatalf("summary = %+v", summary)
	}
	// A wrong stored token surfaces as an explicit upstream rejection.
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/remote-sources",
		strings.NewReader(`{"name":"bad","url":"`+remote.URL+`","token":"nope"}`)))
	var bad struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &bad)
	_ = store
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/remote-sources/"+bad.ID+"/summary", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("summary with bad token = %d, want 502", rec.Code)
	}
}
