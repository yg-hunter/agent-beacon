import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const window = { BeaconI18n: { t: (value) => value } };
vm.runInNewContext(
  fs.readFileSync(new URL('../../static/token-agent-view.js', import.meta.url), 'utf8'),
  { window, TextEncoder },
);
test('recent Agent sessions stay within the selected report and Agent, ordered by activity', () => {
  const groups = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'unknown' }];
  const metadata = [
    { id: 'a', harness: 'codex', last_event_at: '2026-01-01T00:00:00Z' },
    { id: 'b', harness: 'cursor', last_event_at: '2026-01-03T00:00:00Z' },
    { id: 'c', harness: 'codex', last_event_at: '2026-01-02T00:00:00Z' },
    { id: 'outside', harness: 'codex', last_event_at: '2026-01-04T00:00:00Z' },
  ];
  const rows = window.BeaconAgentView.recentAgentSessions('codex', groups, metadata);
  assert.deepEqual(
    Array.from(rows, (row) => row.key),
    ['c', 'a'],
  );
});
test('session activity times remain unknown when missing or invalid', () => {
  assert.equal(window.BeaconAgentView.sessionTime(undefined), 'Unknown');
  assert.equal(window.BeaconAgentView.sessionTime('invalid'), 'Unknown');
  assert.notEqual(window.BeaconAgentView.sessionTime('2026-01-01T00:00:00Z'), 'Unknown');
});
test('copy feedback handles success, denial and switching sessions during an asynchronous copy', async () => {
  const code = fs
    .readFileSync(new URL('../../static/token-agent-view.js', import.meta.url), 'utf8')
    .replace(
      'window.BeaconAgentView = Object.freeze({',
      'window.BeaconAgentView = Object.freeze({ openTokenSession,',
    );
  let click;
  let writeText = async () => {};
  const status = { textContent: '' };
  const nodes = new Map([
    [
      '#token-session-copy',
      {
        addEventListener: (_name, callback) => {
          click = callback;
        },
      },
    ],
    ['#token-session-copy-status', status],
    ['#token-session-dialog', { showModal() {} }],
    ['#token-session-content', {}],
    ['#token-session-events', {}],
    ['#token-session-no-events', {}],
  ]);
  const localWindow = {
    BeaconI18n: { t: (value) => value },
    escapeHTML: String,
    formatTokens: String,
  };
  vm.runInNewContext(code, {
    window: localWindow,
    document: { querySelector: (key) => nodes.get(key) ?? null },
    navigator: { clipboard: { writeText: (id) => writeText(id) } },
    TextEncoder,
  });
  localWindow.BeaconAgentView.setup();
  localWindow.BeaconAgentView.openTokenSession({ key: 'one' });
  let copied;
  writeText = async (id) => {
    copied = id;
  };
  await click();
  assert.equal(copied, 'one');
  assert.equal(status.textContent, 'Copied');
  writeText = async () => {
    throw new Error('denied');
  };
  await click();
  assert.equal(status.textContent, 'Could not copy session ID');
  let finish;
  writeText = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = click();
  localWindow.BeaconAgentView.openTokenSession({ key: 'two' });
  finish();
  await pending;
  assert.equal(status.textContent, '');
});
test('audit availability distinguishes missing evidence from incomplete metadata', () => {
  const availability = window.BeaconAgentView.auditAvailability;
  assert.equal(availability('a', { available: false, auditIds: [] }), 'unknown');
  assert.equal(availability('a', { available: true, truncated: true, auditIds: [] }), 'unknown');
  assert.equal(availability('a', { available: true, truncated: false, auditIds: [] }), 'absent');
  assert.equal(
    availability('a', { available: true, truncated: true, auditIds: ['a'] }),
    'available',
  );
});
test('session detail displays partial pricing and does not claim missing audit data when metadata is truncated', () => {
  const source = fs.readFileSync(
    new URL('../../static/token-agent-view.js', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('  function openTokenSession(row) {');
  const end = source.indexOf('  function displayKey(', start);
  assert.ok(start >= 0 && end > start);
  const dialog = {
    shown: false,
    showModal() {
      this.shown = true;
    },
  };
  const content = {};
  const link = {};
  const notice = {};
  const nodes = new Map([
    ['#token-session-dialog', dialog],
    ['#token-session-content', content],
    ['#token-session-events', link],
    ['#token-session-no-events', notice],
  ]);
  const context = {
    document: { querySelector: (key) => nodes.get(key) },
    window: {
      escapeHTML: String,
      formatTokens: String,
      location: { pathname: '/tokens.html', search: '?view=agents&harness=codex' },
      BeaconI18n: { language: 'zh-CN' },
    },
    URLSearchParams,
    t: (value) => value,
    friendly: (value) => value,
    number_or_zero: (value) => value ?? 0,
    total: () => 10,
    estimateDetails: window.BeaconAgentView.estimateDetails,
    sessionTime: window.BeaconAgentView.sessionTime,
    auditAvailability: window.BeaconAgentView.auditAvailability,
    sessionMetadataState: { available: true, truncated: true, auditIds: [] },
  };
  vm.runInNewContext(
    source.slice(start, end) +
      '\nopenTokenSession({ key: "a/b", usage: { estimated_cost_usd: 1, unpriced_events: 1 } });',
    context,
  );
  assert.equal(dialog.shown, true);
  assert.equal(link.hidden, true);
  assert.match(notice.textContent, /could not be confirmed/u);
  assert.match(content.innerHTML, /~\$1\.0000 · partial/u);
  context.sessionMetadataState.auditIds = ['a/b'];
  vm.runInNewContext('openTokenSession({ key: "a/b", usage: {} });', context);
  assert.equal(link.hidden, false);
  const target = new URL(link.href, 'http://localhost');
  assert.equal(target.searchParams.get('id'), 'a/b');
  assert.equal(target.searchParams.get('lang'), 'zh-CN');
  assert.equal(target.searchParams.get('return'), '/tokens.html?view=agents&harness=codex');
  assert.equal(notice.hidden, true);
});
test('discovers Agents without usage and preserves distinct Grok identities', () => {
  const names = window.BeaconAgentView.agentNames(
    { by_harness: [{ key: 'codex_desktop' }, { key: 'grok' }] },
    { runtimes: [{ harness: 'cursor' }] },
    { harnesses: [{ name: 'new_runtime', detected: true }] },
  );
  for (const name of [
    'zcode',
    'grok_bot',
    'grok',
    'codex_desktop',
    'cursor',
    'new_runtime',
    'autoclaw',
    'doubao_work',
  ]) {
    assert.ok(names.includes(name));
  }
  assert.equal(names.filter((name) => name === 'grok_bot').length, 1);
  assert.ok(window.BeaconAgentView.agentNames({}, {}).includes('zcode'));
});
test('Agent totals are disjoint and exclude reasoning subsets', () => {
  assert.equal(
    window.BeaconAgentView.total({
      input_tokens: 10,
      cache_read_input_tokens: 20,
      output_tokens: 5,
      reasoning_output_tokens: 3,
    }),
    35,
  );
  assert.equal(window.BeaconAgentView.total({}), 0);
});
test('Agent search and sorting keep unknown counts after genuine zero', () => {
  const report = {
    by_harness: [
      { key: 'zero', usage: { input_tokens: 0 } },
      { key: 'high', usage: { input_tokens: 12 } },
    ],
  };
  const names = ['missing', 'zero', 'high'];
  const name = (value) => value;
  assert.equal(
    window.BeaconAgentView.orderAgents(names, report, 'total', '', name).join(','),
    'high,zero,missing',
  );
  assert.equal(
    window.BeaconAgentView.orderAgents(names, report, 'input_tokens', 'ze', name).join(','),
    'zero',
  );
  assert.equal(
    window.BeaconAgentView.orderAgents(names, report, 'name', '', name).join(','),
    'high,missing,zero',
  );
});
test('import preview rejects invalid envelopes and distinguishes explicit empty snapshots', () => {
  const empty = window.BeaconAgentView.inspectGrokSnapshot('{"version":1,"rows":[]}');
  assert.equal(empty.count, 0);
  assert.equal(empty.affectedRows, 0);
  const invalid = window.BeaconAgentView.inspectGrokSnapshot('{"version":1,"rows":[{}]}');
  assert.equal(invalid.count, 1);
  assert.equal(invalid.affectedRows, 1);
  assert.equal(invalid.problems.find((problem) => problem.kind === 'counts').rows, 1);
  const multiple = window.BeaconAgentView.inspectGrokSnapshot(
    JSON.stringify({ version: 1, rows: Array.from({ length: 5 }, () => ({})) }),
  );
  assert.equal(multiple.affectedRows, 5);
  assert.equal(multiple.problems.find((problem) => problem.kind === 'counts').rows, 5);
  for (const input of ['{', '{}', '{"version":1}', '{"version":2,"rows":[]}']) {
    assert.throws(() => window.BeaconAgentView.inspectGrokSnapshot(input));
  }
});

test('Grok preview validates the server id and status contract', () => {
  const inspect = window.BeaconAgentView.inspectGrokSnapshot;
  const row = {
    id: 'request-1',
    session: 'session-1',
    completed_at_ms: 1793318400000,
    status: 'error',
    fresh_input_tokens: 1,
    output_tokens: 2,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
  const valid = inspect(JSON.stringify({ version: 1, rows: [row] }));
  assert.equal(valid.affectedRows, 0);
  const duplicate = inspect(JSON.stringify({ version: 1, rows: [row, row] }));
  assert.equal(duplicate.problems.find((problem) => problem.kind === 'duplicate').rows, 1);
  const invalid = inspect(
    JSON.stringify({
      version: 1,
      rows: [{ ...row, id: '', status: 'failed', reasoning_tokens: 3 }],
    }),
  );
  assert.equal(invalid.affectedRows, 1);
  for (const kind of ['identity', 'status', 'counts']) {
    assert.equal(invalid.problems.find((problem) => problem.kind === kind).rows, 1);
  }
});

test('the displayed Grok format example passes preview validation', () => {
  const insights = fs.readFileSync(
    new URL('../../static/token-insights.js', import.meta.url),
    'utf8',
  );
  const match = insights.match(/const example = (\{[\s\S]*?\});\s*const line/u);
  assert.ok(match);
  const example = vm.runInNewContext(`(${match[1]})`);
  const result = window.BeaconAgentView.inspectGrokSnapshot(JSON.stringify(example));
  assert.equal(result.affectedRows, 0);
});

test('Grok preview sums remain exact above the safe integer limit', () => {
  const rows = Array.from({ length: 10001 }, (_, index) => ({
    id: `r${index}`,
    session: 's',
    completed_at_ms: 1793318400000,
    status: 'completed',
    fresh_input_tokens: 999999999999,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  }));
  const result = window.BeaconAgentView.inspectGrokSnapshot(JSON.stringify({ version: 1, rows }));
  assert.equal(result.affectedRows, 0);
  assert.equal(result.sums.fresh.toString(), '10000999999989999');
});

test('session counts distinguish unknown, incomplete and complete metadata', () => {
  const count = window.BeaconAgentView.sessionCount;
  const groups = [{ key: 'one' }, { key: 'two' }];
  const metadata = [{ id: 'one', harness: 'cursor' }];
  assert.equal(count('cursor', groups, metadata, { available: false }), null);
  assert.equal(count('cursor', groups, metadata, { available: true }).partial, true);
  assert.equal(count('cursor', groups, metadata, { available: true }).count, 1);
  assert.equal(count('cursor', groups.slice(0, 1), metadata, { available: true }).partial, false);
  assert.equal(count('cursor', [], metadata, { available: true, truncated: true }).partial, true);
});

test('Agent source and Grok snapshot status reflect available data', () => {
  const { sourceLabel, rowState } = window.BeaconAgentView;
  assert.equal(sourceLabel('cursor', 'reported', null, null), 'Local usage events');
  assert.equal(
    rowState('grok_bot', null, null, null, null).label,
    'Not connected; import available',
  );
  assert.equal(
    rowState('grok_bot', { events: 1 }, null, null, null).label,
    'Snapshot usage received',
  );
});

test('dimension totals use the selected native records or deduplicated usage groups', () => {
  const dimensionTotal = window.BeaconAgentView.dimensionTotal;
  assert.equal(dimensionTotal([{ tokens: 100 }, { tokens: 25 }], true), 125);
  assert.equal(
    dimensionTotal(
      [
        { usage: { input_tokens: 10, output_tokens: 2 } },
        { usage: { cache_read_input_tokens: 8 } },
      ],
      false,
    ),
    20,
  );
});

test('dimension pagination reaches all records and clamps after filtering', () => {
  const bounds = window.BeaconAgentView.dimensionPageBounds;
  assert.equal(bounds(123, 0).end, 50);
  assert.equal(bounds(123, 2).start, 100);
  assert.equal(bounds(123, 2).end, 123);
  assert.equal(bounds(10, 2).page, 0);
  assert.equal(bounds(0, 0).pages, 1);
});

test('small nonzero shares do not appear as zero', () => {
  const share = window.BeaconAgentView.dimensionShare;
  assert.equal(share(1, 10000), '<0.1%');
  assert.equal(share(0, 100), '0.0%');
  assert.equal(share(1, 0), '—');
});

test('zero estimate requires pricing evidence and partial estimates stay marked', () => {
  const estimate = window.BeaconAgentView.estimateDetails;
  assert.equal(estimate({ estimated_cost_usd: 0, unpriced_events: 3 }), null);
  assert.equal(estimate({ estimated_cost_usd: 0 }), null);
  assert.equal(estimate({ estimated_cost_usd: 0, cost_source: 'estimated' }).value, 0);
  assert.equal(estimate({ estimated_cost_usd: 0.001, unpriced_events: 2 }).partial, true);
  assert.equal(estimate({ estimated_cost_usd: -1 }), null);
});
