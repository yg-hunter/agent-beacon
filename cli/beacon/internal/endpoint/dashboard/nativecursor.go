package dashboard

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/sqliteuri"
	_ "modernc.org/sqlite"
)

// Cursor keeps agent conversations and per-message metadata in its global
// state.vscdb (SQLite). Local bubbles carry the responding model and a context
// occupancy estimate, but billing-shaped token counts are zeroed locally: they
// are accounted on Cursor's servers. Rows are therefore context evidence with
// UsageKnown=false -- they must never contribute token totals.
//
// The database can weigh multiple gigabytes, so the first full pass runs in a
// background goroutine (foreground requests never wait on it) and later passes
// fold only rows above an overlapped rowid watermark.
type cursorSource struct {
	mu          sync.Mutex
	dbPath      string
	rows        map[string]nativeUsageRow
	watermark   int64
	scanned     bool
	scanRunning bool
	scanErr     error
	lastAttempt time.Time
}

// Rowids can be reused after Cursor deletes old chats, so each pass overlaps
// the previous watermark; the ID-keyed row map makes refolds idempotent.
const (
	cursorWatermarkOverlap = 50000
	cursorScanBudget       = 300 * time.Second
	cursorRetryCooldown    = 60 * time.Second
)

func defaultCursorSource() *cursorSource {
	configDir, err := os.UserConfigDir()
	if err != nil || configDir == "" {
		return &cursorSource{}
	}
	return &cursorSource{
		dbPath: filepath.Join(configDir, "Cursor", "User", "globalStorage", "state.vscdb"),
		rows:   map[string]nativeUsageRow{},
	}
}

// warm kicks off the initial scan in the background when needed. Absence of
// the database is resolved quietly: Cursor not being installed is not an error.
func (source *cursorSource) warm() {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.scanned || source.scanRunning {
		return
	}
	if !source.lastAttempt.IsZero() && time.Since(source.lastAttempt) < cursorRetryCooldown {
		return
	}
	if _, err := os.Stat(source.dbPath); err != nil {
		source.scanned = true
		return
	}
	source.scanRunning = true
	source.lastAttempt = time.Now()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), cursorScanBudget)
		defer cancel()
		err := source.scan(ctx)
		source.mu.Lock()
		source.scanRunning = false
		source.scanErr = err
		if err == nil {
			source.scanned = true
		}
		source.mu.Unlock()
	}()
}

// status returns the current context rows plus the scan error, if the last
// attempt failed. During warm-up the row list is simply empty.
func (source *cursorSource) status() ([]nativeUsageRow, error) {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.scanErr != nil && !source.scanned {
		return nil, source.scanErr
	}
	out := make([]nativeUsageRow, 0, len(source.rows))
	for _, row := range source.rows {
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Completed == out[j].Completed {
			return out[i].ID < out[j].ID
		}
		return out[i].Completed < out[j].Completed
	})
	return out, nil
}

