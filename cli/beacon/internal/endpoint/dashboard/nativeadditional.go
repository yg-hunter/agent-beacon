package dashboard

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/sqliteuri"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/dshsession"
	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/endpoint/schema"
)

type nativeFileSnapshot struct {
	Size     int64
	Modified int64
	Rows     []nativeUsageRow
}

// Reuse Beacon's versioned/zstd DeepSeek decoder and usage mapper. No source messages
// or tool arguments are retained by the token dashboard.
func (source *nativeUsageSource) readAdditional(ctx context.Context) ([]nativeUsageRow, []string) {
	home := source.nativeHome
	if home == "" {
		return nil, nil
	}
	if source.files == nil {
		source.files = map[string]nativeFileSnapshot{}
	}
	next := map[string]nativeFileSnapshot{}
	var all []nativeUsageRow
	warnings := []string{}
	store, err := dshsession.NewStore(filepath.Join(home, ".dsh"))
	if err == nil && store.Exists() {
		refs, listErr := store.List()
		if listErr != nil {
			warnings = append(warnings, "DeepSeek Harness: "+listErr.Error())
		}
		for _, ref := range refs {
			if err := ctx.Err(); err != nil {
				warnings = append(warnings, "DeepSeek scan timed out")
				break
			}
			previous, ok := source.files[ref.Path]
			if ok && previous.Size == ref.SizeBytes && previous.Modified == ref.ModTimeUnixMS {
				next[ref.Path] = previous
				all = append(all, previous.Rows...)
				continue
			}
			records, stats, readErr := store.Read(ref)
			if readErr != nil {
				warnings = append(warnings, "DeepSeek session cannot be decoded")
				continue
			}
			rows := []nativeUsageRow{}
			for _, mapped := range dshsession.MapSession(ref, records, dshsession.MapOptions{}) {
				row, ok := nativeRowFromEvent(mapped.Event)
				if ok {
					if ref.Meta != nil {
						row.Title = ref.Meta.Title
						row.Parent = ref.Meta.ParentSessionID
						if ref.Meta.Origin == "subagent" {
							row.Task = "subagent_child"
						} else if row.Parent != "" {
							row.Task = "fork"
						}
					}
					rows = append(rows, row)
				}
			}
			snapshot := nativeFileSnapshot{Size: ref.SizeBytes, Modified: ref.ModTimeUnixMS, Rows: rows}
			if stats.PartialTail || stats.PartialFrame || stats.Malformed > 0 {
				snapshot.Modified = -1
				warnings = append(warnings, "DeepSeek has partial or malformed records; only decoded usage is counted")
			}
			next[ref.Path] = snapshot
			all = append(all, rows...)
		}
	}
	// Modern home wins for upgraded installations. Do not add aggregate database totals.
	roots := []string{filepath.Join(home, ".workbuddy-ai"), filepath.Join(home, ".workbuddy")}
	metadata := map[string][2]string{}
	for _, root := range roots {
		values, metadataErr := workBuddyMetadata(ctx, filepath.Join(root, "workbuddy.db"))
		if metadataErr != nil {
			warnings = append(warnings, "WorkBuddy session metadata unavailable")
		}
		for id, value := range values {
			if _, exists := metadata[id]; !exists {
				metadata[id] = value
			}
		}
		paths, globErr := filepath.Glob(filepath.Join(root, "projects", "*", "*.jsonl"))
		if globErr != nil {
			warnings = append(warnings, "WorkBuddy project discovery failed")
			continue
		}
		for _, path := range paths {
			if ctx.Err() != nil {
				warnings = append(warnings, "WorkBuddy scan timed out")
				break
			}
			info, statErr := os.Stat(path)
			if statErr != nil {
				warnings = append(warnings, "WorkBuddy session cannot be read")
				continue
			}
			previous, ok := source.files[path]
			if ok && previous.Size == info.Size() && previous.Modified == info.ModTime().UnixNano() {
				next[path] = previous
				all = append(all, previous.Rows...)
				continue
			}
			rows, readErr := readWorkBuddy(ctx, path)
			if readErr != nil {
				warnings = append(warnings, "WorkBuddy: "+readErr.Error())
				continue
			}
			snapshot := nativeFileSnapshot{Size: info.Size(), Modified: info.ModTime().UnixNano(), Rows: rows}
			next[path] = snapshot
			all = append(all, rows...)
		}
	}
	clawRows, clawWarnings := source.readClawSources(ctx, next)
	all = append(all, clawRows...)
	warnings = append(warnings, clawWarnings...)
	source.files = next
	// Old/new WorkBuddy homes can contain the same request after an upgrade.
	unique := map[string]bool{}
	result := make([]nativeUsageRow, 0, len(all))
	for _, row := range all {
		if !unique[row.ID] {
			unique[row.ID] = true
			if row.Harness == "workbuddy" {
				value := metadata[row.Session]
				row.Title = value[0]
				if row.Project == "" {
					row.Project = value[1]
				}
			}
			result = append(result, row)
		}
	}
	return result, warnings
}

