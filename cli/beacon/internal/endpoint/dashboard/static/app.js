const t = window.BeaconI18n.t;

const state = {
  status: null,
  summary: null,
  events: [],
  eventResult: null,
  sessions: [],
  sessionResult: null,
  sessionDetail: null,
  inventory: null,
  loading: false,
  error: null,
  lastDetectionHashScroll: "",
  findings: [],
  findingsRules: null,
  findingsRulesError: null,
  findingsSessions: new Map(),
  findingsSessionErrors: new Map(),
  findingsExpanded: new Set(),
  inventoryView: "configs",
  inventoryRuntime: "",
  inventoryUser: "",
  inventorySearch: "",
  sessionEventFilters: {
    search: "",
    type: "",
    severity: "",
    destructive: false,
    showInternal: false,
  },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const navCollapsedStorageKey = "beacon.dashboard.navCollapsed";
const isSessionsPage = document.body.dataset.page === "sessions";
const isSessionDetailPage = document.body.dataset.page === "session-detail";
const isOverviewPage = document.body.dataset.page === "overview";
const isTokensPage = document.body.dataset.page === "tokens";
const isDetectionsPage = document.body.dataset.page === "detections";
const isFindingsPage = document.body.dataset.page === "findings";
const isMemoryPage = document.body.dataset.page === "memory";
// Both inventory pages share loadInventory(); each renderer targets its own
// page's elements and no-ops when they are absent.
const isInventoryPage = document.body.dataset.page === "inventory" || document.body.dataset.page === "inventory-hooks";
const formFields = [
  "q",
  "harness",
  "model",
  "action",
  "severity",
  "category",
  "repository",
  "session",
  "file",
  "command",
  "mcp",
  "approval",
  "decision",
  "policy",
  "wazuh_level",
  "since",
  "session_state",
  "limit",
  "review",
];

const presets = {
  all: { limit: "500" },
  destructive: { q: "destructive", limit: "500" },
  review: { review: "true", limit: "500" },
  "high-risk": { severity: "high", limit: "500" },
  commands: { action: "command.executed", limit: "500" },
  writes: { action: "file.modified", limit: "500" },
  mcp: { category: "mcp", limit: "500" },
  files: { action: "file.modified", limit: "500" },
  approvals: { category: "approval", limit: "500" },
  failures: { action: "tool.failed", limit: "500" },
  high: { severity: "high", limit: "500" },
};

// Stale-while-revalidate data cache: after navigation a page renders the last fetched
// payload immediately; the 60s background timer and the refresh button always hit the
// network. Entries are per URL (filters included) and live in this tab's sessionStorage.
const dataCachePrefix = "beacon.dashboard.cache.";
const dataCacheTTL = 60000;
const dataCacheEntryLimit = 2000000;
let dataNetworkForced = false;
let dataUpdatedAt = null;
let dataFromCache = false;

function readDataCache(path) {
  try {
    const raw = sessionStorage.getItem(dataCachePrefix + path);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || !Number.isFinite(entry.at)) return null;
    return entry;
  } catch (_) {
    return null;
  }
}

function writeDataCache(path, payload) {
  try {
    const text = JSON.stringify({ at: Date.now(), data: payload });
    // Oversized payloads would risk the session quota; render them uncached instead.
    if (text.length > dataCacheEntryLimit) return;
    sessionStorage.setItem(dataCachePrefix + path, text);
  } catch (_) {
    // Quota or serialization failures must never break rendering.
  }
}

// Clear cached entries after data-changing actions (snapshot imports) or wholesale.
function clearDataCache(prefix = "") {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(dataCachePrefix) && key.includes(prefix)) sessionStorage.removeItem(key);
    }
  } catch (_) {
    // Storage unavailable; the next forced refresh still gets fresh data.
  }
}
window.clearDataCache = clearDataCache;

// Rendered freshness text: cached renders show when the payload was fetched.
function dataFreshnessText(prefix) {
  if (!dataUpdatedAt) return "";
  const time = new Date(dataUpdatedAt).toLocaleTimeString();
  return `${prefix}${t(dataFromCache ? "Cached at {time}; refresh for the latest" : "Updated at {time}", { time })}`;
}

async function fetchJSON(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body.error) message = body.error;
    } catch (_) {
      // Keep the HTTP status when the body is not JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

async function getJSON(path, options = {}) {
  if (!dataNetworkForced) {
    const entry = readDataCache(path);
    if (entry && Date.now() - entry.at < dataCacheTTL) {
      dataUpdatedAt = Math.max(dataUpdatedAt ?? 0, entry.at);
      dataFromCache = true;
      return entry.data;
    }
  }
  const payload = await fetchJSON(path, options);
  writeDataCache(path, payload);
  dataUpdatedAt = Math.max(dataUpdatedAt ?? 0, Date.now());
  dataFromCache = false;
  return payload;
}

// Force the wrapped loader to bypass the cache for this pass (background timer,
// refresh button, or post-mutation reload).
async function refreshData(load) {
  dataNetworkForced = true;
  try {
    await load();
  } finally {
    dataNetworkForced = false;
  }
}

function queryFromFilters() {
  const form = $("#filters");
  if (!form) return "";
  const data = new FormData(form);
  const params = new URLSearchParams();
  for (const [key, value] of data.entries()) {
    const trimmed = String(value).trim();
    if (trimmed) params.set(key, trimmed);
    else if (key === "session_state") params.set(key, "");
  }
  return params.toString();
}

function hydrateFiltersFromURL() {
  if (!$("#filters")) return;
  const params = new URLSearchParams(window.location.search);
  for (const field of formFields) {
    const input = $(`[name="${field}"]`);
    if (!input) continue;
    if (!params.has(field)) continue;
    const value = params.get(field);
    if (field === "limit") ensureLimitOption(input, value);
    ensureFacetOption(input, value);
    input.value = value;
  }
}

// Dynamic facet options may not have loaded yet, or may be absent from a
// filtered summary. Preserve explicit query values until the user clears them.
function ensureFacetOption(select, value) {
  if (!(select instanceof HTMLSelectElement) || !["harness", "model", "repository"].includes(select.name) || !value) return;
  if (Array.from(select.options).some((option) => option.value === value)) return;
  const option = document.createElement("option");
  option.value = value;
  option.textContent = select.name === "harness" ? harnessLabel(value) : select.name === "repository" ? repositoryOptionLabel(value) : value;
  select.append(option);
}

// The limit control is a fixed <select>; a URL like ?limit=5 would otherwise
// silently deselect it and the query would fall back to the server default,
// so add the requested limit as a selectable option.
function ensureLimitOption(select, value) {
  if (!(select instanceof HTMLSelectElement)) return;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return;
  if (Array.from(select.options).some((option) => option.value === value)) return;
  const option = document.createElement("option");
  option.value = value;
  option.textContent = `${value} events`;
  select.append(option);
}

function updateURL(query) {
  const params = new URLSearchParams(query);
  const language = new URLSearchParams(window.location.search).get("lang");
  if (language) params.set("lang", language);
  const range = $("#range-filter");
  if (range) {
    if (range.value) {
      params.set("range", range.value);
    } else {
      params.delete("range");
    }
  }
  const nextQuery = params.toString();
  const next = nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname;
  window.history.replaceState(null, "", next);
}

let activityLoadGeneration = 0;
let activityLoadInFlight = false;

async function load({ updateLocation = false, mode = "replace" } = {}) {
  // Do not let the poll timer continually supersede a slow local log scan.
  // Explicit filter changes still start immediately and replace the old view.
  if (mode === "poll" && activityLoadInFlight) return;
  const generation = ++activityLoadGeneration;
  activityLoadInFlight = true;
  if (isSessionsPage) syncSinceFromRange();
  const query = queryFromFilters();
  if (updateLocation || (isSessionsPage && mode === "poll")) updateURL(query);
  const suffix = query ? `?${query}` : "";
  const activityPath = isSessionsPage || isOverviewPage ? "/api/sessions" : "/api/events";
  const quiet = mode === "poll";
  state.loading = !quiet;
  state.error = null;
  if (!quiet) renderLoading();
  try {
    const [status, summary, events] = await Promise.all([
      getJSON("/api/status"),
      getJSON(`/api/summary${suffix}`),
      getJSON(`${activityPath}${suffix}`),
    ]);
    if (generation !== activityLoadGeneration) return;
    state.status = status;
    state.summary = summary;
    state.eventResult = isSessionsPage || isOverviewPage ? null : events;
    state.sessionResult = isSessionsPage || isOverviewPage ? events : null;
    state.events = isSessionsPage || isOverviewPage ? [] : (events.events || []);
    state.sessions = isSessionsPage ? (events.sessions || []) : [];
  } catch (err) {
    if (generation === activityLoadGeneration) state.error = err;
  } finally {
    if (generation === activityLoadGeneration) {
      activityLoadInFlight = false;
      state.loading = false;
      render();
    }
  }
}

function render() {
  setText("#log-path", state.status?.log_path || t("Runtime log unavailable"));
  setText("#last-updated", state.summary?.last_event_time ? t("Last event {time}", { time: formatTime(state.summary.last_event_time) }) : "");
  if (isOverviewPage) {
    renderOverviewPage();
    return;
  }
  renderFilterOptions();
  renderCards();
  renderActivityAnalytics();
  renderInsights();
  renderSearchState();
  renderEvents();
}

/* Overview page (design board: Agent activity) — KPIs, time distribution,
   source session distribution and attention items. */
let overviewBucket = "24h";

function renderOverviewPage() {
  const notice = $("#overview-notice");
  if (notice) {
    let message = "";
    if (state.error) {
      message = t(state.summary ? "Refresh failed; showing the last successful activity data: {error}" : "Activity data could not be loaded: {error}", { error: state.error.message });
    } else if (state.sessionResult?.truncated) {
      message = t("Session charts use the latest {shown} of {total} sessions; results may be incomplete.", { shown: state.sessionResult.returned, total: state.sessionResult.total_sessions });
    }
    notice.hidden = !message;
    notice.textContent = message;
  }
  if (!state.summary) {
    for (const selector of ["#overview-kpis", "#overview-hourly", "#overview-hourly-table", "#overview-sources", "#overview-attention"]) {
      const element = $(selector);
      if (element) element.replaceChildren();
    }
    return;
  }
  const summary = state.summary ?? {};
  const sessions = state.sessionResult?.sessions ?? [];
  renderOverviewKpis(summary);
  renderOverviewHourly(sessions);
  renderOverviewSources(sessions, summary);
  renderOverviewAttention(summary);
  loadRemoteSources().catch(console.error);
}

let remoteSourcesGeneration = 0;

async function loadRemoteSources() {
  const listEl = $("#remote-cards");
  if (!listEl) return;
  const generation = ++remoteSourcesGeneration;
  let sources = [];
  try {
    const resp = await getJSON("/api/remote-sources");
    if (generation !== remoteSourcesGeneration) return;
    sources = resp?.sources ?? [];
  } catch (error) {
    if (generation !== remoteSourcesGeneration) return;
    listEl.innerHTML = `<p class="muted">${escapeHTML(String(error.message || error))}</p>`;
    return;
  }
  if (!sources.length) {
    listEl.innerHTML = `<p class="muted">${escapeHTML(t("No remote sources added yet"))}</p>`;
    return;
  }
  listEl.innerHTML = sources
    .map(
      (source) =>
        `<div class="remote-card" id="remote-${escapeHTML(source.id)}"><div class="remote-title"><strong>${escapeHTML(source.name)}</strong><span class="muted">${escapeHTML(source.url)}</span></div><div class="remote-kpi muted" data-remote-kpi="${escapeHTML(source.id)}">${escapeHTML(t("Checking..."))}</div><button type="button" class="btn-secondary" data-remote-remove="${escapeHTML(source.id)}">${escapeHTML(t("Remove"))}</button></div>`,
    )
    .join("");
  for (const button of listEl.querySelectorAll("[data-remote-remove]")) {
    button.addEventListener("click", async () => {
      const feedback = $("#remote-feedback");
      button.disabled = true;
      try {
        await deleteRemoteSource(button.dataset.remoteRemove);
        window.clearDataCache("/api/remote-sources");
        if (feedback) feedback.textContent = t("Source removed");
        await loadRemoteSources();
      } catch (error) {
        if (feedback) feedback.textContent = t("Failed to remove source: {error}", { error: error.message });
        button.disabled = false;
      }
    });
  }
  await Promise.all(sources.map(async (source) => {
    const kpiEl = [...listEl.querySelectorAll("[data-remote-kpi]")].find((el) => el.dataset.remoteKpi === source.id);
    if (!kpiEl) return;
    try {
      const summary = await getJSON(`/api/remote-sources/${encodeURIComponent(source.id)}/summary`);
      if (generation !== remoteSourcesGeneration) return;
      kpiEl.innerHTML =
        `<span class="state-pill ok">${escapeHTML(t("Online"))}</span> ` +
        escapeHTML(
          t("{sessions} sessions · {events} events · {tools} tool calls", {
            sessions: summary.active_sessions ?? 0,
            events: summary.total_events ?? 0,
            tools: summary.tool_events ?? 0,
          }),
        );
    } catch (error) {
      if (generation !== remoteSourcesGeneration) return;
      kpiEl.innerHTML = `<span class="state-pill danger">${escapeHTML(t("Unreachable"))}</span> ${escapeHTML(String(error.message || error))}`;
    }
  }));
}

async function deleteRemoteSource(id) {
  const response = await fetch(`/api/remote-sources/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || String(response.status));
  }
}

function renderOverviewKpis(summary) {
  const el = $("#overview-kpis");
  if (!el) return;
  const cards = [
    { label: t("Active sessions"), value: String(summary.active_sessions ?? 0), hint: t("sessions seen in the log") },
    { label: t("Events"), value: Number(summary.total_events ?? 0).toLocaleString(), hint: t("matching current view") },
    { label: t("Tool calls"), value: Number(summary.tool_events ?? 0).toLocaleString(), hint: t("tool.invoked events") },
    { label: t("Commands / file events"), value: `${Number(summary.command_events ?? 0).toLocaleString()} / ${Number(summary.file_events ?? 0).toLocaleString()}`, hint: t("Categories may overlap; file events include more than writes.") },
  ];
  el.innerHTML = cards
    .map(
      (card) =>
        `<div class="kpi-card"><span class="kpi-label">${escapeHTML(card.label)}</span><span class="kpi-value">${escapeHTML(card.value)}</span><span class="kpi-hint">${escapeHTML(card.hint)}</span></div>`,
    )
    .join("");
}

function overviewSessionBuckets(sessions, bucket, now = Date.now()) {
  const hourly = bucket === "24h";
  const slots = hourly ? 24 : 7;
  const buckets = new Map();
  const currentDay = new Date(now);
  currentDay.setHours(0, 0, 0, 0);
  for (let i = 0; i < slots; i += 1) {
    const day = new Date(currentDay);
    day.setDate(day.getDate() - i);
    buckets.set(hourly ? Math.floor(now / 3600000) * 3600000 - i * 3600000 : day.getTime(), 0);
  }
  let covered = 0;
  for (const session of sessions) {
    const stamp = Date.parse(session.last_event_at);
    if (!Number.isFinite(stamp) || stamp > now) continue;
    const day = new Date(stamp);
    day.setHours(0, 0, 0, 0);
    const slotStart = hourly ? Math.floor(stamp / 3600000) * 3600000 : day.getTime();
    if (!buckets.has(slotStart)) continue;
    buckets.set(slotStart, buckets.get(slotStart) + 1);
    covered += 1;
  }
  return { buckets, covered };
}

function renderOverviewHourly(sessions) {
  const el = $("#overview-hourly");
  if (!el) return;
  const { buckets, covered } = overviewSessionBuckets(sessions, overviewBucket);
  const starts = [...buckets.keys()].sort((a, b) => a - b);
  const max = Math.max(...starts.map((slot) => buckets.get(slot) ?? 0), 1);
  const label = (slot) =>
    overviewBucket === "24h"
      ? new Date(slot).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(slot).toLocaleDateString([], { month: "2-digit", day: "2-digit" });
  el.innerHTML = `<div class="hour-bars">${starts
    .map((slot) => {
      const count = buckets.get(slot) ?? 0;
      const height = Math.max(2, Math.round((count / max) * 100));
      return `<span class="hour-bar" title="${escapeHTML(label(slot))} · ${escapeHTML(t("{count} sessions", { count }))}" data-height="${height}"></span>`;
    })
    .join("")}</div><div class="hour-labels">${starts
    .map((slot, index) => (index % Math.ceil(starts.length / 8) === 0 ? `<span>${escapeHTML(label(slot))}</span>` : ""))
    .join("")}</div>`;
  // Bar heights go through the CSSOM (CSP forbids style attributes).
  el.querySelectorAll(".hour-bar").forEach((bar) => {
    bar.style.height = `${bar.dataset.height}%`;
  });
  const table = $("#overview-hourly-table");
  if (table) {
    table.innerHTML = starts.map((slot) => `<tr><td>${escapeHTML(label(slot))}</td><td>${escapeHTML(String(buckets.get(slot) ?? 0))}</td></tr>`).join("");
  }
  const note = $("#overview-hourly-note");
  if (note) {
    note.textContent = t("Based on each session's latest activity time ({count} sessions).", { count: covered });
  }
}

function renderOverviewSources(sessions, summary) {
  const el = $("#overview-sources");
  if (!el) return;
  const counts = new Map();
  for (const session of sessions) {
    if (!session.harness) continue;
    counts.set(session.harness, (counts.get(session.harness) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
  if (!rows.length) {
    el.innerHTML = `<p class="muted">${escapeHTML(t("No sessions in this range"))}</p>`;
    return;
  }
  const max = Math.max(...rows.map((row) => row.value), 1);
  el.innerHTML = rows
    .map(
      (row) =>
        `<div class="project-bar-row"><span>${escapeHTML(harnessLabel(row.name))}</span><span class="pb-track"><span class="pb-fill"></span></span><em>${escapeHTML(t("{count} sessions", { count: row.value }))}</em></div>`,
    )
    .join("");
  const barRows = el.querySelectorAll(".project-bar-row");
  rows.forEach((row, index) => {
    const fill = barRows[index]?.querySelector(".pb-fill");
    if (fill) {
      fill.style.width = `${Math.max(2, (row.value / max) * 100).toFixed(1)}%`;
    }
  });
}

function renderOverviewAttention(summary) {
  const el = $("#overview-attention");
  if (!el) return;
  const count = Number(window.__beaconFindingsCount ?? 0);
  const items = [];
  if (count > 0) {
    items.push({
      level: "danger",
      title: t("{count} findings awaiting review", { count }),
      body: t("Review the flagged sessions before drawing conclusions."),
      action: t("Go to findings"),
      href: "/findings.html",
    });
  }
  items.push({
    level: "activity",
    title: t("Cursor sessions and models are parsed locally"),
    body: t("Billing tokens are accounted by Cursor servers and are not stored locally."),
    action: t("View token usage"),
    href: "/tokens.html?view=agents&harness=cursor",
  });
  items.push({
    level: "muted",
    title: t("Doubao Work activity times come from trajectory file modification times"),
    body: t("They are not per-message timestamps and carry no token usage."),
    action: t("View collection management"),
    href: "/tokens.html?view=sources",
  });
  const countPill = $("#overview-attention-count");
  if (countPill) {
    countPill.hidden = false;
    countPill.textContent = t("{count} items", { count: items.length });
  }
  el.innerHTML = items
    .map(
      (item) =>
        `<div class="attention-item level-${item.level}"><div><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.body)}</p></div><a class="attention-link" href="${escapeHTML(item.href)}">${escapeHTML(item.action)}</a></div>`,
    )
    .join("");
}

function renderCards() {
  if (!$("#cards")) return;
  const topHarness = firstCount(state.summary?.top_harnesses);
  const topModel = firstCount(state.summary?.top_models);
  const cards = [
    { label: t("Events"), value: state.summary?.total_events || 0, hint: t("matching current view") },
    { label: t("Needs Review"), value: state.summary?.needs_review_events || 0, tone: "danger", filters: { review: "true" } },
    { label: t("High/Critical"), value: (state.summary?.high_severity_events || 0) + (state.summary?.critical_severity_events || 0), tone: "danger", filters: { review: "true" } },
    { label: t("Denied/Blocked"), value: (state.summary?.denied_approval_events || 0) + (state.summary?.policy_blocked_events || 0), tone: "danger", filters: { category: "approval", review: "true" } },
    { label: t("Failed Tools"), value: state.summary?.failed_tool_events || 0, tone: "warn", filters: { action: "tool.failed" } },
    { label: t("Sessions"), value: state.summary?.active_sessions || 0, hint: t("active sessions") },
    { label: t("Top Harness"), value: topHarness?.name || t("None"), hint: topHarness ? `${topHarness.count} events` : t("no harness events"), filters: topHarness ? { harness: topHarness.name } : null },
    { label: t("Top Model"), value: topModel?.name || t("None"), hint: topModel ? `${topModel.count} events` : t("no model events"), filters: topModel ? { model: topModel.name } : null },
  ];
  $("#cards").innerHTML = cards
    .map((card, index) => `
      <button type="button" class="card ${card.tone ? `card-${card.tone}` : ""}" data-card="${index}">
        <span class="muted">${escapeHTML(card.label)}</span>
        <span class="value">${escapeHTML(card.value)}</span>
        ${card.hint ? `<span class="muted">${escapeHTML(card.hint)}</span>` : ""}
      </button>
    `)
    .join("");
  $$("#cards [data-card]").forEach((button) => {
    button.addEventListener("click", () => {
      const card = cards[Number(button.dataset.card)];
      if (card?.filters) applyFilters(card.filters, { reset: true });
    });
  });
}

function renderActivityAnalytics() {
  renderActivitySessionChart();
  renderActivityAttention();
}

function renderActivitySessionChart() {
  const el = $("#activity-session-chart");
  if (!el) return;
  const rows = (state.summary?.top_harnesses || []).slice(0, 8);
  const total = rows.reduce((sum, item) => sum + item.count, 0);
  const max = Math.max(1, ...rows.map((item) => item.count));
  if (!rows.length) {
    el.innerHTML = emptyAnalytics(t("No agent sessions in this window"));
    return;
  }
  el.innerHTML = `
    <div class="chart-legend">
      ${rows.slice(0, 6).map((item, index) => `<span><i style="background:${chartColor(index)}"></i>${escapeHTML(harnessLabel(item.name))}</span>`).join("")}
    </div>
    <div class="stacked-chart" aria-label="Agent sessions by source">
      ${rows.map((item, index) => {
        const height = Math.max(10, Math.round((item.count / max) * 100));
        return `
          <button type="button" class="stacked-chart-column" data-activity-harness="${escapeHTML(item.name)}">
            <span class="stacked-chart-bar" style="height:${height}%; background:${chartColor(index)}"></span>
            <span class="stacked-chart-value">${escapeHTML(item.count)}</span>
            <span class="stacked-chart-label">${escapeHTML(truncateMiddle(harnessLabel(item.name), 16))}</span>
          </button>
        `;
      }).join("")}
    </div>
    <p class="muted analytics-footnote">${escapeHTML(t("{count} local events across top harnesses", { count: formatTokens(total) }))}</p>
  `;
  $$("[data-activity-harness]").forEach((button) => {
    button.addEventListener("click", () => applyFilters({ harness: button.dataset.activityHarness }, { reset: true }));
  });
}

function renderActivityAttention() {
  const el = $("#activity-attention");
  if (!el) return;
  const items = [
    { label: t("Critical events flagged for review"), value: state.summary?.critical_severity_events || 0, filters: { severity: "critical" }, tone: "danger" },
    { label: t("High-severity events to triage"), value: state.summary?.high_severity_events || 0, filters: { severity: "high" }, tone: "danger" },
    { label: t("Failed tool calls"), value: state.summary?.failed_tool_events || 0, filters: { action: "tool.failed" }, tone: "warn" },
    { label: t("Sessions awaiting review"), value: state.summary?.needs_review_events || 0, filters: { review: "true" }, tone: "info" },
    { label: t("Denied or blocked actions"), value: (state.summary?.denied_approval_events || 0) + (state.summary?.policy_blocked_events || 0), filters: { review: "true" }, tone: "danger" },
  ];
  el.innerHTML = items
    .map((item, index) => `
      <button type="button" class="attention-card attention-${item.tone}" data-attention-index="${index}">
        <span>${escapeHTML(item.label)}</span>
        <strong>${escapeHTML(item.value)}</strong>
      </button>
    `)
    .join("");
  $$("[data-attention-index]").forEach((button) => {
    const item = items[Number(button.dataset.attentionIndex)];
    button.addEventListener("click", () => applyFilters(item.filters, { reset: true }));
  });
}

function renderInsights() {
  if (!$("#insights")) return;
  const attention = attentionItems();
  const sections = [
    [t("What Needs Attention"), attention, "attention"],
    [t("Agent Harnesses"), state.summary?.top_harnesses || []],
    [t("Models"), state.summary?.top_models || []],
    [t("Top Actions"), state.summary?.top_actions || []],
    [t("Top Repositories"), state.summary?.top_repositories || []],
    [t("MCP Servers"), state.summary?.top_mcp_servers || []],
  ];
  $("#insights").innerHTML = sections
    .map(([title, values, tone]) => `
      <div class="panel insight">
        <h2>${escapeHTML(title)}</h2>
        <div class="stack">
          ${values.length ? values.map((item, index) => `<button type="button" class="${tone === "attention" ? "attention-item" : ""}" data-insight="${escapeHTML(title)}" data-index="${index}" data-value="${escapeHTML(item.name)}"><span>${escapeHTML(item.name)}</span><strong>${escapeHTML(item.count)}</strong></button>`).join("") : `<span class="muted">${escapeHTML(t("No data yet"))}</span>`}
        </div>
      </div>
    `)
    .join("");
  $$("[data-insight]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.insight === t("What Needs Attention")) {
        const item = attention[Number(button.dataset.index)];
        if (item?.filters) applyFilters(item.filters, { reset: true });
        return;
      }
      applyInsight(button.dataset.insight, button.dataset.value);
    });
  });
  renderFacets();
}

function renderSearchState() {
  if (!$("#result-meta")) return;
  const result = isSessionsPage ? (state.sessionResult || {}) : (state.eventResult || {});
  const returned = result.returned ?? (isSessionsPage ? state.sessions.length : state.events.length);
  const total = isSessionsPage ? (result.total_sessions ?? 0) : (result.total_matched ?? 0);
  const unit = isSessionsPage ? "session" : "event";
  const suffix = isSessionsPage && result.events_matched !== undefined ? t(" ({count} matching events)", { count: result.events_matched }) : "";
  const displayUnit = window.BeaconI18n.language === "zh-CN" ? t(isSessionsPage ? "Session" : "Events") : `${unit}${total === 1 ? "" : "s"}`;
  $("#result-meta").textContent = state.loading ? t("Loading...") : t("{shown} shown of {total} matched {unit}", { shown: returned, total, unit: displayUnit }) + suffix;

  const notice = $("#notice");
  if (state.error) {
    notice.hidden = false;
    notice.textContent = t("Failed to load dashboard: {error}", { error: state.error.message });
  } else if (result.truncated) {
    notice.hidden = false;
    notice.textContent = t(isSessionsPage ? "Showing {shown} of {total} matching sessions; narrow the filters to see the rest." : "Showing {shown} of {total} matching events; narrow the filters to see the rest.", { shown: returned, total });
  } else if (result.malformed_lines) {
    notice.hidden = false;
    notice.textContent = t("{count} malformed log lines were skipped.", { count: result.malformed_lines });
  } else {
    notice.hidden = true;
    notice.textContent = "";
  }

  const params = new URLSearchParams(queryFromFilters());
  const chips = [];
  for (const [key, value] of params.entries()) {
    if (key === "limit") continue;
    chips.push(`<button type="button" class="chip" data-clear-filter="${escapeHTML(key)}"><strong>${escapeHTML(labelForParam(key))}</strong>${escapeHTML(displayFilterValue(key, value))}<span aria-hidden="true">x</span></button>`);
  }
  $("#active-filters").innerHTML = chips.join("");
  $$("[data-clear-filter]").forEach((button) => {
    button.addEventListener("click", () => clearFilter(button.dataset.clearFilter));
  });
}

async function loadSessionPage() {
  const params = new URLSearchParams(window.location.search);
  const backURL = safeSessionReturnURL(params.get("return"), window.location.origin);
  if (backURL) $$(".session-back-link").forEach((link) => {
    link.href = backURL;
    if (new URL(backURL, window.location.origin).pathname === "/tokens.html") {
      const label = link.querySelector("[data-i18n]") || link;
      label.dataset.i18n = "Back to token usage";
      label.textContent = t("Back to token usage");
    }
  });
  const id = (params.get("id") || "").trim();
  if (!id) {
    state.error = new Error("session id is required");
    renderSessionPage();
    return;
  }
  const initialLoad = !state.sessionDetail;
  state.loading = initialLoad;
  if (initialLoad) setSessionDetailViewState("loading");
  try {
    const [status, detail] = await Promise.all([
      getJSON("/api/status"),
      getJSON(`/api/session?id=${encodeURIComponent(id)}`),
    ]);
    state.status = status;
    state.sessionDetail = detail;
    state.events = detail.events || [];
    state.error = null;
  } catch (err) {
    state.error = err;
  } finally {
    state.loading = false;
    renderSessionPage();
  }
}

function safeSessionReturnURL(returnPath, origin) {
  if (typeof returnPath !== "string" || !returnPath.startsWith("/") || returnPath.startsWith("//")) return null;
  try {
    const target = new URL(returnPath, origin);
    return target.origin === origin && ["/", "/tokens.html"].includes(target.pathname) ? `${target.pathname}${target.search}${target.hash}` : null;
  } catch {
    return null;
  }
}

function renderSessionPage() {
  setText("#log-path", state.status?.log_path || t("Runtime log unavailable"));
  const detail = state.sessionDetail || {};
  if (state.error && !state.sessionDetail) {
    setSessionDetailViewState("error", t("Failed to load session: {error}", { error: t(state.error.message) }));
    return;
  }
  renderSessionOverview(detail);
  renderSessionEventFilters();
  renderSessionEventTable();
  setSessionDetailViewState("ready");
  if ($("#notice")) {
    $("#notice").hidden = !state.error;
    $("#notice").textContent = state.error ? t("Unable to refresh session: {error}", { error: t(state.error.message) }) : "";
  }
}

function setSessionDetailViewState(mode, message = "") {
  const view = $("#session-detail-view");
  const status = $("#session-detail-status");
  if (view) view.hidden = mode !== "ready";
  if (!status) return;
  status.hidden = mode === "ready";
  status.classList.toggle("error", mode === "error");
  const actions = $("#session-detail-error-actions");
  if (actions) actions.hidden = mode !== "error";
  setText(
    "#session-detail-status-message",
    message || (mode === "loading" ? t("Loading session details...") : ""),
  );
}

const internalSessionCategories = ["inventory", "validation", "metric"];

const sessionTypeOptions = [
  ["", t("All types")],
  ["prompt", t("Prompt")],
  ["tool", t("Tool")],
  ["command", t("Command")],
  ["file", t("File")],
  ["mcp", "MCP"],
  ["approval", t("Approval")],
  ["session", t("Session")],
  ["inventory", t("Inventory")],
  ["validation", t("Validation")],
];

const sessionSeverityOptions = [
  ["", t("All severities")],
  ["info", t("Info")],
  ["low", t("Low")],
  ["medium", t("Medium")],
  ["high", t("High")],
  ["critical", t("Critical")],
];

function renderSessionEventFilters() {
  const filters = state.sessionEventFilters;
  const search = $("#session-event-search");
  if (search) {
    search.value = filters.search;
    search.oninput = (event) => {
      filters.search = event.target.value;
      renderSessionEventTable();
    };
  }
  renderSessionFilterButtons("#session-type-filters", sessionTypeOptions, filters.type, "session-event-type");
  renderSessionFilterButtons("#session-severity-filters", sessionSeverityOptions, filters.severity, "session-event-severity");
  const actionFilters = $("#session-action-filters");
  if (actionFilters) {
    actionFilters.innerHTML = `
      <button type="button" aria-pressed="${!filters.destructive}" class="${filters.destructive ? "" : "active"}" data-session-destructive="false">${escapeHTML(t("All actions"))}</button>
      <button type="button" aria-pressed="${filters.destructive}" class="${filters.destructive ? "active" : ""}" data-session-destructive="true">${escapeHTML(t("Contains destructive action"))}</button>
    `;
  }
  $$("[data-session-event-type]").forEach((button) => {
    button.onclick = () => {
      filters.type = button.dataset.sessionEventType;
      renderSessionEventFilters();
      renderSessionEventTable();
    };
  });
  $$("[data-session-event-severity]").forEach((button) => {
    button.onclick = () => {
      filters.severity = button.dataset.sessionEventSeverity;
      renderSessionEventFilters();
      renderSessionEventTable();
    };
  });
  $$("[data-session-destructive]").forEach((button) => {
    button.onclick = () => {
      filters.destructive = button.dataset.sessionDestructive === "true";
      renderSessionEventFilters();
      renderSessionEventTable();
    };
  });
  const internal = $("#toggle-internal-events");
  if (internal) {
    internal.textContent = filters.showInternal ? t("Hide internal events") : t("Show internal events");
    internal.classList.toggle("active", filters.showInternal);
    internal.setAttribute("aria-pressed", String(filters.showInternal));
    internal.onclick = () => {
      filters.showInternal = !filters.showInternal;
      renderSessionEventFilters();
      renderSessionEventTable();
    };
  }
}

function renderSessionFilterButtons(selector, options, current, dataName) {
  const container = $(selector);
  if (!container) return;
  const attribute = dataName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  container.innerHTML = options.map(([value, label]) => `
    <button type="button" aria-pressed="${current === value}" class="${current === value ? "active" : ""}" data-${attribute}="${escapeHTML(value)}">${escapeHTML(label)}</button>
  `).join("");
}

function renderSessionEventTable() {
  const tbody = $("#events");
  if (!tbody) return;
  const records = filteredSessionEvents();
  const filters = state.sessionEventFilters;
  const typeLabel = sessionTypeOptions.find(([value]) => value === filters.type)?.[1] || t("All types");
  const severityLabel = sessionSeverityOptions.find(([value]) => value === filters.severity)?.[1] || t("All severities");
  const actionLabel = filters.destructive ? t("Contains destructive action") : t("All");
  const runtimeLabel = t(filters.showInternal || internalSessionCategories.includes(filters.type) ? "Internal events shown" : "Internal events hidden");
  setText("#result-meta", t("Type: {type} · Severity: {severity} · Action: {action} · {internal} · {shown} of {total} events", { type: typeLabel, severity: severityLabel, action: actionLabel, internal: runtimeLabel, shown: records.length, total: state.events.length }));
  if (!records.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="muted">${escapeHTML(t("No events match these filters."))}</td></tr>`;
    return;
  }
  tbody.innerHTML = records.map(({ record, index }) => sessionEventRowHTML(record, index)).join("");
  $$("[data-session-json-index]").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      showRawSessionEvent(Number(button.dataset.sessionJsonIndex));
    };
  });
  $$("[data-session-value-index]").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      showSessionEventValue(Number(button.dataset.sessionValueIndex));
    };
  });
}

