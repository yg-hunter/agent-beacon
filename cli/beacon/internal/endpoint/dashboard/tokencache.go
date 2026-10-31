package dashboard

import (
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/tokens"
)

// A single immutable report bounds memory and is shared only while its source files,
// query and pricing overrides are unchanged. Failures are never cached.
type tokenReportCache struct {
	mu      sync.Mutex
	key     string
	expires time.Time
	report  tokens.Report
}

func tokenSourceKey(query string, paths ...string) (string, error) {
	key := query
	for _, path := range paths {
		info, err := os.Stat(path)
		if os.IsNotExist(err) {
			key += "\x00" + path + ":missing"
			continue
		}
		if err != nil {
			return "", err
		}
		key += fmt.Sprintf("\x00%s:%d:%d", path, info.Size(), info.ModTime().UnixNano())
	}
	return key, nil
}

func (cache *tokenReportCache) load(query string, paths []string, build func() (tokens.Report, error)) (tokens.Report, error) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	key, keyErr := tokenSourceKey(query, paths...)
	if keyErr == nil && cache.key == key && time.Now().Before(cache.expires) {
		return cache.report, nil
	}
	report, err := build()
	if err != nil {
		return tokens.Report{}, err
	}
	after, afterErr := tokenSourceKey(query, paths...)
	if keyErr == nil && afterErr == nil && after == key {
		cache.key = key
		cache.report = report
		cache.expires = time.Now().Add(30 * time.Second)
	}
	return report, nil
}