// scan folds message bubbles into context-evidence rows: the first pass covers
// the whole key space, later passes only rows above the overlapped watermark.
func (source *cursorSource) scan(ctx context.Context) error {
	db, err := sql.Open("sqlite", sqliteuri.File(source.dbPath, url.Values{"mode": {"ro"}, "_pragma": {"busy_timeout(2000)"}}))
	if err != nil {
		return fmt.Errorf("unsupported or unreadable usage schema: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	since := source.watermark - cursorWatermarkOverlap
	if since < 0 {
		since = 0
	}
	rows, err := db.QueryContext(ctx, "SELECT rowid, key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND rowid > ? ORDER BY rowid", since)
	if err != nil {
		return fmt.Errorf("unsupported or unreadable usage schema: %w", err)
	}
	defer rows.Close()
	// Drain the bubble query before opening the composer query: the pool holds
	// a single connection, so interleaved iterators would deadlock.
	type rawBubble struct {
		rowid int64
		key   string
		value string
	}
	var raw []rawBubble
	for rows.Next() {
		var bubble rawBubble
		if err := rows.Scan(&bubble.rowid, &bubble.key, &bubble.value); err != nil {
			return err
		}
		raw = append(raw, bubble)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	sessions := source.composerSessions(db)
	for index, bubble := range raw {
		// The initial pass walks gigabytes; yield periodically so concurrent
		// native readers keep their latency budget on the same disk.
		if index%20000 == 19999 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(50 * time.Millisecond):
			}
		}
		if bubble.rowid > source.watermark {
			source.watermark = bubble.rowid
		}
		// Cheap prefilter: assistant turns embed modelInfo; user notes do not.
		if !strings.Contains(bubble.value, `"modelInfo"`) {
			continue
		}
		row, err := parseCursorBubble(bubble.value, sessions)
		if err != nil {
			continue
		}
		source.rows[row.ID] = row
	}
	return nil
}

// composerSessions maps bubble ids to their conversation so context rows can
// carry a session identity without joining per request.
func (source *cursorSource) composerSessions(db *sql.DB) map[string]string {
	sessions := map[string]string{}
	composers, err := db.QueryContext(context.Background(), "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
	if err != nil {
		return sessions
	}
	defer composers.Close()
	for composers.Next() {
		var key, value string
		if err := composers.Scan(&key, &value); err != nil {
			continue
		}
		var composer struct {
			ComposerID string `json:"composerId"`
			Headers    []struct {
				BubbleID string `json:"bubbleId"`
			} `json:"fullConversationHeadersOnly"`
		}
		if json.Unmarshal([]byte(value), &composer) != nil {
			continue
		}
		session := "cursor:" + composer.ComposerID
		if composer.ComposerID == "" {
			session = "cursor:" + strings.TrimPrefix(key, "composerData:")
		}
		for _, header := range composer.Headers {
			if header.BubbleID != "" {
				sessions[header.BubbleID] = session
			}
		}
	}
	return sessions
}

type cursorBubble struct {
	BubbleID    string `json:"bubbleId"`
	CreatedAt   string `json:"createdAt"`
	StartedAtMs int64  `json:"startedAtMs"`
	ModelInfo   struct {
		ModelName string `json:"modelName"`
	} `json:"modelInfo"`
	TokensUsed int64 `json:"tokensUsed"`
	TokenLimit int64 `json:"tokenLimit"`
}

func parseCursorBubble(value string, sessions map[string]string) (nativeUsageRow, error) {
	var bubble cursorBubble
	if err := json.Unmarshal([]byte(value), &bubble); err != nil {
		return nativeUsageRow{}, err
	}
	if bubble.BubbleID == "" {
		return nativeUsageRow{}, errors.New("bubble id missing")
	}
	model := strings.ToLower(strings.TrimSpace(bubble.ModelInfo.ModelName))
	if model == "" && bubble.TokensUsed <= 0 {
		return nativeUsageRow{}, errors.New("no model or context evidence in bubble")
	}
	completed := int64(0)
	if stamp, err := time.Parse(time.RFC3339Nano, bubble.CreatedAt); err == nil {
		completed = stamp.UnixMilli()
	} else if bubble.StartedAtMs > 0 {
		completed = bubble.StartedAtMs
	}
	if completed <= 0 {
		return nativeUsageRow{}, errors.New("no usable timestamp in bubble")
	}
	session := sessions[bubble.BubbleID]
	if session == "" {
		session = "cursor:unattributed"
	}
	return nativeUsageRow{
		ID:            "cursor:" + bubble.BubbleID,
		Harness:       "cursor",
		Session:       session,
		Model:         model,
		Status:        "context_recorded",
		Unit:          "request",
		Attempt:       -1,
		Completed:     completed,
		UsageKnown:    false,
		ContextTokens: bubble.TokensUsed,
		ContextLimit:  bubble.TokenLimit,
	}, nil
}