function filteredSessionEvents() {
  const filters = state.sessionEventFilters;
  const query = filters.search.trim().toLowerCase();
  const internalTypeSelected = internalSessionCategories.includes(filters.type);
  return state.events.map((record, index) => ({ record, index })).filter(({ record }) => {
    const event = record.event || {};
    const type = sessionDisplayEventType(event);
    if (!filters.showInternal && !internalTypeSelected && isInternalSessionEvent(event)) return false;
    if (filters.type && type !== filters.type) return false;
    if (filters.severity && String(event.severity || "info").toLowerCase() !== filters.severity) return false;
    if (filters.destructive && !isDestructiveSessionEvent(record)) return false;
    if (query) {
      const raw = record.raw_event || event;
      if (!JSON.stringify(raw).toLowerCase().includes(query)) return false;
    }
    return true;
  });
}

function sessionEventRowHTML(record, index) {
  const event = record.event || {};
  const usage = event.gen_ai?.usage || {};
  const type = sessionDisplayEventType(event);
  const action = event.event?.action || "event";
  const eventID = event.event?.id || record.id || "";
  const value = sessionEventValue(event);
  const actionDetail = event.tool?.name || event.mcp?.tool || event.model || event.harness?.name || "";
  return `
    <tr>
      <td class="mono session-event-id" title="${escapeHTML(eventID)}">${escapeHTML(shortEventID(eventID))}</td>
      <td class="col-timestamp timestamp-cell">${timestampCellHTML(event.timestamp)}</td>
      <td>${sessionSeverityPill(event.severity || "info")}</td>
      <td>${sessionTypePill(type)}</td>
      <td class="session-event-action">
        <strong>${escapeHTML(sessionActionLabel(event))}</strong>
        ${actionDetail ? `<span>${escapeHTML(actionDetail)}</span>` : ""}
      </td>
      <td class="session-event-value">
        <span>${escapeHTML(truncateMiddle(value, 180) || "-")}</span>
        ${value ? `<button type="button" class="session-value-button" data-session-value-index="${index}">${escapeHTML(t("View full {kind}", { kind: displayEventKind(sessionValueKind(event)) }))}</button>` : ""}
      </td>
      <td>${sessionUsageValue(usage.input_tokens)}</td>
      <td>${sessionUsageValue(usage.output_tokens)}</td>
      <td>${sessionUsageValue(usage.cache_creation?.input_tokens)}</td>
      <td>${sessionUsageValue(usage.cache_read?.input_tokens)}</td>
      <td><button type="button" class="session-json-button" data-session-json-index="${index}" aria-label="${escapeHTML(t("Inspect raw JSON for {action}", { action }))}">JSON</button></td>
    </tr>
  `;
}

function sessionDisplayEventType(event) {
  const category = String(event.event?.category || "").toLowerCase();
  if (category) return category;
  return sessionEventCategory(event);
}

function isInternalSessionEvent(event) {
  const category = sessionDisplayEventType(event);
  const action = String(event.event?.action || "").toLowerCase();
  return internalSessionCategories.includes(category)
    || ["inventory.", "validation.", "metric.", "endpoint.", "telemetry."].some((prefix) => action.startsWith(prefix));
}

function isDestructiveSessionEvent(record) {
  const event = record.event || {};
  const text = JSON.stringify(record.raw_event || event).toLowerCase();
  if (event.severity === "high" || event.severity === "critical") return true;
  if (["approval.denied", "policy.blocked", "tool.failed"].includes(event.event?.action)) return true;
  return /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-f|drop\s+(table|database)|truncate\s+table|delete\s+from)\b/.test(text);
}

function sessionSeverityPill(severity) {
  const normalized = String(severity || "info").toLowerCase();
  return `<span class="session-severity-pill session-severity-${escapeHTML(normalized)}">${escapeHTML(normalized)}</span>`;
}

function sessionTypePill(type) {
  const normalized = String(type || "other").toLowerCase();
  return `<span class="session-type-pill session-type-${escapeHTML(normalized)}">${escapeHTML(normalized)}</span>`;
}

function displayEventKind(kind) {
  const labels = { tool: t("Tool"), command: t("Command"), file: t("File"), prompt: t("Prompt"), approval: t("Approval"), decision: t("Approval"), value: t("Value"), reasoning: t("Reasoning") };
  return window.BeaconI18n.language === "zh-CN" ? t(labels[kind] || kind) : kind;
}

function sessionActionLabel(event) {
  if (event.message && event.message !== event.event?.action) return event.message;
  return String(event.event?.action || "event")
    .replaceAll(".", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function sessionEventValue(event) {
  const reasoning = sessionReasoningValue(event);
  if (reasoning) return reasoning;
  if (event.command?.command) return event.command.command;
  if (event.file?.path) return [event.file.operation, event.file.path].filter(Boolean).join(" ");
  if (event.prompt?.text) return event.prompt.text;
  if (event.mcp) return [event.mcp.server, event.mcp.tool].filter(Boolean).join(" / ");
  if (event.approval) return [event.approval.decision, event.approval.reason].filter(Boolean).join(": ");
  if (event.policy) return [event.policy.decision, event.policy.reason].filter(Boolean).join(": ");
  if (event.tool) return [event.tool.name, event.tool.command, event.tool.path].filter(Boolean).join(" ");
  return event.message || "";
}

function sessionReasoningValue(event) {
  let messages = event.gen_ai?.output?.messages;
  if (typeof messages === "string") {
    try {
      messages = JSON.parse(messages);
    } catch {
      return "";
    }
  }
  if (!Array.isArray(messages)) return "";
  return messages.flatMap((message) => Array.isArray(message?.parts) ? message.parts : [])
    .filter((part) => part?.type === "reasoning" && typeof part.content === "string")
    .map((part) => part.content)
    .filter(Boolean)
    .join("\n\n");
}

function sessionValueKind(event) {
  if (sessionReasoningValue(event)) return "reasoning";
  if (event.command?.command) return "command";
  if (event.prompt?.text) return "prompt";
  if (event.file?.path) return "file";
  if (event.mcp) return "MCP value";
  if (event.approval || event.policy) return "decision";
  return "value";
}

function sessionUsageValue(value) {
  return value === undefined || value === null ? `<span class="muted">-</span>` : escapeHTML(formatTokens(value));
}

function shortEventID(value) {
  const id = String(value || "");
  if (!id) return "-";
  return id.length > 6 ? `…${id.slice(-5)}` : id;
}

function showRawSessionEvent(index) {
  const record = state.events[index];
  if (!record || !$("#drawer")) return;
  setText("#drawer .drawer-head h2", "Raw Event JSON");
  $("#event-summary").innerHTML = detailSummary(record);
  $("#event-json").textContent = JSON.stringify(record.raw_event || record.event || {}, null, 2);
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
}

function showSessionEventValue(index) {
  const event = state.events[index]?.event || {};
  const value = sessionEventValue(event);
  const dialog = $("#session-value-dialog");
  if (!value || !dialog) return;
  const kind = sessionValueKind(event);
  setText("#session-value-dialog-title", `Full ${kind}`);
  setText("#session-value-dialog-content", value);
  dialog.showModal();
  const close = $("#close-session-value");
  if (close) close.onclick = () => dialog.close();
  dialog.onclick = (clickEvent) => {
    if (clickEvent.target === dialog) dialog.close();
  };
}

async function loadInventory() {
  try {
    const [status, inventory] = await Promise.all([
      getJSON("/api/status"),
      getJSON("/api/inventory"),
    ]);
    state.status = status;
    state.inventory = inventory;
    state.error = null;
    renderInventory(inventory);
  } catch (err) {
    state.error = err;
    setText("#inventory-meta", t(state.inventory ? "Inventory refresh failed; showing the last successful scan: {error}" : "Inventory could not be loaded: {error}", { error: err.message }));
  }
}

function renderInventory(resp) {
  setText("#log-path", state.status?.log_path || t("Runtime log unavailable"));
  const harnesses = resp?.harnesses || [];
  const configs = resp?.configs || [];
  const servers = resp?.mcp_servers || [];
  const skills = resp?.skills || [];
  const hooks = normalizeInventoryHooks(resp?.hooks);
  const existingConfigs = configs.filter((config) => config.exists);
  const existingSkills = skills.filter((skill) => skill.exists);
  const hookConfigs = existingConfigs.filter((config) => config.config_kind === "hook_config");
  setText("#inventory-meta", resp?.generated_at ? t("Scanned {time}", { time: formatTime(resp.generated_at) }) : "");
  renderInventoryWorkspace(resp, { harnesses, configs, servers, skills, hooks, existingConfigs, existingSkills, hookConfigs });
  renderInventoryCards(harnesses, existingConfigs, servers, existingSkills, hookConfigs);
  renderInventoryHarnesses(harnesses);
  renderInventoryConfigs(configs);
  renderInventoryMCP(servers, configs);
  renderInventorySkills(existingSkills);
  renderInventoryHooks(hooks, hookConfigs);
  renderHookInventoryCards(hooks, hookConfigs);
  renderHookTargets(hooks, configs);
  renderHookManifests(hookConfigs);
  renderInventoryScope(resp?.user_scope || {});
}

const inventoryViewLabels = {
  configs: t("Configurations"),
  mcp: t("MCP Servers"),
  skills: t("Agent Skills"),
  hooks: t("Hooks"),
};

const inventoryRuntimeLogos = {
  antigravity: "/runtime-logos/antigravity.png",
  antigravity_cli: "/runtime-logos/antigravity.png",
  chatgpt_web: "/runtime-logos/chatgpt.svg",
  claude: "/runtime-logos/claude-code.png",
  claude_code: "/runtime-logos/claude-code.png",
  claude_cowork: "/runtime-logos/claude-code.png",
  claude_web: "/runtime-logos/claude-code.png",
  cline: "/runtime-logos/cline.png",
  cline_cli: "/runtime-logos/cline.png",
  codex: "/runtime-logos/codex.png",
  codex_cli: "/runtime-logos/codex.png",
  codex_desktop: "/runtime-logos/codex.png",
  copilot: "/runtime-logos/github-copilot.png",
  copilot_cli: "/runtime-logos/github-copilot.png",
  github_copilot: "/runtime-logos/github-copilot.png",
  github_copilot_cli: "/runtime-logos/github-copilot.png",
  cursor: "/runtime-logos/cursor.png",
  devin: "/runtime-logos/devin.png",
  "devin-cli": "/runtime-logos/devin.png",
  devin_cli: "/runtime-logos/devin.png",
  "devin-desktop": "/runtime-logos/devin.png",
  devin_desktop: "/runtime-logos/devin.png",
  factory: "/runtime-logos/factory.png",
  factory_droid: "/runtime-logos/factory.png",
  grok: "/runtime-logos/grok-build.png",
  grok_build: "/runtime-logos/grok-build.png",
  "grok-build": "/runtime-logos/grok-build.png",
  hermes: "/runtime-logos/hermes-agent.png",
  hermes_agent: "/runtime-logos/hermes-agent.png",
  kiro: "/runtime-logos/kiro.png",
  kiro_cli: "/runtime-logos/kiro.png",
  muse: "/runtime-logos/muse-code.png",
  muse_code: "/runtime-logos/muse-code.png",
  "muse-code": "/runtime-logos/muse-code.png",
  muse_cli: "/runtime-logos/muse-code.png",
  omp: "/runtime-logos/omp.png",
  omp_cli: "/runtime-logos/omp.png",
  "oh-my-pi": "/runtime-logos/omp.png",
  oh_my_pi: "/runtime-logos/omp.png",
  openclaw: "/runtime-logos/openclaw.png",
  openclaw_gateway: "/runtime-logos/openclaw.png",
  opencode: "/runtime-logos/opencode.png",
  open_code: "/runtime-logos/opencode.png",
  openhands: "/runtime-logos/openhands.png",
  open_hands: "/runtime-logos/openhands.png",
  "open-hands": "/runtime-logos/openhands.png",
  pi: "/runtime-logos/pi-agent.png",
  pi_cli: "/runtime-logos/pi-agent.png",
  pi_agent: "/runtime-logos/pi-agent.png",
  prime: "/runtime-logos/prime-agent.png",
  prime_agent: "/runtime-logos/prime-agent.png",
  qwen: "/runtime-logos/qwen-code.png",
  qwen_code: "/runtime-logos/qwen-code.png",
  qwen_cli: "/runtime-logos/qwen-code.png",
  vercel_fx: "/runtime-logos/vercel-fx.png",
  fx: "/runtime-logos/vercel-fx.png",
  fx_cli: "/runtime-logos/vercel-fx.png",
  vscode: "/runtime-logos/visual-studio-code.png",
  vscode_copilot: "/runtime-logos/visual-studio-code.png",
};

function normalizeInventoryHooks(hooks) {
  if (Array.isArray(hooks)) return hooks;
  if (!hooks || typeof hooks !== "object") return [];
  return Object.entries(hooks).map(([target, hook]) => ({ target, ...(hook || {}) }));
}

function hydrateInventoryStateFromURL() {
  if (!$("#inventory-workspace")) return;
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  state.inventoryView = inventoryViewLabels[view] ? view : state.inventoryView;
  state.inventoryRuntime = params.get("runtime") || "";
  state.inventoryUser = params.get("user") || "";
  state.inventorySearch = params.get("q") || "";
  if ($("#inventory-search")) $("#inventory-search").value = state.inventorySearch;
}

function updateInventoryURL() {
  const params = new URLSearchParams(window.location.search);
  params.set("view", state.inventoryView);
  if (state.inventoryRuntime) params.set("runtime", state.inventoryRuntime);
  else params.delete("runtime");
  if (state.inventoryUser) params.set("user", state.inventoryUser);
  else params.delete("user");
  params.delete("scope");
  if (state.inventorySearch) params.set("q", state.inventorySearch);
  else params.delete("q");
  const next = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, "", next);
}

function renderInventoryWorkspace(_resp, ctx) {
  if (!$("#inventory-workspace")) return;
  renderInventorySummary(ctx);
  renderInventoryFilterOptions(ctx);
  renderInventoryViewTabs(ctx);
  renderInventoryActiveTable(ctx);
}

function renderInventorySummary(ctx) {
  const el = $("#inventory-summary");
  if (!el) return;
  const cards = [
    [t("Detected runtimes"), (ctx.harnesses || []).filter((row) => row.detected).length],
    [t("Discovered config files"), (ctx.existingConfigs || []).length],
    [t("Discovered MCP servers"), (ctx.servers || []).length],
    [t("Discovered hook targets"), (ctx.hooks || []).length],
  ];
  el.innerHTML = cards.map(([label, value]) => `<div class="inventory-summary-card"><span>${escapeHTML(label)}</span><strong>${escapeHTML(String(value))}</strong></div>`).join("");
}

function inventoryRowsForView(view, ctx) {
  switch (view) {
    case "mcp":
      return ctx.servers || [];
    case "skills":
      return (ctx.skills || []).filter((skill) => skill.exists);
    case "hooks":
      if (ctx.hooks?.length) return ctx.hooks;
      return (ctx.hookConfigs || []).map((config) => ({
        target: config.runtime,
        runtime: config.runtime,
        status: config.exists ? "configured" : "not_installed",
        installed: config.exists,
        path: config.path,
        source_scope: config.scope,
        beacon_managed: config.beacon_managed,
        modified_at: config.modified_at,
        file_sha256: config.file_sha256,
        path_hash: config.path_hash,
      }));
    case "configs":
    default:
      return (ctx.configs || []).filter((config) => config.exists);
  }
}

function inventoryCounts(ctx) {
  return {
    configs: inventoryRowsForView("configs", ctx).length,
    mcp: inventoryRowsForView("mcp", ctx).length,
    skills: inventoryRowsForView("skills", ctx).length,
    hooks: inventoryRowsForView("hooks", ctx).length,
  };
}

function renderInventoryFilterOptions(ctx) {
  const userSelect = $("#inventory-user-filter");
  const runtimeSelect = $("#inventory-runtime-filter");
  if (userSelect) {
    const identity = inventoryIdentity();
    userSelect.innerHTML = `
      <option value="">${escapeHTML(t("All users"))}</option>
      <option value="${escapeHTML(identity.user)}"${state.inventoryUser === identity.user ? " selected" : ""}>${escapeHTML(identity.user)}</option>
      ${state.inventoryUser && state.inventoryUser !== identity.user ? `<option value="${escapeHTML(state.inventoryUser)}" selected>${escapeHTML(state.inventoryUser)}</option>` : ""}
    `;
  }
  if (runtimeSelect) {
    const rows = inventoryRowsForView(state.inventoryView, ctx);
    const runtimes = uniqueSorted(rows.map(inventoryRuntimeValue).filter(Boolean), runtimeLabel);
    if (state.inventoryRuntime && !runtimes.includes(state.inventoryRuntime)) {
      runtimes.push(state.inventoryRuntime);
    }
    runtimeSelect.innerHTML = `<option value="">${escapeHTML(t("All runtimes"))}</option>` + runtimes
      .map((value) => `<option value="${escapeHTML(value)}"${state.inventoryRuntime === value ? " selected" : ""}>${escapeHTML(runtimeLabel(value))}</option>`)
      .join("");
  }
}

function renderInventoryViewTabs(ctx) {
  const el = $("#inventory-view-tabs");
  if (!el) return;
  const counts = inventoryCounts(ctx);
  el.innerHTML = Object.entries(inventoryViewLabels)
    .map(([view, label]) => `
      <button type="button" aria-pressed="${state.inventoryView === view}" class="${state.inventoryView === view ? "active" : ""}" data-inventory-view="${escapeHTML(view)}">
        ${escapeHTML(label)} (${escapeHTML(counts[view] || 0)})
      </button>
    `)
    .join("");
  $$("[data-inventory-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.inventoryView = button.dataset.inventoryView;
      updateInventoryURL();
      renderInventoryWorkspace(state.inventory, currentInventoryContext());
    });
  });
}

