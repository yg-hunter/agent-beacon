package dashboard

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/endpoint/schema"
	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/sqliteuri"
	_ "modernc.org/sqlite"
)

// Native rows are disjoint usage records with an explicit unit, or activity-only
// observations. Run aggregates must not overlap request-level source records.
// Snapshots are composed with runtime telemetry, not appended to its rotating audit log.
type nativeUsageRow struct {
	Unit           string `json:"unit,omitempty"`
	Messages       int64  `json:"messages,omitempty"`
	ToolCalls      int64  `json:"tool_calls,omitempty"`
	UsageKnown     bool   `json:"usage_known"`
	ID             string `json:"id"`
	Harness        string `json:"harness"`
	Session        string `json:"session"`
	Title          string `json:"title,omitempty"`
	Parent         string `json:"parent,omitempty"`
	Project        string `json:"project,omitempty"`
	Model          string `json:"model"`
	OriginalModel  string `json:"original_model,omitempty"`
	Status         string `json:"status"`
	Task           string `json:"task,omitempty"`
	Agent          string `json:"agent,omitempty"`
	LogicalRequest string `json:"logical_request,omitempty"`
	Attempt        int64  `json:"attempt"`
	Completed      int64  `json:"completed_at_ms"`
	Input          int64  `json:"fresh_input_tokens"`
	Output         int64  `json:"output_tokens"`
	CacheRead      int64  `json:"cache_read_tokens"`
	CacheWrite     int64  `json:"cache_write_tokens"`
	Reasoning      int64  `json:"reasoning_tokens"`
	Duration       int64  `json:"duration_ms"`
	TTFT           int64  `json:"ttft_ms"`
	// Context evidence (Cursor): per-turn context occupancy against the model
	// window. Billing-shaped token counts are not stored locally, so these rows
	// keep UsageKnown=false and never enter token totals.
	ContextTokens int64 `json:"context_tokens,omitempty"`
	ContextLimit  int64 `json:"context_limit,omitempty"`
}

type nativeUsageSource struct {
	nativeHome string
	files      map[string]nativeFileSnapshot
	extraRows  []nativeUsageRow
	enabled    bool
	mu         sync.Mutex
	dbPath     string
	importPath string
	cursor     *cursorSource
	rows       map[string]nativeUsageRow
	watermark  int64
	lastRead   time.Time
	lastFull   time.Time
	warnings   []string
}

type nativeUsageSummary struct {
	Activity []nativeActivityGroup         `json:"activity"`
	Sessions []map[string]interface{}      `json:"sessions"`
	Groups   map[string][]nativeUsageGroup `json:"groups"`
	Warnings []string                      `json:"warnings"`
	Sources  []map[string]string           `json:"sources"`
	// Context evidence lists sources whose local data proves per-request model
	// and context occupancy while billing tokens stay unknown.
	Context []nativeContextEvidence `json:"context_evidence,omitempty"`
}

type nativeContextEvidence struct {
	Harness       string `json:"harness"`
	Requests      int    `json:"requests"`
	sessions      map[string]bool
	Sessions      int            `json:"sessions"`
	Models        map[string]int `json:"models"`
	ContextTokens int64          `json:"context_tokens"`
	ContextLimit  int64          `json:"context_limit"`
	LatestAt      string         `json:"latest_at"`
}

type nativeActivityGroup struct {
	Harness      string `json:"harness"`
	Sessions     int    `json:"sessions"`
	Workers      int    `json:"workers"`
	Messages     int64  `json:"messages"`
	ToolCalls    int64  `json:"tool_calls"`
	LastObserved string `json:"last_observed_at"`
}
type nativeUsageGroup struct {
	UsageRequests int    `json:"usage_requests"`
	TimedRequests int    `json:"timed_requests"`
	TTFTRequests  int    `json:"ttft_requests"`
	TTFTMS        int64  `json:"ttft_ms"`
	Key           string `json:"key"`
	Requests      int    `json:"requests"`
	Tokens        int64  `json:"tokens"`
	DurationMS    int64  `json:"duration_ms"`
}

func defaultNativeUsage(logPath string) *nativeUsageSource {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	source := &nativeUsageSource{nativeHome: home, dbPath: filepath.Join(home, ".zcode", "cli", "db", "db.sqlite"), importPath: filepath.Join(filepath.Dir(logPath), "grok-bot-usage.json")}
	source.cursor = defaultCursorSource()
	return source
}

