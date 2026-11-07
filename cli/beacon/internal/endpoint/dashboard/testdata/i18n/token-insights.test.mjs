import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../static/token-insights.js', import.meta.url), 'utf8');
const window = { BeaconI18n: { t: (value) => value } };
vm.runInNewContext(
  fs.readFileSync(new URL('../../static/token-agent-view.js', import.meta.url), 'utf8'),
  { window },
);
vm.runInNewContext(source, { window, URLSearchParams });
const { metrics, csvCell, buildCSV } = window.BeaconTokenInsights;
test('export adds a timestamp and timezone without changing the captured snapshot', () => {
  const snapshot = { captured_at: '2026-10-30T00:00:00Z', report: {} };
  const exported = window.BeaconTokenInsights.exportSnapshot(snapshot);
  assert.ok(Number.isFinite(Date.parse(exported.exported_at)));
  assert.ok(exported.timezone);
  assert.equal(snapshot.exported_at, undefined);
  const csv = buildCSV(exported);
  assert.ok(csv.includes(exported.exported_at));
  assert.ok(csv.includes(exported.timezone));
});
test('export menu closes on Escape and returns focus to its summary', () => {
  const handlers = new Map();
  let focused = false;
  const menu = {
    open: true,
    addEventListener: (name, handler) => handlers.set(name, handler),
    querySelector: () => ({
      focus: () => {
        focused = true;
      },
    }),
  };
  const nav = { addEventListener() {} };
  const document = {
    querySelector: (selector) =>
      selector === '#token-view-tabs' ? nav : selector === '#shell-export' ? menu : null,
    querySelectorAll: () => [],
  };
  const page = { location: { search: '' }, BeaconI18n: { t: (value) => value } };
  vm.runInNewContext(source, { window: page, document, URLSearchParams });
  page.BeaconTokenInsights.setupViews();
  let prevented = false;
  handlers.get('keydown')({
    key: 'Escape',
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(menu.open, false);
  assert.equal(focused, true);
  assert.equal(prevented, true);
});
test('cache share and totals use disjoint inputs and do not double count reasoning', () => {
  const value = metrics({
    input_tokens: 100,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 100,
    output_tokens: 80,
    reasoning_output_tokens: 60,
    events: 2,
  });
  assert.equal(value.total, 480);
  assert.equal(value.cacheReadShare, 0.5);
  assert.equal(value.average, 240);
  assert.equal(metrics({}).cacheReadShare, null);
  assert.equal(metrics({ events: 0 }).average, null);
});
test('CSV escapes quoted fields and prevents formula interpretation', () => {
  assert.equal(csvCell('a,"b'), '"a,""b"');
  for (const value of ['=1+2', ' +cmd', '@SUM(1)', '-2+3'])
    assert.ok(csvCell(value).startsWith('"\''));
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(0), '"0"');
});
test('CSV retains exact counts, unknown cost blanks and export provenance', () => {
  const csv = buildCSV({
    report: {
      totals: { input_tokens: 1234567890, cost_usd: 0 },
      by_model: [{ key: '=unsafe', usage: { output_tokens: 3 } }],
      pricing: { catalog: { generated_at: '2026-10-05' } },
    },
    filters: { since: '2026-10-01T00:00:00Z' },
    exported_at: '2026-10-30T00:00:00Z',
    timezone: 'Asia/Shanghai',
  });
  assert.ok(csv.includes('"1234567890"'));
  assert.ok(csv.includes('"\'=unsafe"'));
  assert.ok(csv.includes('"Asia/Shanghai"'));
  assert.ok(csv.includes('2026-10-05'));
  assert.ok(csv.includes('"cost_usd"'));
  assert.ok(csv.includes('"since"'));
});

test('snapshot includes only filtered sessions and minimal metadata', () => {
  const data = window.BeaconTokenInsights.buildSnapshot(
    { by_session: [{ key: 'allowed' }] },
    new URLSearchParams('harness=codex_desktop'),
    {
      sessions: [
        { id: 'allowed', harness: 'codex_desktop', original_prompt: 'private prompt' },
        { id: 'other', original_prompt: 'unrelated' },
      ],
    },
  );
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].id, 'allowed');
  assert.equal('original_prompt' in data.sessions[0], false);
  assert.equal(data.filters.harness, 'codex_desktop');
});

test('CSV leaves unpriced estimates blank but retains a verified zero estimate', () => {
  const csv = buildCSV({
    report: {
      by_model: [
        { key: 'unknown', usage: { estimated_cost_usd: 0, unpriced_events: 1 } },
        { key: 'known', usage: { estimated_cost_usd: 0, cost_source: 'estimated' } },
      ],
    },
  });
  const lines = csv.split('\r\n');
  const columns = lines[0].split(',').map((value) => value.slice(1, -1));
  const estimateIndex = columns.indexOf('estimated_cost_usd');
  const unknown = lines.find((line) => line.includes('"unknown"')).split(',');
  const known = lines.find((line) => line.includes('"known"')).split(',');
  assert.equal(unknown[estimateIndex], '""');
  assert.equal(known[estimateIndex], '"0"');
});

test('trend drilldown respects the selected time bounds and excludes the next bucket', () => {
  const range = window.BeaconTokenInsights.trendFilterRange;
  const row = { start: '2026-10-01T01:00:00Z', lastStart: '2026-10-01T03:00:00Z' };
  const clipped = range(row, {
    bucket: '1h',
    since: '2026-10-01T01:15:00Z',
    until: '2026-10-01T03:40:00Z',
  });
  assert.equal(clipped.since, '2026-10-01T01:15:00Z');
  assert.equal(clipped.until, '2026-10-01T03:40:00Z');
  const full = range(row, { bucket: '1h' });
  assert.equal(full.since, '2026-10-01T01:00:00.000Z');
  assert.equal(full.until, '2026-10-01T03:59:59.999999999Z');
  assert.equal(range(row, { bucket: 'unknown' }), null);
  assert.equal(range(row, { bucket: '1h', since: '2026-10-02T00:00:00Z' }), null);
});