function renderInventoryActiveTable(ctx) {
  const table = inventoryTableForView(state.inventoryView, ctx);
  const head = $("#inventory-active-head");
  const body = $("#inventory-active-body");
  if (!head || !body) return;
  setText("#inventory-active-title", table.title);
  setText("#inventory-active-description", table.description);
  if ($("#inventory-search")) $("#inventory-search").placeholder = inventorySearchPlaceholder(state.inventoryView);
  const rows = inventoryRowsForView(state.inventoryView, ctx)
    .filter(inventoryRowMatchesFilters)
    .sort(compareInventoryRows);
  head.innerHTML = `<tr>${table.columns.map((column) => `<th>${escapeHTML(column.label)}</th>`).join("")}</tr>`;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${table.columns.length}" class="muted">${escapeHTML(t("No matching rows were found in the latest Beacon inventory snapshot."))}</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map((row) => `<tr>${table.columns.map((column) => `<td${column.className ? ` class="${column.className}"` : ""}>${column.render(row)}</td>`).join("")}</tr>`)
    .join("");
}

function inventorySearchPlaceholder(view) {
  switch (view) {
    case "mcp":
      return t("Search MCP servers by name, status, path, or command...");
    case "skills":
      return t("Search agent skills by name, status, path, or command...");
    case "hooks":
      return t("Search hooks by name, status, path, or command...");
    case "configs":
    default:
      return t("Search configurations by name, status, path, or command...");
  }
}

function inventoryIdentityColumns() {
  return [
    { label: t("User"), className: "nowrap", render: () => escapeHTML(inventoryIdentity().user) },
    { label: t("Device"), className: "nowrap", render: () => escapeHTML(inventoryIdentity().device) },
  ];
}

function inventoryTableForView(view, ctx) {
  const sourceSHAs = configSHAsByPathHash(ctx.configs || []);
  switch (view) {
    case "mcp":
      return {
        title: t("MCP Servers"),
        description: "Model Context Protocol servers declared across discovered runtime configs. Secret-bearing env keys are filtered out.",
        columns: [
          ...inventoryIdentityColumns(),
          { label: t("Agent Runtime"), render: (row) => inventoryRuntimeCell(inventoryRuntimeValue(row)) },
          { label: "Server", render: (row) => escapeHTML(row.server_name || row.server_name_hash || "") },
          { label: t("Scope"), render: (row) => badge(row.source_scope || "unknown", "badge-muted") },
          { label: t("Transport"), render: (row) => badge(row.transport || "unknown", "badge-muted") },
          { label: t("Command"), className: "mono", render: (row) => row.command_present ? escapeHTML(row.command_name || "yes") : `<span class="muted">-</span>` },
          { label: t("Args"), render: (row) => escapeHTML(row.args_count ?? 0) },
          { label: t("Env Keys"), render: envKeysCell },
          { label: t("Source SHA"), className: "mono sha-cell", render: (row) => hashCell(sourceSHAs.get(row.source_path_hash)) },
          { label: t("Definition SHA"), className: "mono sha-cell", render: (row) => hashCell(row.definition_hash) },
          { label: t("Source"), className: "mono path-cell", render: (row) => escapeHTML(row.source_path || row.source_path_hash || "") },
        ],
      };
    case "skills":
      return {
        title: t("Agent Skills"),
        description: t("Local skill manifests discovered under supported agent skill roots. Skill instruction bodies are not retained."),
        columns: [
          ...inventoryIdentityColumns(),
          { label: t("Agent Runtime"), render: (row) => inventoryRuntimeCell(inventoryRuntimeValue(row)) },
          { label: t("Skill"), render: (row) => escapeHTML(row.skill_name || row.skill_name_hash || "") },
          { label: t("Scope"), render: (row) => badge(row.source_scope || "unknown", "badge-muted") },
          { label: t("Status"), render: parserBadge },
          { label: t("Modified"), className: "nowrap", render: (row) => row.modified_at ? escapeHTML(formatTime(row.modified_at)) : `<span class="muted">-</span>` },
          { label: t("Manifest SHA"), className: "mono sha-cell", render: (row) => hashCell(row.file_sha256) },
          { label: t("Manifest"), className: "mono path-cell", render: (row) => escapeHTML(row.manifest_path || row.manifest_path_hash || row.root_path || row.root_path_hash || "") },
        ],
      };
    case "hooks":
      return {
        title: t("Hook Configurations"),
        description: t("Hook manifests discovered across supported runtimes. Hook command bodies are not shown here."),
        columns: [
          ...inventoryIdentityColumns(),
          { label: t("Agent Runtime"), render: (row) => inventoryRuntimeCell(inventoryRuntimeValue(row)) },
          { label: t("Scope"), render: (row) => row.source_scope || row.scope ? badge(row.source_scope || row.scope, "badge-muted") : `<span class="muted">-</span>` },
          { label: t("Status"), render: (row) => badge(row.status || (row.installed ? "configured" : "not_installed"), row.installed ? "badge-ok" : "badge-muted") },
          { label: t("Beacon Cloud"), render: (row) => row.beacon_managed ? badge("managed", "badge-ok") : `<span class="muted">no</span>` },
          { label: t("Modified"), className: "nowrap", render: (row) => row.modified_at ? escapeHTML(formatTime(row.modified_at)) : `<span class="muted">-</span>` },
          { label: t("Manifest SHA"), className: "mono sha-cell", render: (row) => hashCell(row.file_sha256 || row.path_hash) },
          { label: t("Manifest"), className: "mono path-cell", render: (row) => escapeHTML(row.path || row.path_hash || "") },
        ],
      };
    case "configs":
    default:
      return {
        title: t("Agent Runtime Configurations"),
        description: t("Config, hook, plugin, and profile files found on this endpoint. Paths and hashes only; file contents are never read into the dashboard."),
        columns: [
          ...inventoryIdentityColumns(),
          { label: t("Agent Runtime"), render: (row) => inventoryRuntimeCell(inventoryRuntimeValue(row)) },
          { label: t("Scope"), render: (row) => badge(row.scope || "unknown", "badge-muted") },
          { label: t("Kind"), render: (row) => escapeHTML(configKindLabel(row.config_kind)) },
          { label: t("Parser"), render: parserBadge },
          { label: "MCP", render: (row) => escapeHTML(row.mcp_server_count ?? 0) },
          { label: t("Beacon Cloud"), render: (row) => row.beacon_managed ? badge("managed", "badge-ok") : `<span class="muted">no</span>` },
          { label: t("Modified"), className: "nowrap", render: (row) => row.modified_at ? escapeHTML(formatTime(row.modified_at)) : `<span class="muted">-</span>` },
          { label: t("Manifest SHA"), className: "mono sha-cell", render: (row) => hashCell(row.file_sha256) },
          { label: t("Path"), className: "mono path-cell", render: (row) => escapeHTML(row.path || row.path_hash || "") },
        ],
      };
  }
}

function inventoryRuntimeCell(value) {
  if (!value) return `<span class="muted">-</span>`;
  const label = runtimeLabel(value);
  const initials = harnessInitials(value);
  const logo = inventoryRuntimeLogos[String(value).toLowerCase()];
  return `
    <span class="inventory-runtime-cell">
      <span class="inventory-runtime-logo">
        ${logo ? `<img src="${escapeHTML(logo)}" alt="${escapeHTML(label)} logo" loading="lazy" />` : escapeHTML(initials)}
      </span>
      <span>${escapeHTML(label)}</span>
    </span>
  `;
}

function harnessInitials(value) {
  const label = runtimeLabel(value);
  const words = label.split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

function currentInventoryContext() {
  const inventory = state.inventory || {};
  const configs = inventory.configs || [];
  const hooks = normalizeInventoryHooks(inventory.hooks);
  const existingConfigs = configs.filter((config) => config.exists);
  return {
    harnesses: inventory.harnesses || [],
    configs,
    servers: inventory.mcp_servers || [],
    skills: inventory.skills || [],
    hooks,
    existingConfigs,
    existingSkills: (inventory.skills || []).filter((skill) => skill.exists),
    hookConfigs: existingConfigs.filter((config) => config.config_kind === "hook_config"),
  };
}

function inventoryIdentity() {
  const scope = state.inventory?.user_scope || {};
  const home = scope.home_path || "";
  const user = titleCasePathBase(home) || "Local user";
  return {
    user,
    device: t("Local endpoint"),
  };
}

function titleCasePathBase(path) {
  const base = String(path || "").split(/[\\/]/).filter(Boolean).pop() || "";
  return base ? base.replace(/[-_.]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()) : "";
}

function inventoryRuntimeValue(row) {
  return row.runtime || row.target || row.item_name || "";
}

function inventoryScopeValue(row) {
  return row.scope || row.source_scope || "";
}

function inventoryRowMatchesFilters(row) {
  if (state.inventoryRuntime && inventoryRuntimeValue(row) !== state.inventoryRuntime) return false;
  if (state.inventoryUser && state.inventoryUser !== inventoryIdentity().user) return false;
  const query = state.inventorySearch.trim().toLowerCase();
  if (!query) return true;
  return inventorySearchText(row).toLowerCase().includes(query);
}

function inventorySearchText(row) {
  return [
    inventoryRuntimeValue(row),
    runtimeLabel(inventoryRuntimeValue(row)),
    inventoryIdentity().user,
    inventoryIdentity().device,
    inventoryScopeValue(row),
    row.config_kind,
    row.parser_status,
    row.status,
    row.path,
    row.path_hash,
    row.server_name,
    row.server_name_hash,
    row.command_name,
    row.source_path,
    row.source_path_hash,
    row.skill_name,
    row.skill_name_hash,
    row.manifest_path,
    row.manifest_path_hash,
    row.definition_hash,
    row.file_sha256,
  ].filter(Boolean).join(" ");
}

function compareInventoryRows(a, b) {
  return runtimeLabel(inventoryRuntimeValue(a)).localeCompare(runtimeLabel(inventoryRuntimeValue(b)), undefined, { numeric: true, sensitivity: "base" })
    || (inventoryScopeValue(a) || "").localeCompare(inventoryScopeValue(b) || "", undefined, { numeric: true, sensitivity: "base" })
    || inventorySearchText(a).localeCompare(inventorySearchText(b), undefined, { numeric: true, sensitivity: "base" });
}

function uniqueSorted(values, labeler = (value) => value) {
  return Array.from(new Set(values)).sort((a, b) => labeler(a).localeCompare(labeler(b), undefined, { numeric: true, sensitivity: "base" }));
}

function renderInventoryCards(harnesses, configs, servers, skills = [], hooks = []) {
  if (!$("#inventory-cards")) return;
  const detected = harnesses.filter((harness) => harness.detected).length;
  const enabled = harnesses.filter((harness) => harness.telemetry_status === "enabled").length;
  const managed = configs.filter((config) => config.beacon_managed).length;
  const cards = [
    { label: "Detected Runtimes", value: detected, hint: `${harnesses.length} probed` },
    { label: "Telemetry Enabled", value: enabled, hint: t("reporting to Beacon") },
    { label: "Config Files", value: configs.length, hint: `${managed} Beacon-managed` },
    { label: t("MCP Servers"), value: servers.length, hint: "across all configs" },
    { label: t("Agent Skills"), value: skills.length, hint: "local manifests" },
    { label: "Hook Configs", value: hooks.length, hint: "discovered manifests" },
  ];
  $("#inventory-cards").innerHTML = cards
    .map((card) => `
      <div class="card">
        <span class="muted">${escapeHTML(card.label)}</span>
        <span class="value">${escapeHTML(card.value)}</span>
        ${card.hint ? `<span class="muted">${escapeHTML(card.hint)}</span>` : ""}
      </div>
    `)
    .join("");
}

function renderInventoryHarnesses(harnesses) {
  const el = $("#inventory-harnesses");
  if (!el) return;
  if (!harnesses.length) {
    el.innerHTML = `<p class="muted">${escapeHTML(t("No runtimes probed."))}</p>`;
    return;
  }
  el.innerHTML = harnesses
    .map((harness) => {
      const rows = [
        ["Detected", harness.detected ? "yes" : "no"],
        ["Telemetry", harness.telemetry_status || "unknown"],
        ["Capability", harness.capability || ""],
        ["Version", harness.version || ""],
        ["Config", harness.config_path || ""],
        ["Executable", harness.executable_path || ""],
      ].filter(([, value]) => value !== "");
      return `
        <div class="harness ${harness.detected ? "" : "harness-muted"}">
          <div class="harness-head">
            <strong>${escapeHTML(harness.display_name || harness.name || "unknown")}</strong>
            ${telemetryBadge(harness.telemetry_status, harness.detected)}
          </div>
          <dl class="harness-meta">
            ${rows.map(([key, value]) => `<div><dt>${escapeHTML(key)}</dt><dd class="${key === "Config" || key === "Executable" ? "mono" : ""}">${escapeHTML(value)}</dd></div>`).join("")}
          </dl>
          ${harness.message ? `<p class="muted">${escapeHTML(harness.message)}</p>` : ""}
        </div>
      `;
    })
    .join("");
}

function renderInventoryConfigs(configs) {
  const tbody = $("#inventory-configs");
  if (!tbody) return;
  const showAll = $("#inventory-show-all")?.checked;
  const rows = (configs || []).filter((config) => showAll || config.exists);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted">${escapeHTML(t("No configuration files discovered."))}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((config) => `
      <tr class="${config.exists ? "" : "row-absent"}">
        <td>${escapeHTML(runtimeLabel(config.runtime))}</td>
        <td>${badge(config.scope || "unknown", "badge-muted")}</td>
        <td>${escapeHTML(configKindLabel(config.config_kind))}</td>
        <td>${parserBadge(config)}</td>
        <td>${config.exists ? escapeHTML(config.mcp_server_count ?? 0) : `<span class="muted">-</span>`}</td>
        <td>${config.beacon_managed ? badge("managed", "badge-ok") : `<span class="muted">no</span>`}</td>
        <td class="nowrap">${config.modified_at ? escapeHTML(formatTime(config.modified_at)) : `<span class="muted">-</span>`}</td>
        <td class="mono sha-cell">${hashCell(config.file_sha256)}</td>
        <td class="mono path-cell">${escapeHTML(config.path || config.path_hash || "")}</td>
      </tr>
    `)
    .join("");
}

function renderInventoryMCP(servers, configs = []) {
  const tbody = $("#inventory-mcp");
  if (!tbody) return;
  if (!servers.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="muted">${escapeHTML(t("No MCP servers declared in discovered configs."))}</td></tr>`;
    return;
  }
  const sourceSHAs = configSHAsByPathHash(configs);
  tbody.innerHTML = servers
    .map((server) => `
      <tr>
        <td>${escapeHTML(runtimeLabel(server.runtime))}</td>
        <td>${escapeHTML(server.server_name || server.server_name_hash || "")}</td>
        <td>${badge(server.source_scope || "unknown", "badge-muted")}</td>
        <td>${badge(server.transport || "unknown", "badge-muted")}</td>
        <td class="mono">${server.command_present ? escapeHTML(server.command_name || "yes") : `<span class="muted">-</span>`}</td>
        <td>${escapeHTML(server.args_count ?? 0)}</td>
        <td>${envKeysCell(server)}</td>
        <td class="mono sha-cell">${hashCell(sourceSHAs.get(server.source_path_hash))}</td>
        <td class="mono sha-cell">${hashCell(server.definition_hash)}</td>
        <td class="mono path-cell">${escapeHTML(server.source_path || server.source_path_hash || "")}</td>
      </tr>
    `)
    .join("");
}

function renderInventorySkills(skills) {
  const tbody = $("#inventory-skills");
  if (!tbody) return;
  if (!skills.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">${escapeHTML(t("No agent skills discovered in supported local roots."))}</td></tr>`;
    return;
  }
  tbody.innerHTML = skills
    .map((skill) => `
      <tr>
        <td>${escapeHTML(runtimeLabel(skill.runtime))}</td>
        <td>${escapeHTML(skill.skill_name || skill.skill_name_hash || "")}</td>
        <td>${badge(skill.source_scope || "unknown", "badge-muted")}</td>
        <td>${parserBadge(skill)}</td>
        <td class="nowrap">${skill.modified_at ? escapeHTML(formatTime(skill.modified_at)) : `<span class="muted">-</span>`}</td>
        <td class="mono sha-cell">${hashCell(skill.file_sha256)}</td>
        <td class="mono path-cell">${escapeHTML(skill.manifest_path || skill.manifest_path_hash || skill.root_path || skill.root_path_hash || "")}</td>
      </tr>
    `)
    .join("");
}

function renderInventoryHooks(hooks, configs = []) {
  const tbody = $("#inventory-hooks");
  if (!tbody) return;
  const rows = hooks?.length ? hooks : configs.map((config) => ({
    target: config.runtime,
    status: config.exists ? "configured" : "not_installed",
    installed: config.exists,
    path: config.path,
    message: "",
  }));
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">${escapeHTML(t("No hook configuration manifests discovered."))}</td></tr>`;
    return;
  }
  const configByPath = configsByPath(configs);
  tbody.innerHTML = rows
    .map((hook) => {
      const config = configByPath.get(hook.path) || {};
      return `
        <tr class="${hook.installed ? "" : "row-absent"}">
          <td>${escapeHTML(runtimeLabel(hook.target))}</td>
          <td>${config.scope ? badge(config.scope, "badge-muted") : `<span class="muted">-</span>`}</td>
          <td>${badge(hook.status || (hook.installed ? "configured" : "not_installed"), hook.installed ? "badge-ok" : "badge-muted")}</td>
          <td>${config.beacon_managed ? badge("managed", "badge-ok") : `<span class="muted">no</span>`}</td>
          <td class="nowrap">${config.modified_at ? escapeHTML(formatTime(config.modified_at)) : `<span class="muted">-</span>`}</td>
          <td class="mono sha-cell">${hashCell(config.file_sha256)}</td>
          <td class="mono path-cell">${escapeHTML(hook.path || config.path || config.path_hash || "")}${hook.message ? `<br /><span class="muted">${escapeHTML(inventoryMessage(hook.message))}</span>` : ""}</td>
        </tr>
      `;
    })
    .join("");
}

// Renderers for the dedicated Hook Inventory page (inventory-hooks.html).

function renderHookInventoryCards(hooks, hookConfigs) {
  const el = $("#hook-inventory-cards");
  if (!el) return;
  const installed = hooks.filter((hook) => hook.installed).length;
  const managed = hookConfigs.filter((config) => config.beacon_managed).length;
  const cards = [
    { label: t("Hook Targets"), value: hooks.length, hint: t("runtimes probed") },
    { label: t("Hooks Installed"), value: installed, hint: t("Adapter detected") },
    { label: t("Hook Manifests"), value: hookConfigs.length, hint: t("discovered files") },
    { label: t("Beacon Cloud"), value: managed, hint: t("managed manifests") },
  ];
  el.innerHTML = cards
    .map((card) => `
      <div class="card">
        <span class="muted">${escapeHTML(card.label)}</span>
        <span class="value">${escapeHTML(card.value)}</span>
        ${card.hint ? `<span class="muted">${escapeHTML(card.hint)}</span>` : ""}
      </div>
    `)
    .join("");
}

function renderHookTargets(hooks, configs = []) {
  const tbody = $("#hook-targets");
  if (!tbody) return;
  const rows = filterHookAssets(hooks, $("#hook-search")?.value || "");
  setText("#hook-target-count", t("{shown} of {total} Hook targets", { shown: rows.length, total: hooks.length }));
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">${escapeHTML(t(hooks.length ? "No Hook assets match this search." : "No hook targets probed."))}</td></tr>`;
    return;
  }
  const configByPath = configsByPath(configs);
  tbody.innerHTML = rows
    .map((hook) => {
      const config = configByPath.get(hook.path) || {};
      return `
        <tr class="${hook.installed ? "" : "row-absent"}">
          <td>${escapeHTML(runtimeLabel(hook.target))}</td>
          <td>${badge(hook.status || (hook.installed ? "configured" : "not_installed"), hook.installed ? "badge-ok" : "badge-muted")}</td>
          <td>${config.scope ? badge(config.scope, "badge-muted") : `<span class="muted">-</span>`}</td>
          <td>${config.beacon_managed ? badge("managed", "badge-ok") : `<span class="muted">no</span>`}</td>
          <td class="mono path-cell">${hook.binary_path ? escapeHTML(hook.binary_path) : `<span class="muted">-</span>`}</td>
          <td class="mono path-cell">${hook.path ? escapeHTML(hook.path) : `<span class="muted">-</span>`}</td>
          <td>${hook.message ? `<span class="muted">${escapeHTML(inventoryMessage(hook.message))}</span>` : `<span class="muted">-</span>`}</td>
        </tr>
      `;
    })
    .join("");
}

