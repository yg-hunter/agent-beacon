import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = fs.readFileSync(new URL('../../static/app.js', import.meta.url), 'utf8');
const names = new Set([
  'findingExpansionKey',
  'remapFindingExpansions',
  'sortFindings',
  'renderFindings',
]);
const functions = parse(source, { ecmaVersion: 'latest' })
  .body.filter((node) => node.type === 'FunctionDeclaration' && names.has(node.id.name))
  .map((node) => source.slice(node.start, node.end));
assert.equal(functions.length, names.size);

test('recent sorting uses latest supporting event and leaves unknown times last', () => {
  const local = vm.createContext({});
  vm.runInContext(functions.join('\n'), local);
  const rows = [
    { rule_id: 'unknown', events: [] },
    { rule_id: 'old', events: [{ timestamp: '2026-01-01T00:00:00Z', event: { action: 'test' } }] },
    { rule_id: 'new', events: [{ timestamp: '2026-01-03T00:00:00Z', event: { action: 'test' } }] },
  ];
  assert.deepEqual(
    Array.from(local.sortFindings(rows, 'recent'), (row) => row.rule_id),
    ['new', 'old', 'unknown'],
  );
  assert.equal(rows[0].rule_id, 'unknown');
});

test('sorting and refresh retain the expanded finding by stable event identity', () => {
  const local = vm.createContext({});
  vm.runInContext(functions.join('\n'), local);
  const older = {
    rule_id: 'r',
    session_id: 's',
    events: [{ timestamp: '2026-01-01T00:00:00Z', event: { id: 'old' } }],
  };
  const newer = {
    rule_id: 'r',
    session_id: 's',
    events: [{ timestamp: '2026-01-02T00:00:00Z', event: { id: 'new' } }],
  };
  const sorted = local.sortFindings([older, newer], 'recent');
  assert.deepEqual([...local.remapFindingExpansions([older, newer], sorted, new Set([0]))], [1]);
  assert.deepEqual(
    [...local.remapFindingExpansions([older, newer], [older, older, newer], new Set([0]))],
    [],
  );
});

test('findings CSV escapes spreadsheet formulas, quotes and newlines', () => {
  const fn = parse(source, { ecmaVersion: 'latest' }).body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'findingsCSV',
  );
  assert.ok(fn);
  const local = vm.createContext({});
  vm.runInContext(source.slice(fn.start, fn.end), local);
  const csv = local.findingsCSV([
    {
      severity: 'high',
      rule_id: '=unsafe',
      title: 'a,"b"',
      session_id: 'id',
      reason: 'line1\nline2',
      events: [{ timestamp: '2026-01-01T00:00:00Z' }],
    },
  ]);
  assert.match(csv, /"'=unsafe"/u);
  assert.ok(csv.includes('"a,""b"""'));
  assert.ok(csv.includes('"line1\nline2"'));
  assert.ok(csv.includes('"latest_evidence_at"'));
  assert.ok(csv.includes('"2026-01-01T00:00:00Z"'));
});

test('invalid findings response keeps previous data and disables export', async () => {
  const fn = parse(source, { ecmaVersion: 'latest' }).body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'loadFindings',
  );
  assert.ok(fn);
  const button = { disabled: false };
  const alert = { hidden: true };
  let rendered = false;
  const local = vm.createContext({
    URLSearchParams,
    window: { location: { search: '' } },
    state: {},
    $: (selector) =>
      selector === '#findings-export' ? button : selector === '#findings-alert' ? alert : null,
    getJSON: async () => ({ findings: null, scanned: 0, count: 0 }),
    setText: (_selector, value) => {
      alert.textContent = value;
    },
    t: (value, params = {}) => value.replace('{error}', params.error ?? ''),
    renderFindings: () => {
      rendered = true;
    },
  });
  vm.runInContext(
    `let findingsLastResponse = { findings: [{ rule_id: 'previous' }] };\n${source.slice(fn.start, fn.end)}`,
    local,
  );
  await local.loadFindings();
  assert.equal(rendered, false);
  assert.equal(button.disabled, true);
  assert.equal(alert.hidden, false);
  assert.match(alert.textContent, /Invalid findings response/u);
  assert.equal(local.state.findingsLoading, false);
});

