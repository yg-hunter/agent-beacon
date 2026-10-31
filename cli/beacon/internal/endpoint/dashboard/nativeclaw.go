package dashboard

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/asymptote-labs/agent-beacon/cli/beacon/internal/sqliteuri"
)

// AutoClaw 1.x persists disjoint assistant usage; 2.x persists authoritative run
// snapshots. The latter's intermediate assistant entries are cumulative and must
// never be added to work_runs, nor treated as individual model requests.
type clawUsage struct {
	Input     *int64 `json:"input"`
	Output    *int64 `json:"output"`
	Read      int64  `json:"cacheRead"`
	Write     int64  `json:"cacheWrite"`
	Reasoning int64  `json:"reasoningTokens"`
	Total     *int64 `json:"totalTokens"`
}

func (usage clawUsage) apply(row *nativeUsageRow) error {
	if usage.Input == nil || usage.Output == nil || *usage.Input < 0 || *usage.Output < 0 || usage.Read < 0 || usage.Write < 0 || usage.Reasoning < 0 || usage.Reasoning > *usage.Output {
		return fmt.Errorf("unsupported AutoClaw usage counters")
	}
	// Bound each counter before summing untrusted integers.
	const maxCounter = int64(1<<61 - 1)
	for _, count := range []int64{*usage.Input, *usage.Output, usage.Read, usage.Write} {
		if count > maxCounter {
			return fmt.Errorf("AutoClaw usage counter out of range")
		}
	}
	total := *usage.Input + *usage.Output + usage.Read + usage.Write
	if usage.Total != nil && *usage.Total != total {
		return fmt.Errorf("unsupported AutoClaw token relationship")
	}
	row.UsageKnown = true
	row.Input, row.Output, row.CacheRead, row.CacheWrite, row.Reasoning = *usage.Input, *usage.Output, usage.Read, usage.Write, usage.Reasoning
	return nil
}

func scanNativeJSONL(ctx context.Context, path string, visit func([]byte) error) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		if len(scanner.Bytes()) == 0 {
			continue
		}
		if err := visit(scanner.Bytes()); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func readLegacyClaw(ctx context.Context, path string) ([]nativeUsageRow, error) {
	agent := filepath.Base(filepath.Dir(filepath.Dir(path)))
	session := "autoclaw:legacy:" + agent + ":" + strings.TrimSuffix(filepath.Base(path), ".jsonl")
	project := ""
	rows := []nativeUsageRow{}
	err := scanNativeJSONL(ctx, path, func(line []byte) error {
		var record struct {
			Type      string `json:"type"`
			ID        string `json:"id"`
			Timestamp string `json:"timestamp"`
			CWD       string `json:"cwd"`
			Message   struct {
				Role  string     `json:"role"`
				Model string     `json:"model"`
				Usage *clawUsage `json:"usage"`
			} `json:"message"`
		}
		if err := json.Unmarshal(line, &record); err != nil {
			return fmt.Errorf("invalid AutoClaw session JSON")
		}
		if record.Type == "session" {
			project = record.CWD
		}
		if record.Type != "message" || record.Message.Role != "assistant" || record.Message.Usage == nil {
			return nil
		}
		at, err := time.Parse(time.RFC3339Nano, record.Timestamp)
		if err != nil || at.UnixMilli() <= 0 || record.ID == "" {
			return fmt.Errorf("AutoClaw usage identity or timestamp missing")
		}
		row := nativeUsageRow{ID: "autoclaw:legacy:" + agent + ":" + record.ID, Harness: "autoclaw", Session: session, Project: project, Model: record.Message.Model, Completed: at.UnixMilli(), Agent: agent, Attempt: -1, Status: "usage_recorded", Unit: "request"}
		if err := record.Message.Usage.apply(&row); err != nil {
			return err
		}
		rows = append(rows, row)
		return nil
	})
	return rows, err
}

func readClawRuns(ctx context.Context, path string) ([]nativeUsageRow, error) {
	db, err := sql.Open("sqlite", sqliteuri.File(path, url.Values{"mode": {"ro"}, "_pragma": {"busy_timeout(1000)"}}))
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	// A replaced/merged run is not counted alongside its replacement.
	query := `SELECT r.run_id,r.session_id,coalesce(r.status,''),coalesce(r.connection_model,''),coalesce(r.workspace_root,''),r.updated_at,r.usage_json,coalesce(s.title,'') FROM work_runs r LEFT JOIN work_sessions s ON s.session_id=r.session_id WHERE r.usage_json IS NOT NULL AND coalesce(r.merged_into_run_id,'')=''`
	result, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("unsupported AutoClaw run schema: %w", err)
	}
	defer result.Close()
	hash := sha256.Sum256([]byte(filepath.Clean(filepath.Dir(filepath.Dir(path)))))
	prefix := "autoclaw:run:" + hex.EncodeToString(hash[:8]) + ":"
	rows := []nativeUsageRow{}
	for result.Next() {
		var row nativeUsageRow
		var stamp, data string
		if err := result.Scan(&row.ID, &row.Session, &row.Status, &row.Model, &row.Project, &stamp, &data, &row.Title); err != nil {
			return nil, err
		}
		if data == "" || data == "null" {
			continue
		}
		var usage clawUsage
		if err := json.Unmarshal([]byte(data), &usage); err != nil {
			return nil, fmt.Errorf("invalid AutoClaw run usage JSON")
		}
		if err := usage.apply(&row); err != nil {
			return nil, err
		}
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil || at.UnixMilli() <= 0 || row.ID == "" || row.Session == "" {
			return nil, fmt.Errorf("AutoClaw run identity or timestamp missing")
		}
		row.ID, row.Session = prefix+row.ID, prefix+row.Session
		row.Harness, row.Unit, row.Attempt, row.Completed = "autoclaw", "run", -1, at.UnixMilli()
		// llmMs/ttftMs are sums across calls, not request latency.
		rows = append(rows, row)
	}
	return rows, result.Err()
}