function renderHookManifests(hookConfigs) {
  const tbody = $("#hook-manifests");
  if (!tbody) return;
  const rows = filterHookAssets(hookConfigs, $("#hook-search")?.value || "");
  setText("#hook-manifest-count", t("{shown} of {total} Hook manifests", { shown: rows.length, total: hookConfigs.length }));
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">${escapeHTML(t(hookConfigs.length ? "No Hook assets match this search." : "No hook configuration manifests discovered."))}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((config) => `
      <tr>
        <td>${escapeHTML(runtimeLabel(config.runtime))}</td>
        <td>${badge(config.scope || "unknown", "badge-muted")}</td>
        <td>${parserBadge(config)}</td>
        <td>${config.beacon_managed ? badge("managed", "badge-ok") : `<span class="muted">no</span>`}</td>
        <td class="nowrap">${config.modified_at ? escapeHTML(formatTime(config.modified_at)) : `<span class="muted">-</span>`}</td>
        <td class="mono sha-cell">${hashCell(config.file_sha256)}</td>
        <td class="mono path-cell">${escapeHTML(config.path || config.path_hash || "")}</td>
      </tr>
    `)
    .join("");
}

function filterHookAssets(rows, query) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => [row.target, row.runtime, row.status, row.path, row.binary_path, row.scope, row.parser_status, row.message]
    .some((value) => String(value ?? "").toLocaleLowerCase().includes(needle)));
}

function renderInventoryScope(scope) {
  const el = $("#inventory-scope");
  if (!el) return;
  const rows = [
    [t("Mode"), scope.mode || ""],
    [t("Home"), scope.home_path || ""],
    [t("Working directory"), scope.working_dir || ""],
  ].filter(([, value]) => value);
  el.innerHTML = rows.length
    ? rows.map(([key, value]) => `<div><span class="muted">${escapeHTML(key)}</span><strong class="mono">${escapeHTML(value)}</strong></div>`).join("")
    : `<p class="muted">${escapeHTML(t("No scope information."))}</p>`;
}

function telemetryBadge(status, detected) {
  if (!detected) return badge("not detected", "badge-muted");
  const classes = {
    enabled: "badge-ok",
    disabled: "badge-muted",
    missing: "badge-warn",
    misconfigured: "badge-warn",
  };
  return badge(status || "unknown", classes[status] || "badge-muted");
}

function parserBadge(config) {
  const status = config.parser_status || "unknown";
  const cls =
    status === "ok" ? "badge-ok" :
    status === "not_found" ? "badge-muted" :
    status === "partial" ? "badge-warn" :
    "badge-danger";
  const showReason = config.reason && status !== "ok" && status !== "not_found";
  return `${badge(status, cls)}${showReason ? `<br /><span class="muted">${escapeHTML(config.reason)}</span>` : ""}`;
}

function envKeysCell(server) {
  const keys = server.env_keys || [];
  const total = server.env_key_count || keys.length;
  const filtered = Math.max(0, total - keys.length);
  if (!keys.length) {
    return filtered ? `<span class="muted">${filtered} filtered</span>` : `<span class="muted">-</span>`;
  }
  const chips = keys.map((key) => badge(key, "badge-muted")).join(" ");
  return chips + (filtered ? ` <span class="muted">+${filtered} filtered</span>` : "");
}

function hashCell(value) {
  if (!value) return `<span class="muted">-</span>`;
  return escapeHTML(value);
}

function configSHAsByPathHash(configs) {
  const values = new Map();
  for (const config of configs || []) {
    if (config.path_hash && config.file_sha256) {
      values.set(config.path_hash, config.file_sha256);
    }
  }
  return values;
}

function configsByPath(configs) {
  const values = new Map();
  for (const config of configs || []) {
    if (config.path) {
      values.set(config.path, config);
    }
  }
  return values;
}

function runtimeLabel(value) {
  const labels = {
    claude_code: "Claude Code",
    codex_cli: "Codex CLI",
    codex_desktop: "Codex Desktop",
    cursor: "Cursor",
    gemini_cli: "Gemini CLI",
    antigravity: "Antigravity CLI",
    antigravity_cli: "Antigravity CLI",
    vscode: "VS Code",
    factory: "Factory Droid",
    copilot_cli: "GitHub Copilot CLI",
    opencode: "opencode",
    hermes: "Hermes Agent",
    kiro: "Kiro",
    "devin-cli": "Devin CLI",
    "devin-desktop": "Devin Desktop",
    grok: "Grok",
    qwen: "Qwen Code",
    qwen_code: "Qwen Code",
    vercel_fx: "fx (Vercel Labs)",
    agent_skills: t("Agent Skills"),
  };
  return labels[value] || harnessLabel(value);
}

function configKindLabel(kind) {
  const labels = {
    native_config: t("Native config"),
    hook_config: t("Hook config"),
    plugin: t("Plugin"),
    profile: t("Shell profile"),
    managed_config: t("Managed config"),
  };
  return labels[kind] || kind || "unknown";
}

function renderEvents() {
  if (!$("#events")) return;
  if (isSessionsPage) renderSessions();
}

function renderSessions() {
  if (state.loading) {
    renderLoading();
    return;
  }
  if (state.error) {
    $("#events").innerHTML = `<tr><td colspan="9">Failed to load dashboard: ${escapeHTML(state.error.message)}</td></tr>`;
    return;
  }
  if (!state.sessions.length) {
    const usageOnlyPick =
      state.usageOnlyAgents?.has($("#harness-filter")?.value) ||
      state.usageOnlyModels?.has($("#model-filter")?.value);
    const usageOnlyNote = usageOnlyPick
      ? `<tr><td colspan="9" class="muted">${escapeHTML(t("Usage snapshot only: the runtime event log has no session events for this filter."))}</td></tr>`
      : "";
    $("#events").innerHTML = `<tr><td colspan="9">${escapeHTML(t("No sessions match this search. Clear filters or broaden the query."))}</td></tr>${usageOnlyNote}`;
    return;
  }
  $("#events").innerHTML = state.sessions
    .map((session) => sessionRowHTML(session))
    .join("");
  bindSessionRows();
  restoreSessionListScroll();
}

function sessionRowHTML(session) {
  const review = session.review_count || 0;
  const activity = sessionActivitySummary(session);
  const lastDetail = session.last_artifact || session.last_message || "";
  const models = uniqueValues([...(session.models || []), session.model]);
  const prompt = session.original_prompt
    ? escapeHTML(truncateMiddle(session.original_prompt, 180))
    : `<span class="muted">${escapeHTML(t("No prompt captured"))}</span>`;
  return `
    <tr class="row-link" data-session-id="${escapeHTML(session.id)}">
      <td class="mono"><a class="cell-link" href="${escapeHTML(sessionPageURL(session.id))}">${escapeHTML(formatSessionID(session.id))}</a></td>
      <td>${badge(session.max_severity || "unknown", `severity-${session.max_severity || "unknown"}`)}${review ? `<br /><span class="muted">${escapeHTML(review)} review</span>` : ""}</td>
      <td>${sessionHarnessCell(session)}</td>
      <td class="col-message">
        <span class="session-list-prompt">
          ${models.length ? `<strong class="session-list-prompt-model">${models.map(escapeHTML).join(" · ")}</strong>` : ""}
          ${session.is_recurring ? `<strong class="session-recurring-indicator">Recurring ×${escapeHTML(session.recurrence_count)}</strong>` : ""}
          ${sessionSharingIndicator(session.sharing)}
          <span>${prompt}</span>
        </span>
      </td>
      <td class="session-activity-cell">${activity}</td>
      <td class="col-timestamp timestamp-cell">${timestampCellHTML(session.first_event_at)}</td>
      <td class="col-timestamp timestamp-cell">${timestampCellHTML(session.last_event_at)}</td>
      <td class="col-duration">${escapeHTML(durationLabel(session.first_event_at, session.last_event_at))}</td>
      <td class="col-message"><strong>${escapeHTML(session.last_action || "event")}</strong>${lastDetail ? `<br /><span class="muted">${escapeHTML(truncateMiddle(lastDetail, 140))}</span>` : ""}</td>
    </tr>
  `;
}

// Sharing state comes from the session.shared record `beacon share` writes. The dashboard is
// read-only: it links to the shared trace and shows the refresh command to copy, and never shares.
function sessionSharingIndicator(sharing) {
  if (!sharing || !sharing.url) return "";
  const stale = sharing.state === "stale";
  return `<strong class="session-share-indicator${stale ? " session-share-stale" : ""}" title="${escapeHTML(stale ? "Shared; the session has newer activity than the shared trace" : "Shared on beacon.sh")}">${stale ? "Shared · stale" : "Shared"}</strong>`;
}

function safeShareURL(url) {
  return typeof url === "string" && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : "";
}

function sessionSharingRowHTML(sharing) {
  if (!sharing || !sharing.url) return "";
  const url = safeShareURL(sharing.url);
  const stale = sharing.state === "stale";
  const link = url
    ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(url)}</a>`
    : escapeHTML(sharing.url);
  const detail = [sharing.visibility, stale ? "stale: newer local activity" : "up to date"].filter(Boolean).join(" · ");
  const hint = sharing.refresh_command
    ? `<span class="session-share-hint"><code>${escapeHTML(sharing.refresh_command)}</code> <button type="button" class="copy-share-refresh" data-command="${escapeHTML(sharing.refresh_command)}">${escapeHTML(t("Copy"))}</button></span>`
    : "";
  return `${link}<small>${escapeHTML(detail)}</small>${hint}`;
}

function bindShareRefreshCopy(scope = document) {
  scope.querySelectorAll(".copy-share-refresh").forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(button.dataset.command || "");
        button.textContent = t("Copied");
      } catch (_) {
        button.textContent = "Copy failed";
      }
      window.setTimeout(() => { button.textContent = t("Copy"); }, 1400);
    };
  });
}

function bindSessionRows(scope = document) {
  const rows = scope.matches?.("tr[data-session-id]") ? [scope] : Array.from(scope.querySelectorAll("tr[data-session-id]"));
  rows.forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.target.closest("button, input, select, textarea")) return;
      const link = event.target.closest("a");
      if (link && !link.classList.contains("cell-link")) return;
      saveSessionListScroll();
      if (link) return;
      window.location.href = sessionPageURL(row.dataset.sessionId);
    });
  });
}

function saveSessionListScroll() {
  if (!isSessionsPage) return;
  try {
    window.sessionStorage.setItem("beacon.session-list-scroll", JSON.stringify({
      path: `${window.location.pathname}${window.location.search}`,
      y: window.scrollY,
    }));
  } catch (error) {
    console.warn("Unable to save session list position", error);
  }
}

function restoreSessionListScroll() {
  if (!isSessionsPage) return;
  try {
    const raw = window.sessionStorage.getItem("beacon.session-list-scroll");
    if (!raw) return;
    window.sessionStorage.removeItem("beacon.session-list-scroll");
    const saved = JSON.parse(raw);
    if (saved?.path === `${window.location.pathname}${window.location.search}` && Number.isFinite(saved.y) && saved.y >= 0) {
      window.requestAnimationFrame(() => window.scrollTo(0, saved.y));
    }
  } catch (error) {
    console.warn("Unable to restore session list position", error);
  }
}

function sessionPageURL(id) {
  const params = new URLSearchParams({ id });
  if (window.BeaconI18n?.language) params.set("lang", window.BeaconI18n.language);
  if (isSessionsPage) params.set("return", `${window.location.pathname}${window.location.search}`);
  return `/session.html?${params.toString()}`;
}

function closeDrawer() {
  if (!$("#drawer")) return;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
}

function renderLoading() {
  setText("#result-meta", t("Loading..."));
  const columns = isSessionDetailPage ? 11 : (isSessionsPage ? 9 : 8);
  if ($("#events")) $("#events").innerHTML = `<tr><td colspan="${columns}">Loading ${isSessionsPage ? "sessions" : "events"}...</td></tr>`;
}

function harnessCell(event) {
  const harness = event.harness || {};
  if (!harness.name) return "";
  const label = harnessLabel(harness.name);
  const logo = inventoryRuntimeLogos[String(harness.name).toLowerCase()];
  return `
    <span class="session-harness-cell">
      <span class="session-harness-logo">
        ${logo ? `<img src="${escapeHTML(logo)}" alt="${escapeHTML(label)} logo" loading="lazy" />` : escapeHTML(harnessInitials(harness.name))}
      </span>
      <span class="session-harness-name">${escapeHTML(label)}</span>
      ${harness.collection_method ? `<span class="capture-method-badge">${escapeHTML(captureMethodLabel(harness.collection_method))}</span>` : ""}
    </span>
  `;
}

function sessionHarnessCell(session) {
  if (!session.harness) return "";
  return harnessCell({ harness: { name: session.harness } });
}

function captureMethodLabel(value) {
  const labels = {
    hook: t("Hooks"),
    otlp: "OpenTelemetry",
    plugin: t("Plugin"),
    poll: "Poll",
  };
  return labels[String(value).toLowerCase()] || value;
}

function signalAction(record) {
  const event = record.event || {};
  const info = event.event || {};
  if (info.category === "metric") return metricName(event) || info.action || "metric.observed";
  return info.action || "unknown";
}

function sessionActivitySummary(session) {
  const items = [
    ["tool", Number(session.tool_count) || 0],
    ["command", Number(session.command_count) || 0],
    ["file", Number(session.file_count) || 0],
    ["prompt", Number(session.prompt_count) || 0],
    ["mcp", Number(session.mcp_count) || 0],
    ["approval", Number(session.approval_count) || 0],
  ];
  const eventCount = Number(session.event_count) || 0;
  const categorizedCount = items.reduce((sum, [, count]) => sum + count, 0);
  const otherCount = Math.max(0, eventCount - categorizedCount);
  const segments = otherCount > 0 ? [...items, ["other", otherCount]] : items;
  const scale = Math.max(eventCount, categorizedCount, 1);
  let segmentOffset = 0;
  const segmentRects = segments
    .filter(([, count]) => count > 0)
    .map(([label, count]) => {
      const x = (segmentOffset / scale) * 100;
      const width = (count / scale) * 100;
      segmentOffset += count;
      return `<rect class="session-activity-segment session-activity-${escapeHTML(label)}" x="${x}%" width="${width}%" height="100%"></rect>`;
    })
    .join("");
  const visibleItems = items.filter(([, count]) => count > 0).slice(0, 3);
  const totalLabel = `${formatTokens(eventCount)} event${eventCount === 1 ? "" : "s"}`;
  const detailLabel = visibleItems.length
    ? visibleItems.map(([label, count]) => `${formatTokens(count)} ${label}`).join(" · ")
    : "session lifecycle";
  const ariaLabel = `${totalLabel}; ${items.filter(([, count]) => count > 0).map(([label, count]) => `${formatTokens(count)} ${label}`).join(", ") || "session lifecycle events"}`;
  return `
    <div class="session-activity-summary" aria-label="${escapeHTML(ariaLabel)}">
      <div class="session-activity-total"><strong>${escapeHTML(formatTokens(eventCount))}</strong><span>${escapeHTML(t("Events"))}</span></div>
      <svg class="session-activity-track" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 1">${segmentRects}</svg>
      <div class="session-activity-detail">${escapeHTML(detailLabel)}</div>
    </div>
  `;
}

function metricName(event) {
  return event.raw?.metric_name || event.message || "";
}

function primaryArtifact(event) {
  if (event.prompt?.text) return event.prompt.text;
  if (event.command?.command) return event.command.command;
  if (event.file?.path) return `${event.file.operation || "file"} ${event.file.path}`;
  if (event.mcp?.server || event.mcp?.tool) return [event.mcp.server, event.mcp.tool].filter(Boolean).join(" / ");
  if (event.tool?.name || event.tool?.command) return [event.tool.name, event.tool.command].filter(Boolean).join(" ");
  if (event.approval?.decision || event.approval?.reason) return [event.approval.decision, event.approval.reason].filter(Boolean).join(": ");
  if (event.policy?.decision || event.policy?.name) return [event.policy.decision, event.policy.name].filter(Boolean).join(": ");
  if (event.event?.category === "metric") return metricName(event);
  return event.model || event.branch || "";
}

function detailSummary(record) {
  const event = record.event || {};
  const info = event.event || {};
  const rows = [
    ["Action", signalAction(record)],
    [t("Category"), info.category],
    [t("Severity"), event.severity],
    ["Wazuh level", record.wazuh_level || ""],
    [t("Harness"), event.harness?.name],
    [t("Model"), event.model],
    [t("Session"), event.session?.id],
    [t("Repository"), repositoryLabel(event)],
    [t("Prompt"), event.prompt?.text],
    ["Artifact", event.prompt?.text ? "" : primaryArtifact(event)],
    [t("Approval"), event.approval ? [event.approval.decision, event.approval.reason].filter(Boolean).join(": ") : ""],
    ["Policy", event.policy ? [event.policy.decision, event.policy.name, event.policy.reason].filter(Boolean).join(": ") : ""],
    ["Content", event.content ? `${event.content.retention}${event.content.redacted ? ", redacted" : ""}${event.content.truncated ? ", truncated" : ""}` : ""],
  ].filter(([, value]) => value);
  return rows
    .map(([label, value]) => {
      const key = detailFilterKey(label);
      const displayValue = label === t("Session") ? formatSessionID(value) : value;
      return `
        <div>
          <span class="muted">${escapeHTML(label)}</span>
          <strong>${escapeHTML(displayValue)}</strong>
          ${key ? `<button type="button" class="text-button" data-apply-filter="${escapeHTML(key)}" data-value="${escapeHTML(value)}">Filter by this</button>` : ""}
        </div>
      `;
    })
    .join("");
}

function renderSessionOverview(detail) {
  const session = detail.session || {};
  const records = detail.events || [];
  const events = records.map((record) => record.event || {});
  const firstEvent = events[0] || {};
  const userName = firstNonEmpty(events.map((event) => event.user?.name)) || "Local user";
  const harness = session.harness || firstNonEmpty(events.map((event) => event.harness?.name)) || "agent";
  const start = session.first_event_at || firstEvent.timestamp;
  const end = session.last_event_at || events[events.length - 1]?.timestamp;
  const title = window.BeaconI18n.language === "zh-CN"
    ? t("{user} · {harness} session", { user: userName, harness: harnessLabel(harness) })
    : `${possessive(userName)} ${harnessLabel(harness)} session${sessionDateTitle(start, end)}`;
  setText("#session-page-title", title);
  setText("#session-full-id", session.id || "");
  setText("#session-time-range", sessionTimeRange(start, end));
  const promptText = session.original_prompt || t("No prompt captured");
  setText("#session-prompt", promptText);
  setText("#session-prompt-dialog-content", promptText);

  const badges = [
    session.review_count
      ? `<span class="session-badge session-badge-risk">${escapeHTML(session.review_count)} event${session.review_count === 1 ? "" : "s"} need review</span>`
      : `<span class="session-badge session-badge-ok">${escapeHTML(t("No high risk events"))}</span>`,
    `<span class="session-badge session-badge-info">${escapeHTML(t("{count} events captured", { count: session.event_count || records.length }))}</span>`,
  ];
  if (session.sharing && session.sharing.url) {
    badges.push(session.sharing.state === "stale"
      ? `<span class="session-badge session-badge-risk">Shared · stale</span>`
      : `<span class="session-badge session-badge-ok">Shared</span>`);
  }
  $("#session-badges").innerHTML = badges.join("");

  renderSessionMetadata(session, events);
  renderSessionActivity(session, records);
  bindSessionOverviewActions(session.id || "");
}

function renderSessionMetadata(session, events) {
  const userName = firstNonEmpty(events.map((event) => event.user?.name)) || "Local user";
  const device = firstNonEmpty(events.map((event) => event.endpoint?.hostname))
    || firstNonEmpty(events.map((event) => event.endpoint?.os))
    || t("Local endpoint");
  const harness = session.harness || firstNonEmpty(events.map((event) => event.harness?.name)) || "-";
  const methods = uniqueValues(events.map((event) => event.harness?.collection_method)).map(captureMethodLabel);
  const models = uniqueValues(events.map((event) => event.model));
  const usage = sessionUsage(events);
  const rows = [
    {
      label: t("User"),
      value: `<span class="session-person"><i>${escapeHTML(userName.slice(0, 1).toUpperCase())}</i>${escapeHTML(userName)}</span>`,
    },
    { label: t("Environment"), value: `<span class="session-meta-pill">${escapeHTML(t("Endpoint"))}</span>` },
    { label: t("Device"), value: `<span class="session-device"><i aria-hidden="true"></i>${escapeHTML(device)}</span>` },
    {
      label: t("Harness"),
      value: `${sessionHarnessCell({ harness })}${methods.length ? `<small>${escapeHTML(methods.join(", "))}</small>` : ""}`,
      className: "session-meta-harness",
    },
    { label: t("Model"), value: models.length ? escapeHTML(models.join(", ")) : `<span class="muted">-</span>`, className: "mono" },
    { label: "Tokens", value: usage.tokens ? escapeHTML(formatCompactTokens(usage.tokens)) : `<span class="muted">-</span>` },
    { label: t("Reported Cost"), value: usage.cost ? `$${escapeHTML(usage.cost.toFixed(4))}` : `<span class="muted">-</span>` },
    { label: t("Repository"), value: session.repository ? escapeHTML(repositoryOptionLabel(session.repository)) : `<span class="muted">-</span>`, className: "mono" },
    { label: t("Branch"), value: session.branch ? escapeHTML(session.branch) : `<span class="muted">-</span>`, className: "mono" },
  ];
  if (session.sharing && session.sharing.url) {
    rows.push({ label: "Shared", value: sessionSharingRowHTML(session.sharing), className: "session-meta-sharing" });
  }
  $("#session-metadata").innerHTML = rows.map((row) => `
    <div class="session-meta-item ${row.className || ""}">
      <span>${escapeHTML(row.label)}</span>
      <strong>${row.value}</strong>
    </div>
  `).join("");
  bindShareRefreshCopy($("#session-metadata"));
}

function renderSessionActivity(session, records) {
  const categoryConfig = [
    ["tool", t("Tools"), "#0ea5b7"],
    ["command", t("Commands"), "#7c3aed"],
    ["file", t("Files"), "#3b82f6"],
    ["prompt", t("Prompts"), "#a855f7"],
    ["approval", t("Approvals"), "#10b981"],
    ["mcp", "MCP", "#d946ef"],
    ["other", t("Other"), "#cbd5e1"],
  ];
  const counts = Object.fromEntries(categoryConfig.map(([key]) => [key, 0]));
  for (const record of records) counts[sessionEventCategory(record.event || {})]++;
  const duration = durationLabel(session.first_event_at, session.last_event_at);
  setText("#session-activity-summary", t("{duration} session · {count} events · peak {peak} per interval", { duration, count: records.length, peak: peakEventsPerBucket(records) }));
  $("#session-activity-legend").innerHTML = categoryConfig
    .filter(([key]) => counts[key] > 0)
    .map(([key, label, color]) => `<span><i data-session-color="${escapeHTML(color)}"></i>${escapeHTML(counts[key])} ${escapeHTML(label)}</span>`)
    .join("");

  const buckets = sessionActivityBuckets(records, 24);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.total));
  const start = session.first_event_at;
  const end = session.last_event_at;
  $("#session-activity-chart").innerHTML = `
    <div class="session-chart-y"><span>${escapeHTML(max)}</span><span>${escapeHTML(Math.ceil(max / 2))}</span><span>0</span></div>
    <div class="session-chart-plot">
      <div class="session-chart-grid" aria-hidden="true"></div>
      <div class="session-chart-bars">
        ${buckets.map((bucket) => `
          <div class="session-chart-bar" title="${escapeHTML(bucket.total)} event${bucket.total === 1 ? "" : "s"}">
            <div data-session-height="${(bucket.total / max) * 100}">
              ${categoryConfig.map(([key, , color]) => bucket.counts[key] ? `<span data-session-flex="${bucket.counts[key]}" data-session-color="${escapeHTML(color)}"></span>` : "").join("")}
            </div>
          </div>
        `).join("")}
      </div>
      <div class="session-chart-axis">
        <span>${escapeHTML(formatClockTime(start))}</span>
        <span>${escapeHTML(formatClockTime(midpointTimestamp(start, end)))}</span>
        <span>${escapeHTML(formatClockTime(end))}</span>
      </div>
    </div>
  `;

  const severityOrder = [
    ["critical", "#be123c"],
    ["high", "#e11d48"],
    ["medium", "#f59e0b"],
    ["low", "#06b6d4"],
    ["info", "#3b82f6"],
  ];
  const severities = {};
  for (const record of records) {
    const severity = record.event?.severity || "info";
    severities[severity] = (severities[severity] || 0) + 1;
  }
  const severityMax = Math.max(1, ...Object.values(severities));
  $("#session-severity-breakdown").innerHTML = `
    <h3>${escapeHTML(t("Breakdown by severity"))}</h3>
    ${severityOrder.filter(([key]) => severities[key]).map(([key, color]) => `
      <div class="session-severity-row">
        <div><strong>${escapeHTML(titleCase(key))}</strong><span>${escapeHTML(severities[key])}</span></div>
        <i><b data-session-width="${(severities[key] / severityMax) * 100}" data-session-color="${escapeHTML(color)}"></b></i>
      </div>
    `).join("")}
  `;
  applySessionActivityStyles();
}