test('refresh preserves the expanded finding within filtered results', () => {
  const hidden = { rule_id: 'hidden', events: [{ event: { id: '1' } }] };
  const visible = { rule_id: 'visible', events: [{ event: { id: '2' } }] };
  const state = { findings: [visible], findingsExpanded: new Set([0]) };
  const context = vm.createContext({
    state,
    $: (selector) => (selector === '#findings-search' ? { value: 'visible' } : null),
    setText: () => {},
    t: (text) => text,
  });
  vm.runInContext(functions.join('\n'), context);
  context.renderFindings({ findings: [hidden, visible] });
  assert.deepEqual([...state.findingsExpanded], [0]);
  assert.equal(state.findings[0].rule_id, 'visible');
});

test('findings export is disabled when data is stale or no findings match', () => {
  const button = { disabled: false };
  const state = { findings: [], findingsExpanded: new Set(), error: new Error('offline') };
  const local = vm.createContext({
    state,
    $: (selector) => (selector === '#findings-export' ? button : null),
    setText: () => {},
    t: (text) => text,
  });
  vm.runInContext(functions.join('\n'), local);
  local.renderFindings({ findings: [{ rule_id: 'one' }] });
  assert.equal(button.disabled, true);
  state.error = null;
  state.findingsLoading = true;
  local.renderFindings({ findings: [{ rule_id: 'one' }] });
  assert.equal(button.disabled, true);
  state.findingsLoading = false;
  local.renderFindings({ findings: [{ rule_id: 'one' }] });
  assert.equal(button.disabled, false);
  local.renderFindings({ findings: [] });
  assert.equal(button.disabled, true);
});

test('finding details distinguish failed rule loads and incomplete session timelines', () => {
  const detailNames = new Set(['ruleDetailHTML', 'sessionDetailHTML']);
  const code = parse(source, { ecmaVersion: 'latest' })
    .body.filter((node) => node.type === 'FunctionDeclaration' && detailNames.has(node.id.name))
    .map((node) => source.slice(node.start, node.end));
  assert.equal(code.length, 2);
  const state = {
    findingsRulesError: 'offline',
    findingsSessions: new Map([['s1', { records: [{}], truncated: true, total: 800 }]]),
    findingsSessionErrors: new Map([['s2', 'offline']]),
  };
  const context = vm.createContext({
    state,
    t: (key, values = {}) => key.replace(/\{(\w+)\}/gu, (_, name) => values[name] ?? ''),
    escapeHTML: (value) => String(value),
    formatSessionID: (value) => value,
    sessionTimelineRow: () => '<li>event</li>',
    sessionPageURL: (id) => `/session.html?id=${encodeURIComponent(id)}`,
    window: { BeaconI18n: { language: 'zh-CN' } },
    encodeURIComponent,
  });
  vm.runInContext(code.join('\n'), context);
  assert.match(context.ruleDetailHTML('r1'), /could not be loaded: offline/u);
  assert.match(context.sessionDetailHTML('s2'), /could not be loaded: offline/u);
  assert.match(context.sessionDetailHTML('s1'), /Showing 1 of 800 events/u);
});

test('finding timeline uses exact session endpoint and marks the 500-event limit', async () => {
  const fn = parse(source, { ecmaVersion: 'latest' }).body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'ensureSessionEvents',
  );
  assert.ok(fn);
  const state = { findingsSessions: new Map() };
  let requested = '';
  let calls = 0;
  const context = vm.createContext({
    state,
    findingsSessionsPending: new Map(),
    encodeURIComponent,
    getJSON: async (url) => {
      requested = url;
      calls += 1;
      return {
        events: Array.from({ length: 501 }, (_, index) => ({
          event: { timestamp: new Date(index * 1000).toISOString() },
        })),
      };
    },
  });
  vm.runInContext(source.slice(fn.start, fn.end), context);
  const [result, same] = await Promise.all([
    context.ensureSessionEvents('id/a'),
    context.ensureSessionEvents('id/a'),
  ]);
  assert.equal(requested, '/api/session?id=id%2Fa');
  assert.equal(calls, 1);
  assert.equal(result.records.length, 500);
  assert.equal(result.total, 501);
  assert.equal(result.truncated, true);
  assert.equal(result, same);
});