func nativeRowFromEvent(event schema.Event) (nativeUsageRow, bool) {
	if event.GenAI == nil || event.GenAI.Usage == nil || event.Session == nil {
		return nativeUsageRow{}, false
	}
	usage := event.GenAI.Usage
	value := func(p *int64) int64 {
		if p == nil {
			return 0
		}
		return *p
	}
	at, err := time.Parse(time.RFC3339Nano, event.Timestamp)
	if err != nil {
		return nativeUsageRow{}, false
	}
	row := nativeUsageRow{UsageKnown: true, ID: "deepseek:" + event.Event.ID, Session: event.Session.ID, Harness: "deepseek_harness", Model: event.Model, Project: event.Repository, Completed: at.UnixMilli(), Input: value(usage.InputTokens), Output: value(usage.OutputTokens), Status: "usage_recorded", Attempt: -1, Task: "unknown"}
	if row.Project == "" {
		row.Project = event.Session.WorkingDirectory
	}
	if usage.CacheRead != nil {
		row.CacheRead = value(usage.CacheRead.InputTokens)
	}
	if usage.CacheCreation != nil {
		row.CacheWrite = value(usage.CacheCreation.InputTokens)
	}
	if usage.Reasoning != nil {
		row.Reasoning = value(usage.Reasoning.OutputTokens)
	}
	return row, true
}

func readWorkBuddy(ctx context.Context, path string) ([]nativeUsageRow, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	rows := map[string]nativeUsageRow{}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		// ReadLine enforces an 8 MiB record ceiling before JSON decoding.
		var line []byte
		for {
			part, prefix, readErr := reader.ReadLine()
			if len(line)+len(part) > 8*1024*1024 {
				return nil, fmt.Errorf("session record exceeds 8 MiB")
			}
			line = append(line, part...)
			if readErr != nil && readErr != io.EOF {
				return nil, readErr
			}
			if !prefix {
				break
			}
		}
		if len(line) == 0 {
			if _, err := reader.Peek(1); err == io.EOF {
				break
			}
			continue
		}
		row, ok, parseErr := parseWorkBuddyLine(line)
		if parseErr != nil {
			if _, err := reader.Peek(1); err == io.EOF {
				break
			}
			return nil, parseErr
		}
		if ok {
			rows[row.ID] = row
		}
	}
	result := make([]nativeUsageRow, 0, len(rows))
	for _, row := range rows {
		result = append(result, row)
	}
	return result, nil
}