function applySessionActivityStyles() {
  $$("[data-session-color]").forEach((element) => {
    element.style.backgroundColor = element.dataset.sessionColor;
  });
  $$("[data-session-height]").forEach((element) => {
    element.style.height = `${element.dataset.sessionHeight}%`;
  });
  $$("[data-session-width]").forEach((element) => {
    element.style.width = `${element.dataset.sessionWidth}%`;
  });
  $$("[data-session-flex]").forEach((element) => {
    element.style.flexGrow = element.dataset.sessionFlex;
  });
}

function bindSessionOverviewActions(sessionID) {
  const copy = $("#copy-session-id");
  if (copy) {
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(sessionID);
        copy.textContent = t("Copied");
      } catch (_) {
        copy.textContent = "Copy failed";
      }
      window.setTimeout(() => { copy.textContent = t("Copy"); }, 1400);
    };
  }
  const toggle = $("#toggle-session-prompt");
  const dialog = $("#session-prompt-dialog");
  const close = $("#close-session-prompt");
  if (toggle && dialog) {
    toggle.onclick = () => dialog.showModal();
  }
  if (close && dialog) {
    close.onclick = () => dialog.close();
    dialog.onclick = (event) => {
      if (event.target === dialog) dialog.close();
    };
  }
}

function sessionActivityBuckets(records, bucketCount) {
  const timestamps = records.map((record) => new Date(record.event?.timestamp || 0).getTime()).filter(Number.isFinite);
  const start = Math.min(...timestamps);
  const end = Math.max(...timestamps);
  const span = Math.max(1, end - start);
  const buckets = Array.from({ length: bucketCount }, () => ({
    total: 0,
    counts: { tool: 0, command: 0, file: 0, prompt: 0, approval: 0, mcp: 0, other: 0 },
  }));
  for (const record of records) {
    const timestamp = new Date(record.event?.timestamp || 0).getTime();
    const index = Number.isFinite(timestamp) ? Math.min(bucketCount - 1, Math.floor(((timestamp - start) / span) * bucketCount)) : 0;
    const category = sessionEventCategory(record.event || {});
    buckets[index].total++;
    buckets[index].counts[category]++;
  }
  return buckets;
}

function peakEventsPerBucket(records) {
  return Math.max(0, ...sessionActivityBuckets(records, 24).map((bucket) => bucket.total));
}

function sessionEventCategory(event) {
  const category = event.event?.category;
  if (["tool", "command", "file", "prompt", "approval", "mcp"].includes(category)) return category;
  if (event.command) return "command";
  if (event.file) return "file";
  if (event.mcp) return "mcp";
  if (event.approval || event.policy) return "approval";
  if (event.prompt?.text) return "prompt";
  if (event.tool) return "tool";
  return "other";
}

function sessionUsage(events) {
  let tokens = 0;
  let cost = 0;
  for (const event of events) {
    const usage = event.gen_ai?.usage || {};
    tokens += Number(usage.input_tokens || 0)
      + Number(usage.output_tokens || 0)
      + Number(usage.cache_read?.input_tokens || 0)
      + Number(usage.cache_creation?.input_tokens || 0)
      + Number(usage.reasoning?.output_tokens || 0);
    cost += Number(usage.cost_usd || 0);
  }
  return { tokens, cost };
}

function firstNonEmpty(values) {
  return values.find((value) => String(value || "").trim()) || "";
}

function uniqueValues(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function possessive(value) {
  return `${value}${value.endsWith("s") ? "'" : "'s"}`;
}

function sessionDateTitle(start, end) {
  const first = new Date(start || 0);
  const last = new Date(end || start || 0);
  if (Number.isNaN(first.getTime())) return "";
  const date = first.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return ` on ${date} from ${first.toLocaleTimeString()} to ${Number.isNaN(last.getTime()) ? "-" : last.toLocaleTimeString()}`;
}

function sessionTimeRange(start, end) {
  if (!start) return "";
  return `${formatTime(start)} → ${formatTime(end || start)} · duration ${durationLabel(start, end)}`;
}

function durationLabel(start, end) {
  const first = new Date(start || 0).getTime();
  const last = new Date(end || start || 0).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last)) return "-";
  let seconds = Math.max(0, Math.round((last - first) / 1000));
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${seconds}s`].filter(Boolean).join(" ");
}

function formatClockTime(timestamp) {
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleTimeString();
}

function midpointTimestamp(start, end) {
  const first = new Date(start || 0).getTime();
  const last = new Date(end || start || 0).getTime();
  return Number.isFinite(first) && Number.isFinite(last) ? new Date(first + ((last - first) / 2)).toISOString() : "";
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, (char) => char.toUpperCase());
}

function repositoryLabel(event) {
  return [event.repository, event.branch].filter(Boolean).join(" @ ");
}

function formatSessionID(value, fallback = "") {
  const sessionID = String(value || "").trim();
  if (!sessionID) return fallback;
  return sessionID.slice(-4);
}

function displayFilterValue(key, value) {
  if (key === "session") return formatSessionID(value);
  return value;
}

function badge(value, className) {
  // Inventory statuses and scopes are a small closed vocabulary; translate when
  // a key exists and keep the raw value for anything else (rule names, IDs).
  return `<span class="badge ${escapeHTML(className)}">${escapeHTML(t(String(value)))}</span>`;
}

// Cursor-style harness inventory messages arrive from the backend in English;
// map the one well-known sentence pattern and pass everything else verbatim.
function inventoryMessage(message) {
  const match = /^(.+?) endpoint hooks are (not )?installed$/.exec(String(message ?? "").trim());
  if (!match) return message;
  return match[2]
    ? t("{name} endpoint hooks are not installed", { name: match[1] })
    : t("{name} endpoint hooks are installed", { name: match[1] });
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return timestamp;
  return parsed.toLocaleString();
}

function timestampCellHTML(timestamp) {
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return escapeHTML(timestamp);
  return `<span class="timestamp-date">${escapeHTML(parsed.toLocaleDateString())}</span><span class="timestamp-time">${escapeHTML(parsed.toLocaleTimeString())}</span>`;
}

function labelForParam(key) {
  const labels = {
    q: "search",
    mcp: "MCP",
    wazuh_level: "Wazuh",
  };
  return labels[key] || key.replaceAll("_", " ");
}

// Usage-only sources and models exist in local usage snapshots but never in the
// runtime event log; list them so filters cover every known source without
// pretending they have sessions to audit.
function mergeUsageFacets(sessionFacets, usageFacets) {
  const known = new Set((sessionFacets ?? []).map((item) => item.name));
  const merged = [...(sessionFacets ?? [])];
  for (const item of usageFacets ?? []) {
    if (known.has(item.name)) continue;
    merged.push({ name: item.name, count: item.count, usageOnly: true });
  }
  return merged;
}

function renderFilterOptions() {
  if (!$("#filters")) return;
  const harnesses = mergeUsageFacets(state.summary?.top_harnesses, state.summary?.usage_harnesses);
  const models = mergeUsageFacets(state.summary?.top_models, state.summary?.usage_models);
  state.usageOnlyAgents = new Set(harnesses.filter((item) => item.usageOnly).map((item) => item.name));
  state.usageOnlyModels = new Set(models.filter((item) => item.usageOnly).map((item) => item.name));
  renderHarnessSelect(harnesses);
  renderModelSelect(models);
  renderRepositorySelect(state.summary?.top_repositories || []);
  renderDatalist("action-options", state.summary?.top_actions || []);
}

function renderHarnessSelect(values) {
  const select = $("#harness-filter");
  if (!select) return;
  const current = select.value;
  const options = [
    `<option value="">${escapeHTML(t("All agent harnesses"))}</option>`,
    ...values.map((item) => `<option value="${escapeHTML(item.name)}">${escapeHTML(item.usageOnly ? `${harnessLabel(item.name)} · ${t("{count} usage records", { count: item.count })}` : `${harnessLabel(item.name)} (${escapeHTML(item.count)})`)}</option>`),
  ];
  select.innerHTML = options.join("");
  ensureFacetOption(select, current);
  select.value = current;
}

function renderModelSelect(values) {
  const select = $("#model-filter");
  if (!select) return;
  const current = select.value;
  const options = [
    `<option value="">${escapeHTML(t("All models"))}</option>`,
    ...values.map((item) => `<option value="${escapeHTML(item.name)}">${escapeHTML(item.usageOnly ? `${item.name} · ${t("{count} usage records", { count: item.count })}` : `${item.name} (${escapeHTML(item.count)})`)}</option>`),
  ];
  select.innerHTML = options.join("");
  ensureFacetOption(select, current);
  select.value = current;
}

function renderRepositorySelect(values) {
  const select = $("#repository-filter");
  if (!select) return;
  const current = select.value;
  const options = [
    `<option value="">${escapeHTML(t("All repositories"))}</option>`,
    ...values.map((item) => `<option value="${escapeHTML(item.name)}">${escapeHTML(repositoryOptionLabel(item.name))} (${escapeHTML(item.count)})</option>`),
  ];
  select.innerHTML = options.join("");
  ensureFacetOption(select, current);
  select.value = current;
}

function repositoryOptionLabel(value) {
  if (!value) return "";
  const parts = value.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : value;
}

function renderDatalist(id, values) {
  const list = $(`#${id}`);
  if (!list) return;
  list.innerHTML = values.map((item) => `<option value="${escapeHTML(item.name)}">${escapeHTML(item.count)} events</option>`).join("");
}

function harnessLabel(value) {
  const labels = {
    chatgpt_web: "ChatGPT Web",
    cline: "Cline",
    cursor: "Cursor",
    claude_code: "Claude Code",
    claude_web: "Claude Web",
    codex_cli: "Codex CLI",
    codex_desktop: "Codex Desktop",
    copilot_cli: "GitHub Copilot CLI",
    grok: "Grok Build",
    grok_bot: "Grok Bot",
    zcode: "ZCode",
    deepseek_harness: "DeepSeek Harness",
    workbuddy: "WorkBuddy AI",
    autoclaw: "AutoClaw",
    doubao_work: "豆包工作 / Doubao Work",
    kiro: "Kiro",
    qwen_code: "Qwen Code",
    vercel_fx: "fx (Vercel Labs)",
    cli: "Beacon CLI",
  };
  return labels[value] || value;
}

function renderFacets() {
  if (!$("#facets")) return;
  const groups = [
    [t("Harness"), "harness", state.summary?.top_harnesses || []],
    [t("Model"), "model", state.summary?.top_models || []],
  ];
  $("#facets").innerHTML = groups
    .filter(([, , values]) => values.length)
    .map(([label, key, values]) => `
      <div class="facet-group">
        <span class="muted">${escapeHTML(label)}</span>
        ${values.slice(0, 5).map((item) => `<button type="button" data-apply-filter="${escapeHTML(key)}" data-value="${escapeHTML(item.name)}">${escapeHTML(item.name)} <strong>${escapeHTML(item.count)}</strong></button>`).join("")}
      </div>
    `)
    .join("");
  $$("#facets [data-apply-filter]").forEach((button) => {
    button.addEventListener("click", () => applyFilters({ [button.dataset.applyFilter]: button.dataset.value }));
  });
}

function attentionItems() {
  const items = [
    { name: t("Needs review"), count: state.summary?.needs_review_events || 0, filters: { review: "true" } },
    { name: "Denied approvals", count: state.summary?.denied_approval_events || 0, filters: { action: "approval.denied" } },
    { name: "Blocked policies", count: state.summary?.policy_blocked_events || 0, filters: { action: "policy.blocked" } },
    { name: "Failed tools", count: state.summary?.failed_tool_events || 0, filters: { action: "tool.failed" } },
    { name: "High or critical severity", count: (state.summary?.high_severity_events || 0) + (state.summary?.critical_severity_events || 0), filters: { review: "true" } },
  ];
  return items.filter((item) => item.count > 0);
}

function restoreRangeFromURL() {
  const range = $("#range-filter");
  if (!range) return;
  const params = new URLSearchParams(window.location.search);
  const value = params.get("range");
  if (value && Array.from(range.options).some((opt) => opt.value === value)) {
    range.value = value;
  } else if (params.get("since")) {
    range.value = "custom";
  }
}

function setupSessionFilters() {
  const form = $("#filters");
  if (!form) return;
  restoreRangeFromURL();
  syncSinceFromRange();
  syncSessionStateTabs();
  $$("[data-session-state]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = $("#session-state-filter");
      if (!input) return;
      input.value = button.dataset.sessionState === "all" ? "" : button.dataset.sessionState;
      syncSessionStateTabs();
      load({ updateLocation: true }).catch(console.error);
    });
  });
  $("#range-filter")?.addEventListener("change", () => {
    syncSinceFromRange();
    load({ updateLocation: true }).catch(console.error);
  });
  form.addEventListener("change", (event) => {
    if (event.target?.id === "range-filter") return;
    if (event.target?.matches("select[name]")) load({ updateLocation: true }).catch(console.error);
  });
}