// nativeUsageFacets counts snapshot records per harness and per model so the session
// audit page can list usage-only sources that never appear in the runtime event log.
// Counts are usage records, not sessions; callers must label them accordingly.
func nativeUsageFacets(rows []nativeUsageRow) (harnesses, models []Count) {
	harnessCounts := map[string]int{}
	modelCounts := map[string]int{}
	for _, row := range rows {
		if row.ID == "" || row.Session == "" || row.Completed <= 0 {
			continue
		}
		if row.Harness != "" {
			harnessCounts[row.Harness]++
		}
		if row.Model != "" {
			modelCounts[row.Model]++
		}
	}
	return facetCounts(harnessCounts), facetCounts(modelCounts)
}

func facetCounts(counts map[string]int) []Count {
	names := make([]string, 0, len(counts))
	for name := range counts {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]Count, 0, len(names))
	for _, name := range names {
		out = append(out, Count{Name: name, Count: counts[name]})
	}
	return out
}

func (source *nativeUsageSource) read(ctx context.Context) ([]nativeUsageRow, []string) {
	if !source.enabled {
		return nil, []string{"Native usage sources disabled; start dashboard with --native-usage"}
	}
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.rows == nil {
		source.rows = map[string]nativeUsageRow{}
	}
	if time.Since(source.lastRead) >= 15*time.Second {
		source.warnings = nil
		if _, err := os.Stat(source.dbPath); err == nil {
			if err := source.readZCode(ctx); err != nil {
				source.warnings = append(source.warnings, "ZCode: "+err.Error())
				// Do not present stale native rows as a successful refresh.
				source.rows = map[string]nativeUsageRow{}
				source.watermark = 0
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			source.warnings = append(source.warnings, "ZCode database cannot be opened")
			source.rows = map[string]nativeUsageRow{}
			source.watermark = 0
		} else {
			source.rows = map[string]nativeUsageRow{}
			source.watermark = 0
		}
		source.extraRows, source.warnings = source.collectAdditional(ctx, source.warnings)
		if source.cursor != nil {
			source.cursor.warm()
			cursorRows, cursorErr := source.cursor.status()
			if cursorErr != nil {
				source.warnings = append(source.warnings, "Cursor: "+cursorErr.Error())
			} else if len(cursorRows) > 0 {
				source.extraRows = append(source.extraRows, cursorRows...)
			}
		}
		source.lastRead = time.Now()
	}
	rows := make([]nativeUsageRow, 0, len(source.rows))
	for _, row := range source.rows {
		rows = append(rows, row)
	}
	rows = append(rows, source.extraRows...)
	warnings := append([]string{}, source.warnings...)
	data, err := readNativeImport(source.importPath)
	if err == nil {
		imported, parseErr := parseGrokImport(data)
		if parseErr != nil {
			warnings = append(warnings, "Grok Bot import: "+parseErr.Error())
		} else {
			rows = append(rows, imported...)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		warnings = append(warnings, "Grok Bot import cannot be opened")
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Completed == rows[j].Completed {
			return rows[i].ID < rows[j].ID
		}
		return rows[i].Completed < rows[j].Completed
	})
	return rows, warnings
}

func (source *nativeUsageSource) readZCode(ctx context.Context) error {
	db, err := sql.Open("sqlite", sqliteuri.File(source.dbPath, url.Values{"mode": {"ro"}, "_pragma": {"busy_timeout(2000)"}}))
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	full := source.lastFull.IsZero() || time.Since(source.lastFull) > 5*time.Minute
	since := max(int64(0), source.watermark-300000)
	if full {
		since = 0
	}
	rows, err := db.QueryContext(ctx, `SELECT u.id,u.session_id,COALESCE(s.title,''),COALESCE(s.parent_id,''),COALESCE(s.directory,''),u.model_id,u.status,COALESCE(u.task_type,''),COALESCE(u.agent,''),COALESCE(u.logical_request_id,''),COALESCE(u.attempt_index,0),u.completed_at,COALESCE(u.input_tokens,0),COALESCE(u.output_tokens,0),COALESCE(u.cache_read_input_tokens,0),COALESCE(u.cache_creation_input_tokens,0),COALESCE(u.reasoning_tokens,0),COALESCE(u.duration_ms,0),COALESCE(u.time_to_first_token_ms,0),u.provider_total_tokens IS NOT NULL FROM model_usage u LEFT JOIN session s ON s.id=u.session_id WHERE u.completed_at>=? AND u.completed_at>0 AND u.status IN ('completed','error','cancelled') AND COALESCE(s.time_deleted,0)=0`, since)
	if err != nil {
		return fmt.Errorf("unsupported or unreadable usage schema: %w", err)
	}
	defer rows.Close()
	next := make(map[string]nativeUsageRow, len(source.rows))
	if !full {
		for key, row := range source.rows {
			next[key] = row
		}
	}
	watermark := source.watermark
	for rows.Next() {
		var row nativeUsageRow
		if err := rows.Scan(&row.ID, &row.Session, &row.Title, &row.Parent, &row.Project, &row.Model, &row.Status, &row.Task, &row.Agent, &row.LogicalRequest, &row.Attempt, &row.Completed, &row.Input, &row.Output, &row.CacheRead, &row.CacheWrite, &row.Reasoning, &row.Duration, &row.TTFT, &row.UsageKnown); err != nil {
			return err
		}
		if row.Input < row.CacheRead+row.CacheWrite || row.Input < 0 || row.Output < 0 || row.CacheRead < 0 || row.CacheWrite < 0 || row.Reasoning < 0 {
			return errors.New("invalid token relationship; no totals published")
		}
		row.Input -= row.CacheRead + row.CacheWrite
		if row.Parent != "" {
			row.Parent = "zcode:" + row.Parent
		}
		row.Harness = "zcode"
		row.ID = "zcode:" + row.ID
		row.Session = "zcode:" + row.Session
		row.OriginalModel = row.Model
		row.Model = strings.ToLower(strings.TrimSpace(row.Model))
		next[row.ID] = row
		watermark = max(watermark, row.Completed)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	source.rows = next
	source.watermark = watermark
	if full {
		source.lastFull = time.Now()
	}
	return nil
}

func readNativeImport(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, 8*1024*1024+1))
}