// Only structural task activity is retained from Doubao. Its trajectory format
// has no usage counters; text length, subscription credits and token usage must
// not be conflated. File mtime is an observation time, not a model response time.
func readDoubaoActivity(ctx context.Context, path, profile string, modified int64) ([]nativeUsageRow, error) {
	agent := filepath.Base(filepath.Dir(filepath.Dir(path)))
	session := filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(path)))))
	id := "doubao_work:" + profile + ":" + session
	row := nativeUsageRow{ID: id + ":" + agent, Session: id, Harness: "doubao_work", Unit: "activity", Agent: agent, Attempt: -1, Completed: modified, Status: "activity_only"}
	err := scanNativeJSONL(ctx, path, func(line []byte) error {
		var record struct {
			Role      string            `json:"role"`
			ToolCalls []json.RawMessage `json:"tool_calls"`
		}
		if err := json.Unmarshal(line, &record); err != nil {
			return fmt.Errorf("invalid Doubao activity JSON")
		}
		if record.Role != "" {
			row.Messages++
		}
		row.ToolCalls += int64(len(record.ToolCalls))
		return nil
	})
	return []nativeUsageRow{row}, err
}

func (source *nativeUsageSource) readClawSources(ctx context.Context, next map[string]nativeFileSnapshot) ([]nativeUsageRow, []string) {
	home := source.nativeHome
	all := []nativeUsageRow{}
	warnings := []string{}
	databases, err := filepath.Glob(filepath.Join(home, "AppData", "Roaming", "AutoClaw-official", "accounts", "*", "runtime", "runtime.sqlite"))
	if err != nil {
		return nil, []string{"AutoClaw discovery failed"}
	}
	for _, path := range databases {
		// Always query SQLite: live WAL changes need not modify the main DB mtime.
		rows, err := readClawRuns(ctx, path)
		if err != nil {
			warnings = append(warnings, "AutoClaw: "+err.Error())
			continue
		}
		all = append(all, rows...)
	}
	paths, err := filepath.Glob(filepath.Join(home, ".openclaw-autoclaw", "agents", "*", "sessions", "*.jsonl"))
	if err != nil {
		warnings = append(warnings, "AutoClaw legacy discovery failed")
	}
	for _, path := range paths {
		if strings.Count(filepath.Base(path), ".") != 1 {
			continue // Exclude trajectory companions and backup copies.
		}
		rows, err := source.clawFile(ctx, path, next, "")
		if err != nil {
			warnings = append(warnings, "AutoClaw session incomplete; only validated records counted")
		}
		all = append(all, rows...)
	}
	profiles, err := filepath.Glob(filepath.Join(home, "AppData", "Local", "DoubaoWork", "User Data", "*"))
	if err != nil {
		warnings = append(warnings, "Doubao profile discovery failed")
	}
	for _, profile := range profiles {
		name := filepath.Base(profile)
		if name != "Default" && !strings.HasPrefix(name, "Profile ") {
			continue
		}
		paths, err := filepath.Glob(filepath.Join(profile, ".doubaowork", "agent_mode", "workspace", ".sessions", "*", "agents", "*", "system", "trajectory.jsonl"))
		if err != nil {
			warnings = append(warnings, "Doubao task discovery failed")
			continue
		}
		for _, path := range paths {
			rows, err := source.clawFile(ctx, path, next, name)
			if err != nil {
				warnings = append(warnings, "Doubao activity incomplete; only decoded records counted")
			}
			all = append(all, rows...)
		}
	}
	return all, warnings
}

func (source *nativeUsageSource) clawFile(ctx context.Context, path string, next map[string]nativeFileSnapshot, profile string) ([]nativeUsageRow, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if previous, ok := source.files[path]; ok && previous.Size == info.Size() && previous.Modified == info.ModTime().UnixNano() {
		next[path] = previous
		return previous.Rows, nil
	}
	var rows []nativeUsageRow
	if profile == "" {
		rows, err = readLegacyClaw(ctx, path)
	} else {
		rows, err = readDoubaoActivity(ctx, path, profile, info.ModTime().UnixMilli())
	}
	snapshot := nativeFileSnapshot{Size: info.Size(), Modified: info.ModTime().UnixNano(), Rows: rows}
	if err != nil {
		snapshot.Modified = -1 // Retry partial records on the next refresh.
	}
	next[path] = snapshot
	return rows, err
}