function syncSessionStateTabs() {
  const current = $("#session-state-filter")?.value || "all";
  $$("[data-session-state]").forEach((button) => {
    const active = button.dataset.sessionState === current || (button.dataset.sessionState === "all" && current === "");
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function syncSinceFromRange() {
  const range = $("#range-filter");
  const since = $("#since-filter");
  if (!range || !since) return;
  if (range.value === "custom") return;
  const durations = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };
  since.value = durations[range.value] ? new Date(Date.now() - durations[range.value]).toISOString() : "";
}

function firstCount(values) {
  return values && values.length ? values[0] : null;
}

function detailFilterKey(label) {
  switch (label) {
    case "Action":
      return "action";
    case t("Category"):
      return "category";
    case t("Severity"):
      return "severity";
    case t("Harness"):
      return "harness";
    case t("Model"):
      return "model";
    case t("Session"):
      return "session";
    case t("Repository"):
      return "repository";
    default:
      return "";
  }
}

function setFilters(filters, { reset = false } = {}) {
  if (reset) clearFields(false);
  for (const [key, value] of Object.entries(filters)) {
    const input = $(`[name="${key}"]`);
    if (input) input.value = value;
  }
  if (Object.prototype.hasOwnProperty.call(filters, "since") && $("#range-filter")) {
    $("#range-filter").value = filters.since ? "custom" : "all";
  }
  if (!Object.prototype.hasOwnProperty.call(filters, "since")) syncSinceFromRange();
  load({ updateLocation: true }).catch(console.error);
}

function applyFilters(filters, options = {}) {
  if (isOverviewPage) {
    const params = new URLSearchParams(queryStringFromObject(filters));
    params.set("range", "all");
    params.set("session_state", "");
    window.location.href = `/?${params.toString()}`;
    return;
  }
  setFilters(filters, options);
}

function queryStringFromObject(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

function clearFilter(key) {
  if (!$("#filters")) return;
  const input = $(`[name="${key}"]`);
  if (input) input.value = "";
  if (key === "since" && $("#range-filter")) $("#range-filter").value = "all";
  load({ updateLocation: true }).catch(console.error);
}

function clearFields(loadAfter = true) {
  if (!$("#filters")) return;
  const sessionState = $("#session-state-filter")?.value || "captured";
  for (const field of formFields) {
    const input = $(`[name="${field}"]`);
    if (input) input.value = field === "limit" ? "500" : field === "session_state" ? sessionState : "";
  }
  syncSinceFromRange();
  syncSessionStateTabs();
  if (loadAfter) load({ updateLocation: true }).catch(console.error);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// truncateMiddle shortens value to maxLength visible characters, keeping both ends. It cuts between
// graphemes, so an emoji, flag or accented letter at the cut stays whole. It reads only the
// characters it keeps, so a long prompt costs no more than a short one.
function truncateMiddle(value, maxLength) {
  value = String(value || "");
  // Every grapheme is at least one UTF-16 unit, so a string this short has nothing to cut.
  if (value.length <= maxLength) return value;
  const segments = graphemes.segment(value);
  const head = [];
  for (const { segment } of segments) {
    if (head.length === maxLength) {
      const keep = Math.floor((maxLength - 3) / 2);
      const tail = [];
      for (let end = value.length; tail.length < keep; ) {
        const last = segments.containing(end - 1);
        tail.push(last.segment);
        end = last.index;
      }
      return `${head.slice(0, keep).join("")}...${tail.reverse().join("")}`;
    }
    head.push(segment);
  }
  return value;
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function applyPreset(name) {
  $$(".quick-filters [data-preset]").forEach((button) => button.classList.toggle("active", button.dataset.preset === name));
  applyFilters(presets[name] || {}, { reset: true });
}

function applyInsight(kind, value) {
  const key =
    kind === t("Top Actions") ? "action" :
    kind === t("Top Repositories") ? "repository" :
    kind === t("Agent Harnesses") ? "harness" :
    kind === t("Models") ? "model" :
    "mcp";
  applyFilters({ [key]: value });
}

function clearSearch() {
  clearFields();
}

const tokenRangeStorageKey = "beacon.dashboard.tokenRange";

function resolveTokenRange(params, stored) {
  const ranges = ["today", "7d", "30d", "all", "custom"];
  const next = new URLSearchParams(params);
  if (ranges.includes(next.get("range"))) return next;
  if (next.has("since") || next.has("until")) {
    next.set("range", "custom");
    return next;
  }
  let saved = null;
  try { saved = stored ? JSON.parse(stored) : null; } catch { saved = null; }
  const validCustom = saved?.range === "custom" && Number.isFinite(Date.parse(saved.since)) && Number.isFinite(Date.parse(saved.until)) && Date.parse(saved.since) <= Date.parse(saved.until);
  const range = ranges.includes(saved?.range) && (saved.range !== "custom" || validCustom) ? saved.range : "7d";
  next.set("range", range);
  if (range === "custom") {
    next.set("since", saved.since);
    next.set("until", saved.until);
  }
  return next;
}

function setupTokenControls() {
  let stored = null;
  try { stored = localStorage.getItem(tokenRangeStorageKey); } catch (error) { console.warn("Unable to read saved token range", error); }
  const params = resolveTokenRange(new URLSearchParams(window.location.search), stored);
  if (params.toString() !== new URLSearchParams(window.location.search).toString()) {
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}${window.location.hash}`);
  }
  const form = $("#token-filter-form");
  if (!form) return;
  for (const key of ["range", "harness", "model"]) {
    if (params.has(key)) form.elements.namedItem(key).value = params.get(key);
  }
  if (!params.has("range") && (params.has("since") || params.has("until"))) form.elements.namedItem("range").value = "custom";
  for (const key of ["since", "until"]) {
    const date = new Date(params.get(key));
    if (params.has(key) && Number.isFinite(date.getTime())) {
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
      form.elements.namedItem(key).value = local.toISOString().slice(0, 16);
    }
  }
  const pills = $$("#time-pills [data-range]");
  const updatePills = () => {
    const range = form.elements.namedItem("range").value;
    pills.forEach((pill) => {
      const active = pill.dataset.range === range;
      pill.classList.toggle("active", active);
      pill.setAttribute("aria-pressed", String(active));
    });
  };
  for (const pill of pills) {
    pill.addEventListener("click", () => {
      form.elements.namedItem("range").value = pill.dataset.range;
      updatePills();
      updateDates();
      setText("#token-filter-error", "");
      if (pill.dataset.range === "custom") return;
      // Users expect the range pills to apply right away; the SWR cache keeps the
      // reload fast and the refresh button still forces a network pass.
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    });
  }
  const updateDates = () => {
    const custom = form.elements.namedItem("range").value === "custom";
    for (const key of ["since", "until"]) {
      const input = form.elements.namedItem(key);
      input.closest("label").hidden = !custom;
    }
  };
  form.elements.namedItem("range").addEventListener("change", () => {
    updatePills();
    updateDates();
  });
  updatePills();
  updateDates();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = new URLSearchParams(window.location.search);
    for (const key of ["session", "since", "until", "range", "model", "harness"]) next.delete(key);
    const range = form.elements.namedItem("range").value;
    for (const key of ["range", "model", "harness"]) {
      const value = form.elements.namedItem(key).value.trim();
      if (value) next.set(key, value);
    }
    if (range === "custom") {
      const since = form.elements.namedItem("since").value;
      const until = form.elements.namedItem("until").value;
      const start = Date.parse(since);
      const end = Date.parse(until);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
        setText("#token-filter-error", t("Choose a valid start and end time"));
        return;
      }
      next.set("since", new Date(start).toISOString());
      next.set("until", new Date(end).toISOString());
    }
    try {
      localStorage.setItem(tokenRangeStorageKey, JSON.stringify({ range, since: next.get("since"), until: next.get("until") }));
    } catch (error) { console.warn("Unable to save token range", error); }
    if (next.toString() === window.location.search.replace(/^\?/, "")) {
      refreshData(loadTokens).catch(console.error);
    } else {
      window.location.search = next.toString();
    }
  });
  $("#token-reset").addEventListener("click", () => {
    const next = new URLSearchParams();
    if (params.has("lang")) next.set("lang", params.get("lang"));
    if (params.has("view")) next.set("view", params.get("view"));
    next.set("range", "7d");
    try { localStorage.removeItem(tokenRangeStorageKey); } catch (error) { console.warn("Unable to clear saved token range", error); }
    window.location.search = next.toString();
  });
  $("#token-session-search").addEventListener("input", () => window.BeaconAgentView.refresh());
  $("#token-session-sort").addEventListener("change", () => window.BeaconAgentView.refresh());
  $("#source-stale-retry").addEventListener("click", () => refreshData(loadTokens).catch(console.error));
}

let tokenRequestPending = false;
let tokenLastReport = null;
let tokenSessionMetadata = new Map();
let tokenMetadataCache = null;
let tokenMetadataCachedAt = 0;
let tokenAutoRefresh = true;

async function tokenJSON(path) {
  return getJSON(path, { signal: AbortSignal.timeout(30000) });
}


function setScopeChip(params) {
  const chip = $("#scope-chip");
  if (!chip) return;
  const rangeLabels = { today: t("Today"), "7d": t("Last 7 days"), "30d": t("Last 30 days"), all: t("All time"), custom: t("Custom") };
  const range = params.get("range");
  let scope = rangeLabels[range] || t("All time");
  if (range === "custom" || (!range && (params.get("since") || params.get("until")))) {
    const since = params.get("since") ? new Date(params.get("since")).toLocaleDateString() : "…";
    const until = params.get("until") ? new Date(params.get("until")).toLocaleDateString() : "…";
    scope = `${scope} (${since} ~ ${until})`;
  }
  const harness = params.get("harness") ? window.harnessLabel(params.get("harness")) : t("All Agents");
  const model = params.get("model") || t("All models");
  chip.textContent = `${t("Current range")}: ${scope} · ${t("Agent")} ${harness} · ${t("Model")} ${model}`;
}

async function loadTokens() {
  if (tokenRequestPending) return;
  tokenRequestPending = true;
  window.BeaconTokenInsights.coveragePending();
  const cards = $("#source-status-cards");
  if (cards) cards.replaceChildren();
  const banner = $("#source-stale-banner");
  if (banner) banner.hidden = false;
  setText("#source-stale-text", t("Loading collection status..."));
  setText("#token-coverage", t("Loading collection status..."));
  setText("#source-count-note", "");
  const retry = $("#source-stale-retry");
  if (retry) retry.disabled = true;
  const params = new URLSearchParams(window.location.search);
  const tokenParams = buildTokenQuery(params);
  const session = (params.get("session") || "").trim();
  const bucketLabel = document.querySelector("#bucket-label");
  if (bucketLabel) bucketLabel.textContent = tokenParams.get("bucket") === "24h" ? t("Daily buckets") : t("1h buckets");
  setScopeChip(params);
  try {
    const [status, report] = await Promise.all([
      tokenJSON("/api/status"),
      tokenJSON(`/api/tokens?${tokenParams.toString()}`),
    ]);
    state.status = status;
    state.error = null;
    if (!report || !report.totals || typeof report.totals !== "object") throw new Error("Invalid token report");
    tokenLastReport = report;
    let metadataError = "";
    try {
      if (!tokenMetadataCache || Date.now() - tokenMetadataCachedAt > 60000) {
        const result = await tokenJSON("/api/sessions?limit=5000");
        if (!Array.isArray(result.sessions)) throw new Error("Invalid session metadata");
        tokenMetadataCache = result;
        tokenMetadataCachedAt = Date.now();
      }
      tokenSessionMetadata = new Map(tokenMetadataCache.sessions.map(row => [row.id, row]));
    } catch (error) {
      metadataError = error.message;
      tokenSessionMetadata = new Map();
    }
    window.BeaconTokenInsights.update(report, status, tokenParams, metadataError ? null : tokenMetadataCache, metadataError);
    for (const row of report.native?.sessions || []) tokenSessionMetadata.set(row.id, row);
    window.BeaconAgentView.coverage({ runtimes: [] });
    window.BeaconAgentView.update(report, status, Array.from(tokenSessionMetadata.values()), {
      available: !metadataError,
      truncated: Boolean(tokenMetadataCache?.truncated),
      auditIds: metadataError ? [] : tokenMetadataCache.sessions.map((item) => item.id),
    });
    renderTokensPage(report, session);
    setText("#token-refresh-status", dataFreshnessText(`${t("Updated")}: `));
    const coverageParams = new URLSearchParams(tokenParams);
    for (const key of ["session", "model", "bucket"]) coverageParams.delete(key);
    try {
      const coverage = await tokenJSON(`/api/tokens/coverage?${coverageParams}`);
      renderTokenCoverage(coverage);
    } catch (err) {
      window.BeaconAgentView.coverage({ runtimes: [] });
      window.BeaconTokenInsights.coverageUnavailable();
      const cards = $("#source-status-cards");
      if (cards) cards.replaceChildren();
      const banner = $("#source-stale-banner");
      if (banner) banner.hidden = false;
      setText("#source-stale-text", `${t("Coverage unavailable")}: ${err.message}`);
      setText("#token-coverage", `${t("Coverage unavailable")}: ${err.message}`);
    }
  } catch (err) {
    state.error = err;
    window.BeaconAgentView.coverage({ runtimes: [] });
    window.BeaconTokenInsights.coverageUnavailable();
    setText("#source-stale-text", `${t("Coverage unavailable")}: ${err.message}`);
    setText("#token-coverage", `${t("Coverage unavailable")}: ${err.message}`);
    window.BeaconTokenInsights.stale();
    setText("#token-refresh-status", `${t("Refresh failed; previous data may be stale")}: ${err.message}`);
    setText("#token-meta", `${t("Failed to load token usage")}: ${err.message}`);
  } finally {
    tokenRequestPending = false;
    if (retry) retry.disabled = false;
  }
}

function buildTokenQuery(params, now = new Date()) {
  const query = new URLSearchParams({ bucket: "1h" });
  for (const key of ["session", "harness", "model", "since", "until"]) {
    if (params.get(key)) query.set(key, params.get(key));
  }
  const range = params.get("range");
  if (range === "all") {
    query.delete("since");
    query.delete("until");
  }
  if (["today", "7d", "30d"].includes(range)) {
    const since = new Date(now);
    if (range === "today") since.setHours(0, 0, 0, 0);
    else since.setTime(now.getTime() - Number.parseInt(range, 10) * 86400000);
    query.set("since", since.toISOString());
    query.set("until", now.toISOString());
    if (range === "30d") query.set("bucket", "24h");
  }
  return query;
}

function renderTokenCoverage(report) {
  window.BeaconAgentView.coverage(report);
  window.BeaconTokenInsights.coverage(report);
  const rows = Array.isArray(report.runtimes) ? report.runtimes : [];
  const labels = { covered: "Usage received", silent: "Activity without expected usage", inactive: "No activity in range", not_instrumented: "Capture path provides no tokens" };
  const pillClass = { covered: "ok", silent: "activity", inactive: "muted", not_instrumented: "muted" };
  const expectations = { reported: "Token usage supported", generic_otlp: "Generic telemetry only", none: "No token capture path" };
  const limits = {
    reported: "Usage events need not equal API requests",
    generic_otlp: "Separate evidence from usage events; no shared token totals",
    none: "The current path provides no tokens; do not show fake zeros",
  };
  const lastSeen = (harness) => {
    let latest = "";
    for (const [, meta] of tokenSessionMetadata) {
      if (meta.harness === harness && Date.parse(meta.last_event_at) > (Date.parse(latest) || 0)) {
        latest = meta.last_event_at;
      }
    }
    return latest ? new Date(latest).toLocaleString() : t("Unknown");
  };
  const cards = $("#source-status-cards");
  if (cards) {
    const count = (statusKey) => rows.filter((row) => row.status === statusKey).length;
    const warnings = tokenLastReport?.native?.warnings?.length ?? 0;
    cards.innerHTML = [
      { kind: "ok", label: t("Usage received"), value: count("covered") },
      { kind: "idle", label: t("No activity in range"), value: count("inactive") },
      { kind: "activity", label: t("Activity without expected usage"), value: count("silent") },
      { kind: "warn", label: t("Read failures"), value: warnings },
      { kind: "off", label: t("Not connected"), value: rows.filter((row) => row.harness === "grok_bot" || row.status === "not_instrumented").length },
    ]
      .map((card) => `<div class="source-status-card ${card.kind}"><span class="ssc-label">${escapeHTML(card.label)}</span><div class="ssc-count">${card.value}<small>${escapeHTML(t("sources"))}</small></div></div>`)
      .join("");
  }
  const banner = $("#source-stale-banner");
  if (banner) {
    const warnings = tokenLastReport?.native?.warnings ?? [];
    if (warnings.length) {
      banner.hidden = false;
      setText("#source-stale-text", `${t("Some sources failed to read; the previous successful results are kept")}: ${warnings.join(" · ")}`);
    } else {
      banner.hidden = true;
    }
  }
  const note = $("#source-count-note");
  if (note) {
    note.textContent = `${rows.length} ${t("sources")} · ${t("local data")}`;
  }
  const el = $("#token-coverage");
  if (!el) return;
  el.innerHTML =
    (rows.length
      ? `<table class="rank-table"><thead><tr><th>${escapeHTML(t("Source"))}</th><th>${escapeHTML(t("Status"))}</th><th>${escapeHTML(t("Record granularity"))}</th><th>${escapeHTML(t("Provided metrics"))}</th><th>${escapeHTML(t("Latest available session activity"))}</th><th>${escapeHTML(t("Read warnings and limits"))}</th><th>${escapeHTML(t("Actions"))}</th></tr></thead><tbody>${rows
          .map((row) => {
            const contextEvidence = (tokenLastReport?.native?.context_evidence ?? []).find((item) => item.harness === row.harness);
            const statusClass = ["covered", "silent", "inactive", "not_instrumented"].includes(row.status) ? pillClass[row.status] : "muted";
            const granularity = contextEvidence ? `<span class="granularity-chip info">${escapeHTML(t("Context occupancy"))}</span>` : row.status === "not_instrumented" ? `<span class="granularity-chip behavior">${escapeHTML(t("Behavior record"))}</span>` : row.status === "covered" ? `<span class="granularity-chip info">${escapeHTML(t("Usage events"))}</span>` : `<span class="muted">—</span>`;
            const metricsLabel = contextEvidence
              ? contextEvidence.context_tokens > 0
                ? t("Sessions, models and context occupancy (billing tokens unknown)")
                : t("Sessions and models (billing tokens unknown)")
              : expectations[row.expectation]
                ? t(expectations[row.expectation])
                : t("Unknown");
            const limitLabel = contextEvidence ? t("Billing tokens are accounted by Cursor servers and are not stored locally.") : t(limits[row.expectation] || "Unknown");
            return `<tr><td><strong>${escapeHTML(harnessLabel(row.harness))}</strong></td><td><span class="state-pill ${statusClass}">${escapeHTML(t(labels[row.status] || "Unknown"))}</span></td><td>${granularity}</td><td>${escapeHTML(metricsLabel)}</td><td>${escapeHTML(lastSeen(row.harness))}</td><td>${escapeHTML(limitLabel)}</td><td><button type="button" class="btn-secondary" data-source-detail="${escapeHTML(row.harness)}">${escapeHTML(t("Details"))}</button></td></tr>`;
          })
          .join("")}</tbody></table>`
      : `<p class="muted section-pad">${escapeHTML(t("No runtime evidence in this range"))}</p>`) +
    `<p class="method-note">${escapeHTML(t("Coverage uses the time and Agent filters only; it does not prove billing completeness."))} ${escapeHTML(t("Inventory detection is separate from observed activity and may not detect native snapshots."))}</p>`;
  $$("#token-coverage [data-source-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      const params = new URLSearchParams(window.location.search);
      params.set("harness", button.dataset.sourceDetail);
      params.set("view", "agents");
      window.location.search = params.toString();
    });
  });
}

function renderTokensPage(report, session) {
  setText("#log-path", state.status?.log_path || t("Runtime log unavailable"));
  renderUtilizationRows(report.utilization || []);
  renderSessionDetail(report.session_detail, session);
}

function usageTotal(usage = {}) {
  return (usage.input_tokens || 0) +
    (usage.output_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
}

// The estimate is labeled wherever it appears: it is a list price from the embedded catalog
// (or the operator's pricing overrides file), not what anyone was billed, and it sits beside the
// runtime-reported cost rather than in it.
function estimateHint(totals, pricing) {
  const overrides = pricing?.overrides;
  const parts = [t(overrides && !overrides.error ? "list price + overrides" : "list price")];
  const catalog = pricing?.catalog;
  if (catalog?.generated_at) parts.push(t("catalog {date}", { date: catalog.generated_at }));
  if (overrides?.error) parts.push(t("overrides file invalid, not used"));
  if (totals.unpriced_events) parts.push(t("{count} unpriced events excluded", { count: totals.unpriced_events }));
  return parts.join(" · ");
}

function formatEstimatedCost(usage = {}) {
  if (usage.estimated_cost_usd) return `~${usage.estimated_cost_usd.toFixed(4)}`;
  return usage.unpriced_events ? "?" : "-";
}

function renderTokenCards(totals, pricing) {
  if (!$("#token-cards")) return;
  const totalTokens = usageTotal(totals);
  const cards = [
    { label: t("Total Tokens"), value: formatTokens(totalTokens), rawValue: totalTokens, hint: t("local captured usage") },
    { label: t("Input Tokens"), value: formatTokens((totals.input_tokens || 0) + (totals.cache_read_input_tokens || 0) + (totals.cache_creation_input_tokens || 0)), rawValue: (totals.input_tokens || 0) + (totals.cache_read_input_tokens || 0) + (totals.cache_creation_input_tokens || 0), hint: t("fresh + cached") },
    { label: t("Output Tokens"), value: formatTokens(totals.output_tokens), rawValue: totals.output_tokens ?? 0, hint: t("includes reasoning") },
    { label: t("Cached Tokens"), value: formatTokens((totals.cache_read_input_tokens || 0) + (totals.cache_creation_input_tokens || 0)), rawValue: (totals.cache_read_input_tokens || 0) + (totals.cache_creation_input_tokens || 0) },
    { label: t("Reasoning"), value: formatTokens(totals.reasoning_output_tokens), rawValue: totals.reasoning_output_tokens ?? 0 },
    { label: t("Reported cost (USD)"), value: totals.cost_usd ? totals.cost_usd.toFixed(4) : "-", hint: t("runtime-reported only") },
    { label: t("Est. cost (USD)"), value: formatEstimatedCost(totals), hint: estimateHint(totals, pricing) },
  ];
  $("#token-cards").innerHTML = cards
    .map((card) => `
      <div class="card">
        <span class="muted">${escapeHTML(card.label)}</span>
        <span class="value"${card.rawValue !== undefined ? ` title="${escapeHTML(formatExactTokens(card.rawValue))}"` : ""}>${escapeHTML(card.value)}</span>
        ${card.hint ? `<span class="muted">${escapeHTML(card.hint)}</span>` : ""}
      </div>
    `)
    .join("");
}

function renderTokenSplit(totals) {
  const el = $("#token-split");
  if (!el) return;
  const freshInput = totals.input_tokens || 0;
  const cached = (totals.cache_read_input_tokens || 0) + (totals.cache_creation_input_tokens || 0);
  const output = totals.output_tokens || 0;
  const reasoning = totals.reasoning_output_tokens || 0;
  const segments = [
    { name: t("Input (fresh)"), value: freshInput, color: "#0f7498" },
    { name: t("Cached input"), value: cached, color: "#10b981" },
    { name: t("Output"), value: output, color: "#7dd3fc" },
  ].filter((segment) => segment.value > 0);
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (!total) {
    el.innerHTML = emptyAnalytics("No token split available for this range");
    return;
  }
  let cursor = 0;
  const stops = segments.map((segment) => {
    const start = cursor;
    cursor += (segment.value / total) * 100;
    return `${segment.color} ${start}% ${cursor}%`;
  }).join(", ");
  el.innerHTML = `
    <div class="token-donut" style="background: conic-gradient(${stops})">
      <div>
        <strong>${escapeHTML(formatCompactTokens(total))}</strong>
        <span>${escapeHTML(t("total tokens"))}</span>
      </div>
    </div>
    <div class="token-split-legend">
      ${segments.map((segment) => `
        <div>
          <span><i style="background:${segment.color}"></i>${escapeHTML(segment.name)}</span>
          <em>${escapeHTML(formatWholePercent(segment.value / total))}</em>
          <strong>${escapeHTML(formatCompactTokens(segment.value))}</strong>
        </div>
      `).join("")}
    </div>
    ${reasoning > 0 && output > 0 ? `<p class="muted token-reasoning-note">${escapeHTML(t("Reasoning: {count} tokens (included in output).", { count: formatTokens(reasoning) }))}</p>` : ""}
  `;
}

function renderTokenBreakdowns(report) {
  const el = $("#token-breakdowns");
  if (!el) return;
  const rows = [
    {
      title: t("Tokens by model"),
      breakdownTitle: t("Total tokens by model"),
      items: report.by_model || [],
      emptyLabel: "No model token attribution for this range.",
    },
    {
      title: t("Tokens by harness"),
      breakdownTitle: t("Total tokens by harness"),
      items: report.by_harness || [],
      emptyLabel: "No harness token attribution for this range.",
      labelFormatter: harnessLabel,
    },
    {
      title: t("Tokens by session"),
      breakdownTitle: t("Top token sessions"),
      items: report.by_session || [],
      emptyLabel: "No session token attribution for this range.",
      labelFormatter: formatSessionID,
      sessionLinks: true,
    },
  ];
  el.innerHTML = rows.map((row) => tokenBreakdownRowHTML(row)).join("");
  $$("[data-token-breakdown-session]").forEach((button) => {
    button.addEventListener("click", () => {
      const params = new URLSearchParams(window.location.search);
      params.set("session", button.dataset.tokenBreakdownSession);
      window.location.search = params.toString();
    });
  });
}

function tokenBreakdownRowHTML({ title, breakdownTitle, items, emptyLabel, labelFormatter = (value) => value, sessionLinks = false }) {
  const visibleItems = (items || [])
    .map((item) => ({ ...item, total: usageTotal(item.usage || {}) }))
    .filter((item) => item.total > 0 || (item.usage?.cost_usd || 0) > 0)
    .slice(0, 8);
  const total = visibleItems.reduce((sum, item) => sum + item.total, 0);
  const max = Math.max(1, ...visibleItems.map((item) => item.total));
  return `
    <div class="token-breakdown-row">
      <div class="analytics-panel">
        <div class="panel-title-row">
          <div>
            <h2>${escapeHTML(title)}</h2>
            <p class="muted">${escapeHTML(t("Token usage over the local log, stacked by the top observed values."))}</p>
          </div>
        </div>
        ${visibleItems.length ? `
          <div class="chart-legend">
            ${visibleItems.slice(0, 6).map((item, index) => `<span><i style="background:${chartColor(index)}"></i>${escapeHTML(truncateMiddle(labelFormatter(item.key), 20))}</span>`).join("")}
          </div>
          <div class="stacked-chart compact">
            ${visibleItems.map((item, index) => `
              <div class="stacked-chart-column">
                <span class="stacked-chart-bar" style="height:${Math.max(8, Math.round((item.total / max) * 100))}%; background:${chartColor(index)}"></span>
                <span class="stacked-chart-value">${escapeHTML(formatCompactTokens(item.total))}</span>
                <span class="stacked-chart-label">${escapeHTML(truncateMiddle(labelFormatter(item.key), 14))}</span>
              </div>
            `).join("")}
          </div>
        ` : emptyAnalytics(emptyLabel)}
      </div>
      <div class="analytics-panel">
        <div class="panel-title-row">
          <div>
            <h2>${escapeHTML(breakdownTitle)}</h2>
            <p class="muted">${escapeHTML(t("Total token counts for the selected range."))}</p>
          </div>
          <span class="panel-total">${escapeHTML(formatCompactTokens(total))}</span>
        </div>
        ${visibleItems.length ? `
          <div class="breakdown-list">
            ${visibleItems.map((item, index) => {
              const label = labelFormatter(item.key);
              const ratio = total > 0 ? item.total / total : 0;
              return `
                <button type="button" ${sessionLinks ? `data-token-breakdown-session="${escapeHTML(item.key)}"` : ""}>
                  <span><i style="background:${chartColor(index)}"></i><em>${escapeHTML(truncateMiddle(label, 30))}</em></span>
                  <small>${escapeHTML(formatWholePercent(ratio))}</small>
                  <strong>${escapeHTML(formatCompactTokens(item.total))}</strong>
                  <b style="width:${Math.max(item.total > 0 ? 4 : 0, (item.total / max) * 100)}%; background:${chartColor(index)}"></b>
                </button>
              `;
            }).join("")}
          </div>
        ` : emptyAnalytics(emptyLabel)}
      </div>
    </div>
  `;
}

function renderTokenThroughput(series) {
  const el = $("#token-throughput");
  if (!el) return;
  const rows = series
    .map((bucket) => ({ ...bucket, total: usageTotal(bucket.usage || {}) }))
    .filter((bucket) => bucket.total > 0)
    .slice(-24);
  if (!rows.length) {
    el.innerHTML = `<span class="muted">No token throughput captured yet.</span>`;
    return;
  }
  const max = Math.max(...rows.map((bucket) => bucket.total), 1);
  el.innerHTML = rows
    .map((bucket) => {
      const usage = bucket.usage || {};
      const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      const output = usage.output_tokens || 0;
      const inputWidth = Math.max(0, Math.round((input / max) * 100));
      const outputWidth = Math.max(0, Math.round((output / max) * 100));
      return `
        <div class="throughput-row">
          <span class="muted">${escapeHTML(formatTime(bucket.start))}</span>
          <div class="throughput-track" aria-hidden="true">
            <span class="throughput-input" style="width: ${Math.max(3, inputWidth)}%"></span>
            <span class="throughput-output" style="width: ${outputWidth}%"></span>
          </div>
          <strong>${escapeHTML(formatTokens(bucket.total))}</strong>
        </div>
      `;
    })
    .join("");
}

function renderUtilizationRows(utilization) {
  const tbody = $("#token-utilization");
  if (!tbody) return;
  if (!utilization.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">No usage with input tokens captured yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = utilization
    .map((item) => `
      <tr>
        <td class="mono">${escapeHTML(item.model)}</td>
        <td>${item.context_window ? formatTokens(item.context_window) : `<span class="muted">unknown</span>`}</td>
        <td>${escapeHTML(item.calls)}</td>
        <td>${formatTokens(item.max_input_tokens)}</td>
        <td>${formatRatio(item.max_ratio, item.context_window)}</td>
        <td>${formatRatio(item.p95_ratio, item.context_window)}</td>
        <td>${item.near_limit_calls ? badge(`${item.near_limit_calls} near limit`, "badge-warn") : ""}</td>
      </tr>
    `)
    .join("");
}

function renderUsageGroupRows(selector, groups, filterKey) {
  const tbody = $(selector);
  if (!tbody) return;
  if (!groups.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted">${escapeHTML(t("No usage captured yet."))}</td></tr>`;
    return;
  }
  tbody.innerHTML = groups
    .map((group) => `
      <tr ${filterKey === "session" ? `class="row-link" data-token-session="${escapeHTML(group.key)}"` : ""}>
        <td class="mono">${escapeHTML(group.key)}${filterKey === "session" && group.metadata ? `<br><small>${escapeHTML(group.metadata.title || "")} · ${escapeHTML(group.metadata.harness || "")} · ${escapeHTML(group.metadata.repository || "")} · ${escapeHTML(group.metadata.last_event_at ? new Date(group.metadata.last_event_at).toLocaleString() : "")}${group.metadata.parent_id ? ` · ${escapeHTML(t("Parent session"))}: ${escapeHTML(group.metadata.parent_id)}` : ""}</small>` : ""}</td>
        ${usageCells(group.usage)}
      </tr>
    `)
    .join("");
  $$(`${selector} [data-token-session]`).forEach((row) => {
    row.addEventListener("click", () => {
      const params = new URLSearchParams(window.location.search);
      params.set("session", row.dataset.tokenSession);
      window.location.search = params.toString();
    });
  });
}

function renderSessionDetail(detail, session) {
  const panel = $("#token-session-panel");
  if (!panel) return;
  if (!detail || !session) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  setText("#token-session-title", `Session ${formatSessionID(detail.session_id)}`);
  const rows = [];
  const walk = (steps, depth) => {
    for (const step of steps || []) {
      const label = step.name || step.action || step.span_id || "step";
      rows.push(`
        <tr>
          <td><span class="mono">${"&nbsp;".repeat(depth * 4)}${escapeHTML(label)}</span></td>
          <td class="mono">${escapeHTML(step.model || "")}</td>
          ${usageCells(step.usage, { events: false })}
        </tr>
      `);
      walk(step.children, depth + 1);
    }
  };
  walk(detail.steps, 0);
  $("#token-session-detail").innerHTML = rows.length
    ? rows.join("")
    : `<tr><td colspan="9" class="muted">No usage-bearing steps in this session.</td></tr>`;
}

function usageCells(usage = {}, { events = true } = {}) {
  const tokenValues = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens, usage.reasoning_output_tokens];
  const cells = [
    ...tokenValues.map(formatTokens),
    usage.cost_usd ? usage.cost_usd.toFixed(4) : "-",
    formatEstimatedCost(usage),
  ];
  if (events) cells.push(String(usage.events ?? 0));
  return cells.map((value, index) => `<td${index < tokenValues.length ? ` title="${escapeHTML(formatExactTokens(tokenValues[index]))}"` : ""}>${escapeHTML(value)}</td>`).join("");
}

function formatTokens(value) {
  return formatCompactTokens(value);
}

// Decimal SI units, at most two fractional digits. Promote after rounding so a
// value just below a boundary displays as 1M rather than 1000K. Invalid counts
// are shown as unavailable; raw telemetry and cost formatting are unchanged.
function formatCompactTokens(value) {
  if (value === undefined || value === null || value === "") {
    return "0";
  }
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0) {
    return "-";
  }
  // Token counts follow the industry convention (K/M/B/T), not byte-style G.
  const units = ["", "K", "M", "B", "T", "P", "E"];
  let scaled = number;
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  let rounded = Number(scaled.toFixed(2));
  if (rounded >= 1000 && unit < units.length - 1) {
    rounded = Number((scaled / 1000).toFixed(2));
    unit += 1;
  }
  return `${rounded}${units[unit]}`;
}

function formatExactTokens(value) {
  if (formatCompactTokens(value) === "-") {
    return "-";
  }
  return Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 20 });
}

function formatWholePercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function chartColor(index) {
  return ["#0f7498", "#7dd3fc", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#64748b", "#14b8a6"][index % 8];
}

function emptyAnalytics(label) {
  return `
    <div class="empty-chart">
      <strong>${escapeHTML(label)}</strong>
      <span>Telemetry will appear here once Agent Beacon events arrive.</span>
    </div>
  `;
}

function formatRatio(ratio, contextWindow) {
  if (!contextWindow) return "-";
  return `${(ratio * 100).toFixed(1)}%`;
}

async function loadDetections() {
  try {
    const resp = await getJSON("/api/detections");
    state.error = null;
    state.detections = resp;
    const meta = $("#detections-meta");
    if (meta) {
      const skipped = resp?.skipped?.length ?? 0;
      meta.hidden = !skipped;
      meta.textContent = skipped ? t("{count} rule files were skipped because they require a newer Beacon.", { count: skipped }) : "";
    }
    renderDetections(resp);
  } catch (err) {
    state.error = err;
    const meta = $("#detections-meta");
    if (meta) meta.hidden = false;
    setText("#detections-meta", t(state.detections ? "Rule refresh failed; showing the last successful results: {error}" : "Failed to load detections: {error}", { error: err.message }));
  }
}

let detectionSeverity = "";
let detectionQuery = "";

function detectionSeverityPill(severity) {
  const labels = { critical: "critical", high: "high", medium: "medium", low: "low" };
  const classes = { critical: "danger", high: "high", medium: "medium", low: "muted" };
  const key = labels[severity] ? severity : "unknown";
  return `<span class="state-pill ${classes[severity] ?? "muted"}">${escapeHTML(t(labels[key] ?? severity))}</span>`;
}

function detectionStatusPill(status) {
  if (status === "stable") {
    return `<span class="state-pill ok">${escapeHTML(t("Stable"))}</span>`;
  }
  if (status === "experimental") {
    return `<span class="state-pill muted">${escapeHTML(t("Experimental"))}</span>`;
  }
  return `<span class="state-pill muted">${escapeHTML(status || t("Unknown"))}</span>`;
}

function detectionTaxonomyLabel(taxonomy) {
  const category = taxonomy?.beacon_category || "";
  const labels = {
    "context-exfiltration": "Context exfiltration",
    "risky-command": "Risky command",
    "sensitive-edit": "Sensitive edit",
    "prompt-injection": "Prompt injection",
    "credential-access": "Credential access",
    "external-access": "External access",
    "source-control": "Source control",
    "agent-control": "Agent control",
    "approval-abuse": "Approval abuse",
    "resource-consumption": "Resource consumption",
  };
  return labels[category] ? t(labels[category]) : category ? t(category) : "—";
}

function detectionKindChip(kind) {
  const labels = { match: "Match", correlation: "Correlation" };
  if (!labels[kind]) return `<span class="muted">—</span>`;
  return `<span class="granularity-chip request">${escapeHTML(t(labels[kind]))}</span>`;
}

function renderDetections(resp) {
  const rules = resp?.rules || [];
  const filtered = rules.filter((rule) => {
    if (detectionSeverity && rule.severity !== detectionSeverity) return false;
    if (detectionQuery) {
      const haystack = [rule.id, rule.title, rule.description, rule.reason, rule.taxonomy?.beacon_category, detectionTaxonomyLabel(rule.taxonomy)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(detectionQuery)) return false;
    }
    return true;
  });
  const active = rules.filter((rule) => rule.status === "stable").length;
  const experimental = rules.filter((rule) => rule.status === "experimental").length;
  const categories = new Set(rules.map((rule) => rule.taxonomy?.beacon_category).filter(Boolean));

  const kpis = $("#detection-kpis");
  if (kpis) {
    const cards = [
      { label: t("Rules total"), value: String(rules.length) },
      { label: t("Stable rules"), value: String(active) },
      { label: t("Experimental rules"), value: String(experimental) },
      { label: t("Rule categories"), value: String(categories.size) },
    ];
    kpis.innerHTML = cards
      .map(
        (card) =>
          `<div class="kpi-card"><span class="kpi-label">${escapeHTML(card.label)}</span><span class="kpi-value">${escapeHTML(card.value)}</span></div>`,
      )
      .join("");
  }

  const count = $("#detection-count");
  if (count) {
    count.textContent = `${filtered.length} / ${rules.length} ${t("rules")}`;
  }

  const categoriesEl = $("#detection-categories");
  if (categoriesEl) {
    const counts = {};
    for (const rule of rules) {
      const category = rule.taxonomy?.beacon_category;
      if (category) counts[category] = (counts[category] ?? 0) + 1;
    }
    const chips = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([category, value]) => `<span class="granularity-chip">${escapeHTML(detectionTaxonomyLabel({ beacon_category: category }))} ${value}</span>`)
      .join("");
    categoriesEl.innerHTML = `<strong>${escapeHTML(t("Rule categories"))}</strong>${chips}`;
  }

  const tbody = $("#detections-rows");
  if (!tbody) return;
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted">${escapeHTML(t(rules.length ? "No matching rules." : "No rules were returned."))}</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered
    .map((rule) => `
      <tr id="rule-${escapeHTML(rule.id)}">
        <td><span class="mono">${escapeHTML(rule.id)}</span><br /><strong>${escapeHTML(rule.title || "")}</strong>${rule.description ? `<br /><span class="muted">${escapeHTML(rule.description)}</span>` : ""}</td>
        <td>${escapeHTML(detectionTaxonomyLabel(rule.taxonomy))}</td>
        <td>${detectionSeverityPill(rule.severity)}</td>
        <td>${detectionStatusPill(rule.status)}</td>
        <td>${escapeHTML(detectionPostureLabel(rule.posture))}</td>
        <td>${detectionKindChip(rule.kind)}</td>
        <td>${badge(rule.source || "unknown", "badge-muted")}</td>
        <td class="reason-cell">${escapeHTML(rule.reason || "")}</td>
      </tr>
    `)
    .join("");
  scrollDetectionHashIntoView();
}

function detectionPostureLabel(posture) {
  if (posture === "detect") return t("Detection only");
  if (posture === "enforce-capable") return t("Enforcement-capable rule");
  return posture || t("Unknown");
}

function scrollDetectionHashIntoView({ force = false } = {}) {
  if (!isDetectionsPage || !window.location.hash) return;
  let targetID = window.location.hash.slice(1);
  try {
    targetID = decodeURIComponent(targetID);
  } catch (_) {
    // Use the raw hash when the browser exposes a malformed escape sequence.
  }
  if (!targetID || (!force && state.lastDetectionHashScroll === targetID)) return;
  const target = document.getElementById(targetID);
  if (!target) return;
  target.scrollIntoView({ block: "start" });
  state.lastDetectionHashScroll = targetID;
}

let findingsLastResponse = null;
let findingsRulesPending = null;
const findingsSessionsPending = new Map();
async function loadFindings() {
  if (state.findingsLoading) return;
  state.findingsLoading = true;
  const exportButton = $("#findings-export");
  if (exportButton) exportButton.disabled = true;
  const params = new URLSearchParams(window.location.search);
  const minSeverity = (params.get("min_severity") || "").trim();
  const select = $("#min-severity");
  if (select) select.value = minSeverity;
  const query = new URLSearchParams();
  if (minSeverity) query.set("min_severity", minSeverity);
  const session = (params.get("session") || "").trim();
  if (session) query.set("session", session);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  try {
    const resp = await getJSON(`/api/findings${suffix}`);
    if (!resp || !Array.isArray(resp.findings) || !Number.isInteger(resp.scanned) || resp.scanned < 0 || !Number.isInteger(resp.count) || resp.count < 0 || (resp.skipped !== undefined && !Array.isArray(resp.skipped))) {
      throw new Error(t("Invalid findings response"));
    }
    state.error = null;
    state.findingsLoading = false;
    findingsLastResponse = resp;
    const alert = $("#findings-alert");
    if (alert) {
      const skipped = resp?.skipped?.length ?? 0;
      alert.hidden = !skipped;
      alert.textContent = skipped ? t("{count} rule files were skipped because they require a newer Beacon.", { count: skipped }) : "";
    }
    renderFindings(resp);
  } catch (err) {
    state.error = err;
    const exportButton = $("#findings-export");
    if (exportButton) exportButton.disabled = true;
    const alert = $("#findings-alert");
    if (alert) alert.hidden = false;
    setText("#findings-alert", t(findingsLastResponse ? "Findings refresh failed; showing the last successful results: {error}" : "Failed to load findings: {error}", { error: err.message }));
  } finally {
    state.findingsLoading = false;
  }
}

// A finding is the rule's match over its ordered supporting events, not its
// current row number. Legacy events without IDs use their complete JSON value.
function findingExpansionKey(finding) {
  if (!finding.events?.length) return null;
  const evidence = finding.events.map((event) => event.event?.id
    ? ["id", event.event.id]
    : ["event", JSON.stringify(event, (_key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
      }
      return value;
    })]);
  return JSON.stringify([finding.rule_id, finding.session_id || "", evidence]);
}

function remapFindingExpansions(previous, findings, expanded) {
  const previousKeys = previous.map(findingExpansionKey);
  const nextKeys = findings.map(findingExpansionKey);
  const counts = (keys) => keys.reduce((map, key) => map.set(key, (map.get(key) || 0) + 1), new Map());
  const previousCounts = counts(previousKeys);
  const nextCounts = counts(nextKeys);
  const selected = new Set(previousKeys.filter((key, i) => key !== null
    && expanded.has(i) && previousCounts.get(key) === 1));
  // Identical duplicate findings have no unambiguous identity. Collapse them
  // rather than selecting both or moving the user's choice to another row.
  return new Set(nextKeys.flatMap((key, i) => selected.has(key) && nextCounts.get(key) === 1 ? [i] : []));
}

function sortFindings(findings, order) {
  if (order !== "recent") return findings;
  const latest = (finding) => (finding.events || []).reduce((result, item) => {
    const timestamp = Date.parse(item.timestamp);
    return Number.isFinite(timestamp) ? Math.max(result, timestamp) : result;
  }, -Infinity);
  return [...findings].sort((a, b) => latest(b) - latest(a) || 0);
}

function renderFindings(resp) {
  const search = ($("#findings-search")?.value || "").trim().toLocaleLowerCase();
  const all = resp?.findings || [];
  const filtered = all.filter((item) =>
    [item.rule_id, item.title, item.session_id, item.reason].some((value) => String(value || "").toLocaleLowerCase().includes(search))
  );
  const findings = sortFindings(filtered, $("#findings-sort")?.value);
  state.findingsExpanded = remapFindingExpansions(state.findings, findings, state.findingsExpanded);
  state.findings = findings;
  const exportButton = $("#findings-export");
  if (exportButton) exportButton.disabled = findings.length === 0 || Boolean(state.error) || Boolean(state.findingsLoading);
  setText("#findings-meta", t("{count} findings across {total} events", { count: findings.length, total: resp?.scanned || 0 }));
  const sessions = new Set(findings.map((item) => item.session_id).filter(Boolean));
  const critical = findings.filter((item) => item.severity === "critical").length;
  const summary = $("#findings-summary");
  if (summary) {
    summary.innerHTML = [["Findings in range", findings.length], ["Critical findings", critical], ["Affected sessions", sessions.size]].map(([label, count]) => `<div class="card"><span class="muted">${escapeHTML(t(label))}</span><strong class="value">${escapeHTML(String(count))}</strong></div>`).join("");
  }
  const tbody = $("#findings-rows");
  if (!tbody) return;
  if (!findings.length) {
    state.findingsExpanded.clear();
    tbody.innerHTML = `<tr><td colspan="5" class="muted">${escapeHTML(t(search ? "No matching findings." : "No findings."))}</td></tr>`;
    return;
  }
  tbody.innerHTML = findings
    .map((f, i) => `
      <tr class="finding-row row-link" data-finding-row="${i}" role="button" tabindex="0" aria-expanded="false">
        <td>${badge(f.severity || "unknown", `severity-${f.severity || "unknown"}`)}</td>
        <td><span class="cell-link mono"><span class="cell-link-caret" aria-hidden="true">&#9656;</span>${escapeHTML(f.rule_id)}</span><br /><span class="muted">${escapeHTML(f.title || "")}</span></td>
        <td><span class="cell-link mono">${escapeHTML(formatSessionID(f.session_id, "-"))}</span></td>
        <td>${escapeHTML(f.reason || "")}</td>
        <td>${summarizeFindingEvents(f.events)}</td>
      </tr>
    `)
    .join("");
  $$("#findings-rows [data-finding-row]").forEach((row) => {
    row.addEventListener("click", () => toggleFinding(Number(row.dataset.findingRow)));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleFinding(Number(row.dataset.findingRow));
      }
    });
  });
  applyFindingExpansions();
}

function findingsCSV(findings) {
  const fields = ["severity", "rule_id", "title", "session_id", "reason", "latest_evidence_at"];
  const cell = (value) => {
    let text = value == null ? "" : String(value);
    if (/^\s*[=+@-]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const latest = (finding) => (finding.events || []).reduce((result, item) => {
    const time = Date.parse(item.timestamp);
    return Number.isFinite(time) && (result === null || time > Date.parse(result)) ? item.timestamp : result;
  }, null);
  return [fields, ...findings.map((finding) => fields.map((field) => field === "latest_evidence_at" ? latest(finding) : finding[field]))]
    .map((row) => row.map(cell).join(",")).join("\r\n");
}

function exportFindings() {
  if (!state.findings.length) return;
  const url = URL.createObjectURL(new Blob(["\uFEFF", findingsCSV(state.findings)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `beacon-findings-${Date.now()}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toggleFinding(i) {
  if (state.findingsExpanded.has(i)) state.findingsExpanded.delete(i);
  else {
    state.findingsRulesError = null;
    state.findingsSessionErrors.delete(state.findings[i]?.session_id);
    state.findingsExpanded.add(i);
  }
  applyFindingExpansions();
}

// applyFindingExpansions reconciles the inline detail rows with the set of
// expanded findings. It is idempotent: it removes any stale detail rows, then
// reinserts one detail row after each expanded finding. Async data loads
// (rule definitions, session events) call back into it once they resolve.
function applyFindingExpansions() {
  const tbody = $("#findings-rows");
  if (!tbody) return;
  Array.from(tbody.querySelectorAll(".finding-detail")).forEach((el) => el.remove());
  Array.from(tbody.querySelectorAll("[data-finding-row]")).forEach((row) => {
    row.setAttribute("aria-expanded", "false");
    row.classList.remove("open");
  });
  for (const i of state.findingsExpanded) {
    const row = tbody.querySelector(`tr[data-finding-row="${i}"]`);
    if (!row) continue;
    row.setAttribute("aria-expanded", "true");
    row.classList.add("open");
    row.insertAdjacentHTML("afterend", `<tr class="finding-detail"><td colspan="5">${findingDetailHTML(i)}</td></tr>`);
  }
}

function findingDetailHTML(i) {
  const f = state.findings[i];
  if (!f) return "";
  return `
    <div class="detail-panel">
      ${ruleDetailHTML(f.rule_id)}
      ${sessionDetailHTML(f.session_id)}
    </div>
  `;
}

async function ensureDetectionsCache() {
  if (state.findingsRules) return state.findingsRules;
  if (!findingsRulesPending) {
    findingsRulesPending = getJSON("/api/detections").then((resp) => {
      const map = Object.create(null);
      for (const rule of resp?.rules || []) map[rule.id] = rule;
      state.findingsRules = map;
      return map;
    }).finally(() => { findingsRulesPending = null; });
  }
  return findingsRulesPending;
}

function ruleDetailHTML(ruleId) {
  if (state.findingsRulesError) {
    return `<div class="detail-section"><h3>${escapeHTML(t("Detection rule"))}</h3><p class="muted">${escapeHTML(t("Rule definition could not be loaded: {error}", { error: state.findingsRulesError }))}</p></div>`;
  }
  if (!state.findingsRules) {
    ensureDetectionsCache().then(applyFindingExpansions).catch((error) => {
      state.findingsRulesError = error.message || String(error);
      applyFindingExpansions();
    });
    return `<div class="detail-section"><h3>${escapeHTML(t("Detection rule"))}</h3><p class="muted">${escapeHTML(t("Loading rule definition…"))}</p></div>`;
  }
  const rule = state.findingsRules[ruleId];
  if (!rule) {
    return `<div class="detail-section"><h3>${escapeHTML(t("Detection rule"))}</h3><p class="muted">${escapeHTML(t("No active rule found for {id}; it may have been removed.", { id: ruleId }))}</p></div>`;
  }
  const rows = [
    [t("Rule"), rule.id],
    [t("Title"), rule.title],
    [t("Severity"), rule.severity],
    [t("Status"), rule.status],
    [t("Posture"), rule.posture],
    [t("Kind"), rule.kind],
    [t("Source"), rule.source],
    [t("Reason"), rule.reason],
  ].filter(([, value]) => value);
  const taxonomy = rule.taxonomy ? Object.entries(rule.taxonomy) : [];
  return `
    <div class="detail-section">
      <h3>${escapeHTML(t("Detection rule"))}</h3>
      <div class="detail-grid">
        ${rows.map(([label, value]) => `<div><span class="muted">${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`).join("")}
      </div>
      ${rule.description ? `<p>${escapeHTML(rule.description)}</p>` : ""}
      ${taxonomy.length ? `<div class="detail-tags">${taxonomy.map(([key, value]) => badge(`${key}: ${value}`, "badge-muted")).join("")}</div>` : ""}
      <a class="text-button" href="/detections.html?lang=${encodeURIComponent(window.BeaconI18n.language)}#rule-${encodeURIComponent(rule.id)}">${escapeHTML(t("Open in Detections"))}</a>
    </div>
  `;
}

function sessionDetailHTML(sessionId) {
  if (!sessionId) {
    return `<div class="detail-section"><h3>${escapeHTML(t("Session timeline"))}</h3><p class="muted">${escapeHTML(t("This finding is not tied to a single session."))}</p></div>`;
  }
  if (state.findingsSessionErrors.has(sessionId)) {
    return `<div class="detail-section"><h3>${escapeHTML(t("Session timeline"))}</h3><p class="muted">${escapeHTML(t("Session timeline could not be loaded: {error}", { error: state.findingsSessionErrors.get(sessionId) }))}</p></div>`;
  }
  if (!state.findingsSessions.has(sessionId)) {
    ensureSessionEvents(sessionId).then(applyFindingExpansions).catch((error) => {
      state.findingsSessionErrors.set(sessionId, error.message || String(error));
      applyFindingExpansions();
    });
    return `<div class="detail-section"><h3>${escapeHTML(t("Session timeline"))}</h3><p class="muted">${escapeHTML(t("Loading session timeline…"))}</p></div>`;
  }
  const { records, truncated, total } = state.findingsSessions.get(sessionId);
  if (!records.length) {
    return `<div class="detail-section"><h3>${escapeHTML(t("Session timeline"))}</h3><p class="muted">${escapeHTML(t("No events found for session {id}.", { id: formatSessionID(sessionId) }))}</p></div>`;
  }
  return `
    <div class="detail-section">
      <div class="detail-head">
        <h3>${escapeHTML(t("Session timeline"))}</h3>
        <span class="muted">${escapeHTML(formatSessionID(sessionId))} &middot; ${records.length} event${records.length === 1 ? "" : "s"}</span>
        <a class="text-button" href="${escapeHTML(sessionPageURL(sessionId))}">${escapeHTML(t("Open session details"))}</a>
      </div>
      ${truncated ? `<p class="muted">${escapeHTML(t("Showing {shown} of {total} events; the timeline is incomplete.", { shown: records.length, total }))}</p>` : ""}
      <ol class="session-timeline">${records.map((record) => sessionTimelineRow(record)).join("")}</ol>
    </div>
  `;
}

async function ensureSessionEvents(sessionId) {
  if (state.findingsSessions.has(sessionId)) return state.findingsSessions.get(sessionId);
  if (!findingsSessionsPending.has(sessionId)) {
    // The session endpoint checks the full ID; /api/events uses substring matching.
    const pending = getJSON(`/api/session?id=${encodeURIComponent(sessionId)}`).then((resp) => {
      const allRecords = (resp?.events || []).slice().sort((a, b) => {
        const at = new Date(a.event?.timestamp || 0).getTime();
        const bt = new Date(b.event?.timestamp || 0).getTime();
        return at - bt;
      });
      const records = allRecords.slice(-500);
      const result = { records, truncated: allRecords.length > records.length, total: allRecords.length };
      state.findingsSessions.set(sessionId, result);
      return result;
    }).finally(() => { findingsSessionsPending.delete(sessionId); });
    findingsSessionsPending.set(sessionId, pending);
  }
  return findingsSessionsPending.get(sessionId);
}

function sessionTimelineRow(record) {
  const event = record.event || {};
  const info = event.event || {};
  const action = info.action || "event";
  const severity = event.severity || "unknown";
  const artifact = primaryArtifact(event) || event.message || "";
  return `
    <li>
      <span class="muted nowrap">${escapeHTML(formatTime(event.timestamp))}</span>
      ${badge(severity, `severity-${severity}`)}
      <span class="mono">${escapeHTML(action)}</span>
      ${artifact ? `<span class="artifact">${escapeHTML(truncateMiddle(artifact, 160))}</span>` : ""}
    </li>
  `;
}

function summarizeFindingEvents(events) {
  if (!events || !events.length) return `<span class="muted">-</span>`;
  return events
    .map((e) => {
      const action = e.event?.action || "event";
      let detail = "";
      if (e.command?.command) detail = e.command.command;
      else if (e.file?.path) detail = e.file.path;
      else if (e.prompt?.text) detail = e.prompt.text;
      const when = e.timestamp ? `${escapeHTML(formatTime(e.timestamp))} ` : "";
      const text = detail ? `${action}: ${detail}` : action;
      return `<div>${when}<span class="mono">${escapeHTML(text)}</span></div>`;
    })
    .join("");
}

const navIcons = {
  "Findings": `<svg viewBox="0 0 24 24"><path d="M21.73 18 13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  "Analytics": `<svg viewBox="0 0 24 24"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/></svg>`,
  "Token Usage": `<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/></svg>`,
  "Agent Activity": `<svg viewBox="0 0 24 24"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>`,
  "Agent Inventory": `<svg viewBox="0 0 24 24"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`,
  "Session Audit": `<svg viewBox="0 0 24 24"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>`,
  "Agent Activity Sessions": `<svg viewBox="0 0 24 24"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>`,
  "Hook Assets": `<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="3"/><line x1="12" y1="8" x2="12" y2="21"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg>`,
  "Memory": `<svg viewBox="0 0 24 24"><path d="M15.5 2H8.6c-.4 0-.8.2-.9.5L4.4 9.1a1 1 0 0 0 .9 1.5h13.4a1 1 0 0 0 .9-1.5L16.4 2.5c-.2-.3-.5-.5-.9-.5Z"/><path d="m12 10.6 0 11.4"/><path d="M8 14h8"/><path d="M9 18h6"/></svg>`,
  "Detections": `<svg viewBox="0 0 24 24"><path d="M19.07 4.93A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/></svg>`,
};

function decorateDashboardNav() {
  $$(".nav-toggle a, .nav-parent, .nav-section-title").forEach((item) => {
    if (item.querySelector(".nav-icon")) return;
    const label = item.textContent.trim();
    const icon = navIcons[label];
    if (!icon) return;
    item.innerHTML = `<span class="nav-icon" aria-hidden="true">${icon}</span><span>${escapeHTML(label)}</span>`;
  });
}

function setupNavCollapse() {
  const nav = $(".nav-toggle");
  if (!nav) return;
  let button = $(".nav-collapse");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "nav-collapse";
    button.textContent = "\u2039";
    nav.append(button);
  }

  const apply = (collapsed) => {
    document.body.classList.toggle("nav-collapsed", collapsed);
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    button.setAttribute("aria-label", collapsed ? t("Expand navigation") : t("Collapse navigation"));
    button.setAttribute("title", collapsed ? t("Expand navigation") : t("Collapse navigation"));
  };

  const initial = localStorage.getItem(navCollapsedStorageKey) === "1";
  apply(initial);
  button.addEventListener("click", () => {
    const collapsed = !document.body.classList.contains("nav-collapsed");
    localStorage.setItem(navCollapsedStorageKey, collapsed ? "1" : "0");
    apply(collapsed);
  });
}

const memoryPageSize = 50;
let memoryView = "evaluations";
let memoryPage = 1;
let memoryQuery = "";
let memoryGeneration = 0;

async function loadMemory() {
  if (!isMemoryPage) return;
  const generation = ++memoryGeneration;
  state.loading = true;
  state.error = null;
  renderMemoryLoading();
  try {
    const query = new URLSearchParams({ limit: String(memoryPageSize), page: String(memoryPage) });
    if (memoryQuery) query.set("q", memoryQuery);
    const data = await getJSON(`/api/memory?${query}`);
    if (generation !== memoryGeneration) return;
    state.memory = data;
    state.memoryLoadedQuery = memoryQuery;
    state.memoryLoadedPage = memoryPage;
  } catch (err) {
    if (generation === memoryGeneration) state.error = err;
  } finally {
    if (generation === memoryGeneration) {
      state.loading = false;
      renderMemory();
    }
  }
}

function renderMemoryLoading() {
  setText("#memory-status", t("Loading Beacon memory..."));
  if ($("#memory-prev")) $("#memory-prev").disabled = true;
  if ($("#memory-next")) $("#memory-next").disabled = true;
}

function setupMemoryControls() {
  const search = $("#memory-search");
  $("#memory-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    memoryQuery = search?.value.trim() || "";
    memoryPage = 1;
    loadMemory().catch(console.error);
  });
  $("#memory-clear")?.addEventListener("click", () => {
    if (search) search.value = "";
    memoryQuery = "";
    memoryPage = 1;
    loadMemory().catch(console.error);
  });
  $$("[data-memory-view]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.memoryView === memoryView) return;
      memoryView = button.dataset.memoryView;
      memoryPage = 1;
      loadMemory().catch(console.error);
    });
  });
  $("#memory-prev")?.addEventListener("click", () => {
    if (memoryPage <= 1) return;
    memoryPage -= 1;
    loadMemory().catch(console.error);
  });
  $("#memory-next")?.addEventListener("click", () => {
    memoryPage += 1;
    loadMemory().catch(console.error);
  });
}