func parseGrokImport(data []byte) ([]nativeUsageRow, error) {
	if len(data) > 8*1024*1024 {
		return nil, errors.New("file exceeds 8 MiB")
	}
	var payload struct {
		Version int              `json:"version"`
		Rows    []nativeUsageRow `json:"rows"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, errors.New("invalid JSON")
	}
	if payload.Version != 1 || len(payload.Rows) > 20000 {
		return nil, errors.New("unsupported import version or row count")
	}
	var rawPayload struct {
		Rows []map[string]json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(data, &rawPayload); err != nil {
		return nil, errors.New("invalid rows")
	}
	seen := map[string]bool{}
	for i := range payload.Rows {
		row := &payload.Rows[i]
		if _, present := rawPayload.Rows[i]["attempt"]; !present {
			row.Attempt = -1
		}
		for _, key := range []string{"fresh_input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"} {
			value, ok := rawPayload.Rows[i][key]
			if !ok || string(value) == "null" {
				return nil, fmt.Errorf("explicit %s required", key)
			}
		}
		if row.ID == "" || row.Session == "" || row.Completed <= 0 || row.Duration < 0 || row.TTFT < 0 || row.Attempt < -1 || row.Input < 0 || row.Output < 0 || row.CacheRead < 0 || row.CacheWrite < 0 || row.Reasoning < 0 || row.Input > 1e12 || row.Output > 1e12 || row.CacheRead > 1e12 || row.CacheWrite > 1e12 || row.Reasoning > row.Output || len(row.ID) > 256 || len(row.Session) > 256 || len(row.Model) > 150 || (row.Status != "completed" && row.Status != "error" && row.Status != "cancelled") {
			return nil, errors.New("invalid request identity, status, timestamp or token counts")
		}
		if seen[row.ID] {
			return nil, errors.New("duplicate request ID")
		}
		seen[row.ID] = true
		row.UsageKnown = true
		row.ID = "grok_bot:" + row.ID
		row.Session = "grok_bot:" + row.Session
		row.Harness = "grok_bot"
		row.Unit, row.Messages, row.ToolCalls = "request", 0, 0
	}
	return payload.Rows, nil
}

func nativeEvents(rows []nativeUsageRow, query EventQuery) []schema.Event {
	events := make([]schema.Event, 0, len(rows))
	for _, row := range rows {
		if row.Status == "context_recorded" {
			// Context evidence never becomes a synthetic event: coverage counts
			// and event totals must not swell with rows that carry no usage.
			continue
		}
		if query.Session != "" && row.Session != query.Session {
			continue
		}
		event := schema.NewEvent(schema.NewEventOptions{Action: "token.usage", Category: "model", Severity: schema.SeverityInfo, Origin: schema.OriginLocal, Harness: schema.HarnessInfo{Name: row.Harness, CollectionMethod: schema.CollectionMethodPoll}})
		event.Event.ID = row.ID
		event.Timestamp = schema.FormatTimestamp(time.UnixMilli(row.Completed))
		event.Model = row.Model
		event.Repository = row.Project
		event.Session = &schema.SessionInfo{ID: row.Session, WorkingDirectory: row.Project}
		event.GenAI = &schema.GenAIInfo{Request: &schema.GenAIRequestInfo{Model: row.Model}, Usage: &schema.GenAIUsageInfo{InputTokens: &row.Input, OutputTokens: &row.Output, CacheRead: &schema.GenAIUsageCacheReadInfo{InputTokens: &row.CacheRead}, CacheCreation: &schema.GenAIUsageCacheCreationInfo{InputTokens: &row.CacheWrite}, Reasoning: &schema.GenAIUsageReasoningInfo{OutputTokens: &row.Reasoning}}}
		if row.Unit == "run" {
			event.Event.Action = "token.usage.run"
		}
		if !row.UsageKnown {
			event.GenAI.Usage = nil
			event.Event.Action = "model.request"
		}
		if row.Unit == "activity" {
			event.GenAI = nil
			event.Event.Action = "session.activity"
			event.Event.Category = "session"
		}
		if matchesQuery(EventRecord{Event: event, Parsed: time.UnixMilli(row.Completed)}, query) {
			events = append(events, event)
		}
	}
	return events
}

// cursorContextEvidence aggregates context-only rows (Cursor) per harness.
// Rows honor the same query window as nativeEvents so a filtered dashboard
// never reports evidence outside the selected range.
func cursorContextEvidence(rows []nativeUsageRow, query EventQuery) []nativeContextEvidence {
	index := map[string]*nativeContextEvidence{}
	for _, row := range rows {
		if row.Status != "context_recorded" {
			continue
		}
		event := schema.NewEvent(schema.NewEventOptions{Action: "model.request", Category: "model", Origin: schema.OriginLocal, Harness: schema.HarnessInfo{Name: row.Harness}})
		event.Event.ID = row.ID
		event.Model = row.Model
		if !matchesQuery(EventRecord{Event: event, Parsed: time.UnixMilli(row.Completed)}, query) {
			continue
		}
		entry := index[row.Harness]
		if entry == nil {
			entry = &nativeContextEvidence{Harness: row.Harness, Models: map[string]int{}, sessions: map[string]bool{}}
			index[row.Harness] = entry
		}
		entry.Requests++
		if row.Session != "" {
			entry.sessions[row.Session] = true
		}
		if row.Model != "" {
			entry.Models[row.Model]++
		}
		if row.ContextTokens > 0 {
			entry.ContextTokens += row.ContextTokens
		}
		if row.ContextLimit > entry.ContextLimit {
			entry.ContextLimit = row.ContextLimit
		}
		if row.Completed > 0 {
			stamp := schema.FormatTimestamp(time.UnixMilli(row.Completed))
			if stamp > entry.LatestAt {
				entry.LatestAt = stamp
			}
		}
	}
	out := make([]nativeContextEvidence, 0, len(index))
	for _, entry := range index {
		entry.Sessions = len(entry.sessions)
		out = append(out, *entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Harness < out[j].Harness })
	return out
}

func summarizeNative(rows []nativeUsageRow, warnings []string, query EventQuery) nativeUsageSummary {
	summary := nativeUsageSummary{Warnings: warnings, Sessions: []map[string]interface{}{}, Groups: map[string][]nativeUsageGroup{}, Sources: []map[string]string{{"harness": "deepseek_harness", "source": "readonly_versioned_session_store", "cadence": "file snapshot on refresh"}, {"harness": "workbuddy", "source": "readonly_request_usage_jsonl", "cadence": "file snapshot on refresh"}, {"harness": "zcode", "source": "readonly_sqlite", "cadence": "15s; request completion; full reconciliation every 5m"}, {"harness": "grok_bot", "source": "manual_verified_import_or_enterprise_otlp", "cadence": "not connected unless evidence exists"}}}
	summary.Sources = append(summary.Sources,
		map[string]string{"harness": "autoclaw", "source": "readonly_assistant_jsonl_and_work_runs", "cadence": "15s; legacy requests and 2.x run snapshots"},
		map[string]string{"harness": "doubao_work", "source": "readonly_task_structure_without_tokens", "cadence": "15s; activity observed by file modification time; token usage unavailable"},
		map[string]string{"harness": "cursor", "source": "readonly_state_vscdb_message_bubbles", "cadence": "15s incremental by rowid; context occupancy only; billing tokens unknown"})
	groups := map[string]map[string]*nativeUsageGroup{}
	sessions := map[string]map[string]interface{}{}
	activity := nativeActivityGroup{Harness: "doubao_work"}
	activitySessions := map[string]bool{}
	activityWorkers := map[string]bool{}
	allowed := map[string]bool{}
	for _, event := range nativeEvents(rows, query) {
		allowed[event.Event.ID] = true
	}
	for _, row := range rows {
		if !allowed[row.ID] {
			continue
		}
		item := sessions[row.Session]
		if item == nil {
			item = map[string]interface{}{"id": row.Session, "harness": row.Harness, "repository": row.Project, "title": row.Title, "parent_id": row.Parent, "last_event_at": schema.FormatTimestamp(time.UnixMilli(row.Completed))}
			sessions[row.Session] = item
		}
		item["last_event_at"] = schema.FormatTimestamp(time.UnixMilli(row.Completed))
		if row.Unit == "activity" {
			activitySessions[row.Session] = true
			activityWorkers[row.Session+"\x00"+row.Agent] = true
			activity.Messages += row.Messages
			activity.ToolCalls += row.ToolCalls
			activity.LastObserved = schema.FormatTimestamp(time.UnixMilli(row.Completed))
			continue
		}
		unit := row.Unit
		if unit == "" {
			unit = "request"
		}
		total := row.Input + row.Output + row.CacheRead + row.CacheWrite
		retry := "initial"
		if row.Attempt < 0 {
			retry = "unknown"
		}
		if row.Attempt > 0 {
			retry = "retry"
		}
		for dimension, key := range map[string]string{"unit": unit, "task": row.Task, "outcome": row.Status, "retry": retry, "agent_model": row.Harness + " / " + row.Model, "project": row.Project, "worker": row.Agent} {
			if key == "" {
				key = "unknown"
			}
			if unit == "run" && dimension != "unit" {
				key = "run / " + key
			}
			if groups[dimension] == nil {
				groups[dimension] = map[string]*nativeUsageGroup{}
			}
			if groups[dimension][key] == nil {
				groups[dimension][key] = &nativeUsageGroup{Key: key}
			}
			group := groups[dimension][key]
			group.Requests++
			if row.UsageKnown {
				group.UsageRequests++
			}
			group.Tokens += total
			if row.Duration > 0 && unit != "run" {
				group.DurationMS += row.Duration
				group.TimedRequests++
			}
			if row.TTFT > 0 && unit != "run" {
				group.TTFTMS += row.TTFT
				group.TTFTRequests++
			}
		}
	}
	if len(activitySessions) > 0 {
		activity.Sessions, activity.Workers = len(activitySessions), len(activityWorkers)
		summary.Activity = append(summary.Activity, activity)
	}
	for _, item := range sessions {
		summary.Sessions = append(summary.Sessions, item)
	}
	for dimension, items := range groups {
		for _, item := range items {
			summary.Groups[dimension] = append(summary.Groups[dimension], *item)
		}
		sort.Slice(summary.Groups[dimension], func(i, j int) bool { return summary.Groups[dimension][i].Tokens > summary.Groups[dimension][j].Tokens })
	}
	summary.Context = cursorContextEvidence(rows, query)
	return summary
}
