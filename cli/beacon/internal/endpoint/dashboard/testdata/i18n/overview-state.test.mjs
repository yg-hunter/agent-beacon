import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = fs.readFileSync(new URL('../../static/app.js', import.meta.url), 'utf8');
const fn = parse(source, { ecmaVersion: 'latest' }).body.find(
  (node) => node.type === 'FunctionDeclaration' && node.id.name === 'renderOverviewPage',
);
assert.ok(fn);

function render(state) {
  const notice = {};
  const elements = new Map([['#overview-notice', notice]]);
  const context = vm.createContext({
    state,
    $: (selector) => elements.get(selector),
    t: (key, values) => `${key} ${JSON.stringify(values)}`,
    renderOverviewKpis: () => {},
    renderOverviewHourly: () => {},
    renderOverviewSources: () => {},
    renderOverviewAttention: () => {},
    loadRemoteSources: async () => {},
    console,
  });
  vm.runInContext(source.slice(fn.start, fn.end), context);
  context.renderOverviewPage();
  return notice;
}

test('overview distinguishes failed loading, stale data, and truncated session charts', () => {
  const failed = render({ error: new Error('offline') });
  assert.match(failed.textContent, /Activity data could not be loaded/);
  const stale = render({ error: new Error('offline'), summary: {}, sessionResult: {} });
  assert.match(stale.textContent, /last successful activity data/);
  const partial = render({
    summary: {},
    sessionResult: { truncated: true, returned: 500, total_sessions: 700 },
  });
  assert.match(partial.textContent, /500/);
  assert.match(partial.textContent, /700/);
  assert.equal(render({ summary: {}, sessionResult: {} }).hidden, true);
});

test('activity buckets exclude future events and use local calendar days', () => {
  const bucketFn = parse(source, { ecmaVersion: 'latest' }).body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'overviewSessionBuckets',
  );
  assert.ok(bucketFn);
  const context = vm.createContext({ Date });
  vm.runInContext(source.slice(bucketFn.start, bucketFn.end), context);
  const now = new Date(2026, 9, 30, 0, 30).getTime();
  const yesterday = new Date(2026, 9, 29, 23, 45);
  const today = new Date(2026, 9, 30, 0, 15);
  const future = new Date(2026, 9, 30, 0, 45);
  const result = context.overviewSessionBuckets(
    [yesterday, today, future].map((time) => ({ last_event_at: time.toISOString() })),
    '7d',
    now,
  );
  assert.equal(result.buckets.size, 7);
  assert.equal(result.covered, 2);
  assert.equal(result.buckets.get(new Date(2026, 9, 29).getTime()), 1);
  assert.equal(result.buckets.get(new Date(2026, 9, 30).getTime()), 1);
});

test('remote source removal checks response failures and escapes the source ID', async () => {
  const removeFn = parse(source, { ecmaVersion: 'latest' }).body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'deleteRemoteSource',
  );
  assert.ok(removeFn);
  const requests = [];
  let response = { ok: false, status: 403, json: async () => ({ error: 'denied' }) };
  const context = vm.createContext({
    fetch: async (path, options) => {
      requests.push({ path, method: options.method });
      return response;
    },
    encodeURIComponent,
  });
  vm.runInContext(source.slice(removeFn.start, removeFn.end), context);
  await assert.rejects(context.deleteRemoteSource('host/a'), /denied/);
  assert.equal(requests[0].path, '/api/remote-sources/host%2Fa');
  assert.equal(requests[0].method, 'DELETE');
  response = { ok: true };
  await context.deleteRemoteSource('host');
});