function renderMemory() {
  if (!isMemoryPage) return;
  if (state.error) {
    setText("#memory-status", t(state.memory ? "Memory refresh failed; showing the last successful results: {error}" : "Memory could not be loaded: {error}", { error: state.error.message || String(state.error) }));
    if ($("#memory-prev")) $("#memory-prev").disabled = true;
    if ($("#memory-next")) $("#memory-next").disabled = true;
    return;
  }
  const data = state.memory || {};
  const status = data.status || {};
  const counts = [[t("Evaluations"), status.evaluations], [t("Candidates"), status.candidates], [t("Approved Memory"), status.approved_memories]];
  const summary = $("#memory-summary");
  if (summary) summary.innerHTML = counts.map(([label, value]) => `<div class="inventory-summary-card"><span>${escapeHTML(label)}</span><strong>${escapeHTML(Number.isFinite(value) ? String(value) : "—")}</strong></div>`).join("");
  setText("#memory-status", t("{evaluations} evaluations, {candidates} candidates, {memories} approved memories", { evaluations: status.evaluations ?? "—", candidates: status.candidates ?? "—", memories: status.approved_memories ?? "—" }));
  renderMemoryTable("#memory-evaluations", data.evaluations || [], (item) => [
    item.id || "",
    item.trace?.id || "",
    item.status || "",
    formatScore(item.score),
    item.trace?.title || "",
  ], 5);
  renderMemoryTable("#memory-candidates", data.candidates || [], (item) => [
    item.id || "",
    item.state || "",
    item.kind || "",
    item.title || "",
  ], 4);
  renderMemoryTable("#memory-approved", data.memories || [], (item) => [
    item.id || "",
    item.kind || "",
    item.title || "",
    item.applicability || "",
  ], 4);
  $$("[data-memory-panel]").forEach((panel) => { panel.hidden = panel.dataset.memoryPanel !== memoryView; });
  $$("[data-memory-view]").forEach((button) => {
    const active = button.dataset.memoryView === memoryView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const rows = data[memoryView] || [];
  setText("#memory-range", t("Showing {shown} records on page {page}; counts above cover the entire store.", { shown: rows.length, page: state.memoryLoadedPage }));
  setText("#memory-page", t("Page {page}", { page: state.memoryLoadedPage }));
  if ($("#memory-prev")) $("#memory-prev").disabled = memoryPage <= 1;
  if ($("#memory-next")) $("#memory-next").disabled = rows.length < memoryPageSize;
}

function renderMemoryTable(selector, items, rowFn, columnCount) {
  const tbody = $(selector);
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!items.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = columnCount;
    cell.className = "muted";
    cell.textContent = t(state.memoryLoadedQuery ? "No records match this search." : "No records yet.");
    row.append(cell);
    tbody.append(row);
    return;
  }
  for (const item of items) {
    const row = document.createElement("tr");
    for (const value of rowFn(item)) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    tbody.append(row);
  }
}

function formatScore(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  return value.toFixed(2);
}

decorateDashboardNav();
setupNavCollapse();

$("#findings-search")?.addEventListener("input", () => {
  if (findingsLastResponse) renderFindings(findingsLastResponse);
});
$("#findings-export")?.addEventListener("click", exportFindings);
$("#findings-sort")?.addEventListener("change", () => {
  if (findingsLastResponse) renderFindings(findingsLastResponse);
});
$("#min-severity")?.addEventListener("change", (event) => {
  const params = new URLSearchParams(window.location.search);
  if (event.target.value) params.set("min_severity", event.target.value);
  else params.delete("min_severity");
  window.location.search = params.toString();
});

$("#inventory-show-all")?.addEventListener("change", () => renderInventoryConfigs(state.inventory?.configs || []));
$("#hook-search")?.addEventListener("input", () => {
  const ctx = currentInventoryContext();
  renderHookTargets(ctx.hooks, ctx.configs);
  renderHookManifests(ctx.hookConfigs);
});
$("#inventory-runtime-filter")?.addEventListener("change", (event) => {
  state.inventoryRuntime = event.target.value;
  updateInventoryURL();
  renderInventoryWorkspace(state.inventory, currentInventoryContext());
});
$("#inventory-user-filter")?.addEventListener("change", (event) => {
  state.inventoryUser = event.target.value;
  updateInventoryURL();
  renderInventoryWorkspace(state.inventory, currentInventoryContext());
});
$("#inventory-search")?.addEventListener("input", (event) => {
  state.inventorySearch = event.target.value;
  updateInventoryURL();
  renderInventoryActiveTable(currentInventoryContext());
});
$("#filters")?.addEventListener("submit", (event) => {
  event.preventDefault();
  load({ updateLocation: true }).catch(console.error);
});
$("#clear-search")?.addEventListener("click", clearSearch);
$("#close-drawer")?.addEventListener("click", closeDrawer);
window.addEventListener("hashchange", () => scrollDetectionHashIntoView({ force: true }));
$$("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => applyPreset(button.dataset.preset));
});

// Lens tabs on the session page. Each lens runs in a sandboxed frame served by /lenses/frame/<id>
// (see spec/lenses/SPEC.md). This is the host half of the protocol: it hands the frame one
// MessagePort and answers getTrace over it with /api/lens-data. The frame never reaches the
// dashboard any other way, and a lens that fails or stalls before it renders gives way to the full
// session view.
const lensAddedStorageKey = "beacon.dashboard.lenses";
const lensRenderTimeoutMs = 10000;
// After the data is delivered, a lens that throws within this window is treated as having failed
// to render rather than as a lens with a late bug.
const lensSettleMs = 1000;
const lensMaxFrameHeight = 200000;

const lensHost = {
  session: "",
  lenses: [],
  added: [],
  active: "",
  mount: null,
};

function readAddedLenses() {
  try {
    const value = JSON.parse(localStorage.getItem(lensAddedStorageKey) || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch (_) {
    return [];
  }
}

function writeAddedLenses(ids) {
  try {
    localStorage.setItem(lensAddedStorageKey, JSON.stringify(ids));
  } catch (_) {
    // Remembering tabs is a convenience; a browser without storage still works.
  }
}

function lensByID(id) {
  return lensHost.lenses.find((lens) => lens.id === id);
}

async function initLensTabs() {
  const params = new URLSearchParams(window.location.search);
  lensHost.session = (params.get("id") || "").trim();
  if (!lensHost.session || !$("#lens-tabs")) return;
  try {
    lensHost.lenses = (await getJSON("/api/lenses")).lenses || [];
  } catch (err) {
    console.warn("lenses unavailable", err);
    lensHost.lenses = [];
  }
  lensHost.added = readAddedLenses().filter((id) => lensByID(id));
  const wanted = (params.get("lens") || "").trim();
  if (wanted && lensByID(wanted) && !lensHost.added.includes(wanted)) {
    lensHost.added.push(wanted);
    writeAddedLenses(lensHost.added);
  }

  const addButton = $("#lens-add-button");
  addButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleLensMenu();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".lens-add")) toggleLensMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") toggleLensMenu(false);
  });
  window.addEventListener("popstate", () => {
    const id = new URLSearchParams(window.location.search).get("lens") || "";
    selectLens(lensByID(id) ? id : "", { history: false });
  });

  renderLensTabs();
  selectLens(lensByID(wanted) ? wanted : "", { history: false });
}

function renderLensTabs() {
  const tabs = $("#lens-tabs");
  tabs.replaceChildren();
  const tab = (id, title) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lens-tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(lensHost.active === id));
    button.dataset.lens = id;
    button.addEventListener("click", () => {
      // The active tab is already showing; reselecting it would reload the lens and push a
      // duplicate history entry.
      if (lensHost.active !== id) selectLens(id);
    });
    const label = document.createElement("span");
    label.textContent = title;
    button.append(label);
    return button;
  };
  tabs.append(tab("", t("Full session")));
  for (const id of lensHost.added) {
    const lens = lensByID(id);
    const button = tab(id, lens.title);
    const remove = document.createElement("span");
    remove.className = "lens-tab-remove";
    remove.setAttribute("role", "button");
    remove.setAttribute("aria-label", `Remove the ${lens.title} lens`);
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeLens(id);
    });
    button.append(remove);
    tabs.append(button);
  }
  renderLensMenu();
}

function renderLensMenu() {
  const menu = $("#lens-menu");
  menu.replaceChildren();
  const available = lensHost.lenses.filter((lens) => !lensHost.added.includes(lens.id));
  if (available.length === 0) {
    const empty = document.createElement("span");
    empty.className = "lens-menu-empty";
    empty.textContent = lensHost.lenses.length ? "Every lens is already open." : "No lenses are installed.";
    menu.append(empty);
    return;
  }
  for (const lens of available) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "lens-menu-item";
    item.setAttribute("role", "menuitem");
    const title = document.createElement("span");
    title.className = "lens-menu-title";
    title.textContent = lens.title;
    item.append(title);
    if (lens.description) {
      const description = document.createElement("span");
      description.className = "lens-menu-description";
      description.textContent = lens.description;
      item.append(description);
    }
    item.addEventListener("click", () => {
      lensHost.added.push(lens.id);
      writeAddedLenses(lensHost.added);
      toggleLensMenu(false);
      selectLens(lens.id);
    });
    menu.append(item);
  }
}

function toggleLensMenu(open) {
  const menu = $("#lens-menu");
  const button = $("#lens-add-button");
  if (!menu || !button) return;
  const show = open === undefined ? menu.hidden : open;
  menu.hidden = !show;
  button.setAttribute("aria-expanded", String(show));
}

function removeLens(id) {
  lensHost.added = lensHost.added.filter((added) => added !== id);
  writeAddedLenses(lensHost.added);
  if (lensHost.active === id) {
    selectLens("");
  } else {
    renderLensTabs();
  }
}

function selectLens(id, { history = true } = {}) {
  if (id && !lensHost.added.includes(id)) {
    // Reached through history after its tab was removed: show the tab again with the lens.
    lensHost.added.push(id);
    writeAddedLenses(lensHost.added);
  }
  lensHost.active = id;
  if (history) {
    const params = new URLSearchParams(window.location.search);
    if (id) params.set("lens", id);
    else params.delete("lens");
    window.history.pushState(null, "", `${window.location.pathname}?${params}`);
  }
  if (id) $("#lens-notice").hidden = true;
  $("#session-detail-view").dataset.view = id ? "lens" : "full";
  $("#lens-view").hidden = !id;
  renderLensTabs();
  if (id) mountLens(lensByID(id));
  else unmountLens();
}

function lensData(mount) {
  if (!mount.dataPromise) {
    // A frame receives one snapshot. Reopening creates a new mount and fetches
    // current data without changing the snapshot of a frame already on screen.
    mount.dataPromise = getJSON(`/api/lens-data?session=${encodeURIComponent(lensHost.session)}`);
    mount.dataPromise.catch(() => {
      mount.dataPromise = null;
    });
  }
  return mount.dataPromise;
}

function unmountLens() {
  const mount = lensHost.mount;
  if (!mount) return;
  lensHost.mount = null;
  clearTimeout(mount.timer);
  clearTimeout(mount.settleTimer);
  if (mount.port) mount.port.close();
  mount.frame.remove();
}

function mountLens(lens) {
  unmountLens();
  const status = $("#lens-status");
  status.hidden = false;
  status.textContent = `Loading ${lens.title}...`;

  const frame = document.createElement("iframe");
  frame.className = "lens-frame";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.referrerPolicy = "no-referrer";
  frame.title = `${lens.title} lens`;
  frame.src = `/lenses/frame/${encodeURIComponent(lens.id)}`;

  const mount = { lens, frame, dataPromise: null, port: null, loads: 0, delivered: false, rendered: false, timer: 0, settleTimer: 0 };
  lensHost.mount = mount;
  const fail = (reason) => {
    if (lensHost.mount !== mount) return;
    const notice = $("#lens-notice");
    selectLens("", { history: false });
    const params = new URLSearchParams(window.location.search);
    params.delete("lens");
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
    notice.textContent = `The ${lens.title} lens could not be shown (${reason}). Showing the full session instead.`;
    notice.hidden = false;
  };
  const rendered = () => {
    if (lensHost.mount !== mount || mount.rendered) return;
    mount.rendered = true;
    clearTimeout(mount.timer);
    status.hidden = true;
  };
  mount.timer = setTimeout(() => fail("it did not render within 10 seconds"), lensRenderTimeoutMs);

  frame.addEventListener("load", () => {
    // A load queued before this lens was unmounted still fires; the frame is detached by then
    // and has no window to post to.
    if (lensHost.mount !== mount) return;
    mount.loads += 1;
    if (mount.loads > 1) {
      // The lens navigated its own frame. Whatever loaded now is not the lens that was vetted,
      // so it gets no port and the lens is closed.
      fail("it navigated away from itself");
      return;
    }
    const channel = new MessageChannel();
    mount.port = channel.port1;
    mount.port.onmessage = (event) => {
      if (lensHost.mount !== mount) return;
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "getTrace") {
        // The fetch can outlive this mount (another tab selected, the lens failed); its port is
        // closed by then, and posting to it would throw.
        const reply = (payload) => {
          if (lensHost.mount !== mount) return false;
          mount.port.postMessage(payload);
          return true;
        };
        lensData(mount).then(
          (data) => reply({ type: "trace", data }),
          (err) => reply({ type: "traceError", message: String(err.message || err) }),
        ).then((sent) => {
          if (!sent) return;
          mount.delivered = true;
          mount.settleTimer = setTimeout(rendered, lensSettleMs);
        });
      } else if (message.type === "resize") {
        const height = Number(message.height);
        if (Number.isFinite(height)) {
          frame.style.height = `${Math.min(Math.max(height, 0), lensMaxFrameHeight)}px`;
        }
        if (mount.delivered && height > 0) rendered();
      } else if (message.type === "error") {
        const reason = String(message.message || "error").slice(0, 200);
        if (mount.rendered) console.warn(`lens ${lens.id}: ${reason}`);
        else fail(`it raised an error: ${reason}`);
      }
    };
    // The frame's origin is opaque, so "*" is the only target that reaches it. The message carries
    // the port and nothing else; the trace only ever crosses the port.
    frame.contentWindow.postMessage({ type: "beacon.lens.connect", version: 1 }, "*", [channel.port2]);
  });
  $("#lens-frame-slot").append(frame);
}

// Shared shell: clock, language pills and top status come from the page data sources.
function setupShell() {
  const clock = $("#shell-clock");
  if (clock) {
    const tick = () => {
      const offset = -new Date().getTimezoneOffset() / 60;
      clock.textContent = `${new Date().toLocaleTimeString([], { hour12: false })} · UTC${offset >= 0 ? "+" : ""}${offset}`;
    };
    tick();
    setInterval(tick, 1000);
  }
  const lang = $("#shell-lang");
  if (lang) {
    const current = window.BeaconI18n.language;
    for (const button of lang.querySelectorAll("button")) {
      button.classList.toggle("active", button.dataset.lang === current);
      button.addEventListener("click", () => {
        if (button.dataset.lang === current) return;
        window.BeaconI18n.setLanguage(button.dataset.lang);
      });
    }
  }
  const refresh = $("#shell-refresh");
  if (refresh) {
    refresh.addEventListener("click", () => {
      if (typeof window.__beaconForceRefresh === "function") {
        window.__beaconForceRefresh();
      }
    });
  }
  const remoteAdd = $("#remote-add");
  if (remoteAdd) {
    remoteAdd.addEventListener("click", async () => {
      const feedback = $("#remote-feedback");
      const body = {
        name: $("#remote-name")?.value ?? "",
        url: $("#remote-url")?.value ?? "",
        token: $("#remote-token")?.value ?? "",
      };
      try {
        const response = await fetch("/api/remote-sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          if (feedback) feedback.textContent = payload.error || String(response.status);
          return;
        }
        for (const id of ["remote-name", "remote-url", "remote-token"]) {
          const input = document.getElementById(id);
          if (input) input.value = "";
        }
        if (feedback) feedback.textContent = t("Source added");
        // Mutations must not be masked by the stale-while-revalidate cache.
        window.clearDataCache("/api/remote-sources");
        loadRemoteSources().catch(console.error);
      } catch (error) {
        if (feedback) feedback.textContent = String(error.message || error);
      }
    });
  }
  const bucketToggle = document.querySelector("#activity-bucket-toggle");
  if (bucketToggle) {
    bucketToggle.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-bucket]");
      if (!button) return;
      overviewBucket = button.dataset.bucket;
      for (const option of bucketToggle.querySelectorAll("button")) {
        option.classList.toggle("active", option === button);
      }
      renderOverviewHourly(state.sessionResult?.sessions ?? []);
    });
  }
  // Findings count badge next to the sidebar entry (design board shows a count).
  const findingsLink = document.querySelector('.nav-toggle a[href="/findings.html"]');
  if (findingsLink) {
    const badge = document.createElement("span");
    badge.className = "nav-badge";
    badge.hidden = true;
    findingsLink.append(badge);
    getJSON("/api/findings?limit=1", { signal: AbortSignal.timeout(15000) })
      .then((resp) => {
        const count = Number(resp?.count ?? 0);
        window.__beaconFindingsCount = count;
        if (count > 0) {
          badge.textContent = String(count);
          badge.hidden = false;
        }
        if (isOverviewPage) renderOverviewAttention(state.summary ?? {});
      })
      .catch(console.error);
  }
}

async function setupShellStatus() {
  const pill = $("#shell-status");
  if (!pill || isTokensPage) return;
  try {
    const status = await getJSON("/api/status", { signal: AbortSignal.timeout(15000) });
    const healthy = status?.collector?.health_ready === true;
    pill.className = `status-pill ${healthy ? "" : "is-warn"}`;
    pill.textContent = healthy ? t("Collection normal") : t("Health not confirmed");
    if (status?.version) setText("#shell-version", String(status.version));
  } catch (error) {
    pill.className = "status-pill is-danger";
    pill.textContent = t("Connection failed");
  }
}

setupShell();
setupShellStatus().catch(console.error);

// The dashboard CSP (default-src 'self') silently drops style attributes present in markup.
// Legacy renderers emit dynamic sizes and colors that way, so re-apply each blocked attribute
// through the CSSOM exactly once; childList-only observation keeps this from looping.
const cspStyleSeen = new WeakSet();
function reapplyBlockedStyles(root) {
  if (root.nodeType !== 1) return;
  const targets = root.hasAttribute?.("style") ? [root, ...root.querySelectorAll("[style]")] : [...root.querySelectorAll("[style]")];
  for (const element of targets) {
    if (cspStyleSeen.has(element)) continue;
    cspStyleSeen.add(element);
    const css = element.getAttribute("style");
    if (css) element.style.cssText = css;
  }
}
const cspStyleObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) reapplyBlockedStyles(node);
  }
});
reapplyBlockedStyles(document.body);
cspStyleObserver.observe(document.body, { childList: true, subtree: true });

if (isDetectionsPage) {
  const severityTabs = $("#detection-severity-tabs");
  if (severityTabs) {
    severityTabs.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-severity]");
      if (!button) return;
      detectionSeverity = button.dataset.severity;
      for (const option of severityTabs.querySelectorAll("button")) {
        option.classList.toggle("active", option === button);
        option.setAttribute("aria-pressed", String(option === button));
      }
      const rules = state.detections?.rules ?? [];
      renderDetections({ rules });
    });
  }
  const search = $("#detection-search");
  if (search) {
    search.addEventListener("input", () => {
      detectionQuery = search.value.trim().toLowerCase();
      const rules = state.detections?.rules ?? [];
      renderDetections({ rules });
    });
  }
  window.__beaconForceRefresh = () => refreshData(loadDetections);
  loadDetections().catch(console.error);
  setInterval(() => { if (!document.hidden) refreshData(loadDetections).catch(console.error); }, 60000);
} else if (isFindingsPage) {
  window.__beaconForceRefresh = () => refreshData(loadFindings);
  loadFindings().catch(console.error);
  setInterval(() => { if (!document.hidden) refreshData(loadFindings).catch(console.error); }, 60000);
} else if (isTokensPage) {
  setupTokenControls();
  window.BeaconAgentView.setup();
  window.BeaconTokenInsights.setupViews();
  const pauseButton = document.createElement("button");
  pauseButton.type = "button";
  pauseButton.className = "btn-secondary";
  pauseButton.textContent = t("Pause auto refresh");
  pauseButton.addEventListener("click", () => {
    tokenAutoRefresh = !tokenAutoRefresh;
    pauseButton.textContent = t(tokenAutoRefresh ? "Pause auto refresh" : "Resume auto refresh");
    pauseButton.setAttribute("aria-pressed", String(!tokenAutoRefresh));
  });
  $("#token-refresh").after(pauseButton);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && tokenAutoRefresh) refreshData(loadTokens).catch(console.error);
  });
  window.__beaconForceRefresh = () => (tokenAutoRefresh ? refreshData(loadTokens) : loadTokens().catch(console.error));
  loadTokens().catch(console.error);
  setInterval(() => { if (!document.hidden && tokenAutoRefresh) refreshData(loadTokens).catch(console.error); }, 60000);
} else if (isSessionDetailPage) {
  initLensTabs().catch(console.error);
  $("#session-detail-retry")?.addEventListener("click", () => refreshData(loadSessionPage).catch(console.error));
  window.__beaconForceRefresh = () => refreshData(loadSessionPage);
  loadSessionPage().catch(console.error);
  setInterval(() => { if (!document.hidden) refreshData(loadSessionPage).catch(console.error); }, 60000);
} else if (isInventoryPage) {
  hydrateInventoryStateFromURL();
  window.__beaconForceRefresh = () => refreshData(loadInventory);
  loadInventory().catch(console.error);
  setInterval(() => { if (!document.hidden) refreshData(loadInventory).catch(console.error); }, 60000);
} else if (isMemoryPage) {
  setupMemoryControls();
  window.__beaconForceRefresh = () => refreshData(loadMemory);
  loadMemory().catch(console.error);
  setInterval(() => { if (!document.hidden) refreshData(loadMemory).catch(console.error); }, 60000);
} else {
  hydrateFiltersFromURL();
  setupSessionFilters();
  window.__beaconForceRefresh = () => refreshData(() => load({ mode: "poll" }));
  load().catch(console.error);
  setInterval(() => { if (!document.hidden) refreshData(() => load({ mode: "poll" })).catch(console.error); }, 60000);
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}
