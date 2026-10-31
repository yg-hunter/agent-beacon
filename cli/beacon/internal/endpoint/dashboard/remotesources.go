package dashboard

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Remote sources let one dashboard watch agent activity on other machines over
// the LAN. The registry lives on this machine only; tokens are held server-side
// and never sent back to the browser. Exposure on the monitored machine is
// opt-in (--remote-token), token-gated, and read-only.
type remoteSource struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	URL   string `json:"url"`
	Token string `json:"token"`
}

// redacted drops the token: list responses must never hand credentials back to
// the browser.
func (source remoteSource) redacted() map[string]interface{} {
	return map[string]interface{}{
		"id":        source.ID,
		"name":      source.Name,
		"url":       source.URL,
		"has_token": source.Token != "",
	}
}

type remoteSourceStore struct {
	mu      sync.Mutex
	path    string
	sources []remoteSource
	loaded  bool
}

const remoteSourceLimit = 20

func defaultRemoteSourceStore() *remoteSourceStore {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		// No home directory: keep the registry in memory for this run.
		return &remoteSourceStore{}
	}
	return &remoteSourceStore{path: filepath.Join(home, ".beacon", "endpoint", "remote-sources.json")}
}

func (store *remoteSourceStore) ensure() {
	if store.loaded {
		return
	}
	store.loaded = true
	if store.path == "" {
		return
	}
	data, err := os.ReadFile(store.path)
	if err != nil {
		return // missing or unreadable registry: start empty
	}
	_ = json.Unmarshal(data, &store.sources)
}

func (store *remoteSourceStore) persistLocked() error {
	if store.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(store.path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(store.sources, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(store.path, data, 0o600)
}

var errRemoteSourceURL = errors.New("source URL must be an http(s) URL with a host")

func (store *remoteSourceStore) add(name, rawURL, token string) (remoteSource, error) {
	name = strings.TrimSpace(name)
	rawURL = strings.TrimSpace(rawURL)
	token = strings.TrimSpace(token)
	if name == "" {
		name = "remote"
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return remoteSource{}, errRemoteSourceURL
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.ensure()
	if len(store.sources) >= remoteSourceLimit {
		return remoteSource{}, fmt.Errorf("at most %d remote sources are kept", remoteSourceLimit)
	}
	entry := remoteSource{
		ID:    newRemoteSourceID(),
		Name:  name,
		URL:   strings.TrimRight(rawURL, "/"),
		Token: token,
	}
	store.sources = append(store.sources, entry)
	if err := store.persistLocked(); err != nil {
		return remoteSource{}, err
	}
	return entry, nil
}

func (store *remoteSourceStore) remove(id string) bool {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.ensure()
	for index, entry := range store.sources {
		if entry.ID == id {
			store.sources = append(store.sources[:index], store.sources[index+1:]...)
			return store.persistLocked() == nil
		}
	}
	return false
}

func (store *remoteSourceStore) get(id string) (remoteSource, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.ensure()
	for _, entry := range store.sources {
		if entry.ID == id {
			return entry, true
		}
	}
	return remoteSource{}, false
}

func (store *remoteSourceStore) list() []remoteSource {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.ensure()
	out := make([]remoteSource, len(store.sources))
	copy(out, store.sources)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func newRemoteSourceID() string {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("r%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

// registerRemoteSourceRoutes wires the local-only registry endpoints. Tokens
// never appear in responses; summary data is fetched server-side per source.
func registerRemoteSourceRoutes(mux *http.ServeMux, store *remoteSourceStore) {
	mux.HandleFunc("GET /api/remote-sources", func(w http.ResponseWriter, r *http.Request) {
		redacted := make([]map[string]interface{}, 0)
		for _, entry := range store.list() {
			redacted = append(redacted, entry.redacted())
		}
		writeJSON(w, map[string]interface{}{"sources": redacted})
	})
	mux.HandleFunc("POST /api/remote-sources", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name  string `json:"name"`
			URL   string `json:"url"`
			Token string `json:"token"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, errors.New("invalid JSON body"))
			return
		}
		entry, err := store.add(body.Name, body.URL, body.Token)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, entry.redacted())
	})
	mux.HandleFunc("DELETE /api/remote-sources/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]bool{"removed": store.remove(r.PathValue("id"))})
	})
	mux.HandleFunc("GET /api/remote-sources/{id}/summary", func(w http.ResponseWriter, r *http.Request) {
		entry, ok := store.get(r.PathValue("id"))
		if !ok {
			writeError(w, http.StatusNotFound, errors.New("unknown remote source"))
			return
		}
		summary, err := fetchRemoteSummary(r.Context(), entry)
		if err != nil {
			writeError(w, http.StatusBadGateway, err)
			return
		}
		writeJSON(w, summary)
	})
}

// fetchRemoteSummary pulls /api/summary from a remote beacon with the stored
// token. Errors distinguish auth rejection from transport failure so the UI
// can say "令牌被拒绝" instead of a generic unreachable.
func fetchRemoteSummary(ctx context.Context, entry remoteSource) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	endpoint := strings.TrimRight(entry.URL, "/") + "/api/summary"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	if entry.Token != "" {
		request.Header.Set("X-Beacon-Token", entry.Token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("remote unreachable: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return nil, errors.New("remote rejected the access token")
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("remote answered %d", response.StatusCode)
	}
	var summary map[string]interface{}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&summary); err != nil {
		return nil, fmt.Errorf("remote returned invalid JSON: %w", err)
	}
	return summary, nil
}