func parseWorkBuddyLine(line []byte) (nativeUsageRow, bool, error) {
	var record struct {
		ID        string          `json:"id"`
		Session   string          `json:"sessionId"`
		CWD       string          `json:"cwd"`
		Timestamp json.RawMessage `json:"timestamp"`
		Message   struct {
			Usage *struct {
				Input  *int64 `json:"input_tokens"`
				Output *int64 `json:"output_tokens"`
				Read   int64  `json:"cache_read_input_tokens"`
				Write  int64  `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		} `json:"message"`
		Provider struct {
			MessageID string `json:"messageId"`
			Model     string `json:"model"`
			Usage     struct {
				OutputDetails []struct {
					Reasoning int64 `json:"reasoning_tokens"`
				} `json:"outputTokensDetails"`
			} `json:"usage"`
		} `json:"providerData"`
	}
	if err := json.Unmarshal(line, &record); err != nil {
		return nativeUsageRow{}, false, fmt.Errorf("invalid session JSON record")
	}
	usage := record.Message.Usage
	if usage == nil {
		return nativeUsageRow{}, false, nil
	}
	if usage.Input == nil || usage.Output == nil || *usage.Input < usage.Read+usage.Write || usage.Read < 0 || usage.Write < 0 || *usage.Output < 0 {
		return nativeUsageRow{}, false, fmt.Errorf("unsupported usage token relationship")
	}
	id := record.Provider.MessageID
	if id == "" {
		id = record.ID
	}
	if id == "" || record.Session == "" {
		return nativeUsageRow{}, false, fmt.Errorf("usage identity missing")
	}
	var ms int64
	if err := json.Unmarshal(record.Timestamp, &ms); err != nil {
		var text string
		if err := json.Unmarshal(record.Timestamp, &text); err != nil {
			return nativeUsageRow{}, false, fmt.Errorf("usage timestamp missing")
		}
		at, err := time.Parse(time.RFC3339Nano, text)
		if err != nil {
			return nativeUsageRow{}, false, err
		}
		ms = at.UnixMilli()
	}
	if ms <= 0 {
		return nativeUsageRow{}, false, fmt.Errorf("invalid usage timestamp")
	}
	row := nativeUsageRow{UsageKnown: true, ID: "workbuddy:" + record.Session + ":" + id, Session: "workbuddy:" + record.Session, Harness: "workbuddy", Project: record.CWD, Model: record.Provider.Model, Completed: ms, Input: *usage.Input - usage.Read - usage.Write, Output: *usage.Output, CacheRead: usage.Read, CacheWrite: usage.Write, Attempt: -1, Status: "usage_recorded", Task: "unknown"}
	if len(record.Provider.Usage.OutputDetails) > 0 {
		row.Reasoning = record.Provider.Usage.OutputDetails[0].Reasoning
	}
	return row, true, nil
}

// Native authoritative session snapshots replace equivalent token records from a
// previous poll/live capture for that session; other audit activity is preserved.
func mergeNativeEvents(events, native []schema.Event) []schema.Event {
	authoritative := map[string]bool{}
	for _, event := range native {
		if event.Session != nil && (event.Harness.Name == "deepseek_harness" || event.Harness.Name == "workbuddy" || event.Harness.Name == "autoclaw") {
			authoritative[event.Harness.Name+"\x00"+event.Session.ID] = true
		}
	}
	result := make([]schema.Event, 0, len(events)+len(native))
	for _, event := range events {
		if event.Session != nil && event.GenAI != nil && event.GenAI.Usage != nil && authoritative[event.Harness.Name+"\x00"+event.Session.ID] {
			continue
		}
		result = append(result, event)
	}
	return append(result, native...)
}
func nativeFingerprint(rows []nativeUsageRow) (string, error) {
	data, err := json.Marshal(rows)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func (source *nativeUsageSource) collectAdditional(ctx context.Context, warnings []string) ([]nativeUsageRow, []string) {
	rows, extraWarnings := source.readAdditional(ctx)
	return rows, append(warnings, extraWarnings...)
}

func workBuddyMetadata(ctx context.Context, path string) (map[string][2]string, error) {
	result := map[string][2]string{}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return result, nil
	}
	db, err := sql.Open("sqlite", sqliteuri.File(path, url.Values{"mode": {"ro"}, "_pragma": {"busy_timeout(1000)"}}))
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, `SELECT id,coalesce(custom_title,title,''),coalesce(cwd,'') FROM sessions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, title, project string
		if err := rows.Scan(&id, &title, &project); err != nil {
			return nil, err
		}
		result["workbuddy:"+id] = [2]string{title, project}
	}
	return result, rows.Err()
}
