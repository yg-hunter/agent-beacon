import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
const source = fs.readFileSync(new URL('../../static/app.js', import.meta.url), 'utf8');
const names = new Set(['buildTokenQuery', 'usageTotal', 'resolveTokenRange']);
const functions = parse(source, { ecmaVersion: 'latest' })
  .body.filter((n) => n.type === 'FunctionDeclaration' && names.has(n.id.name))
  .map((n) => source.slice(n.start, n.end));
assert.equal(functions.length, names.size);
const context = vm.createContext({ URLSearchParams, Date });
vm.runInContext(functions.join('\n'), context);
const agentSource = fs.readFileSync(
  new URL('../../static/token-agent-view.js', import.meta.url),
  'utf8',
);
const agentBody = parse(agentSource, { ecmaVersion: 'latest' }).body[0].expression.callee.body.body;
const agentFunctions = agentBody
  .filter(
    (node) =>
      node.type === 'FunctionDeclaration' &&
      ['selectSessions', 'total', 'estimateDetails'].includes(node.id.name),
  )
  .map((node) => agentSource.slice(node.start, node.end));
assert.equal(agentFunctions.length, 3);
vm.runInContext(`const sessionMetadata = [];\n${agentFunctions.join('\n')}`, context);
context.selectTokenSessions = context.selectSessions;
test('filters carry scope and preserve custom times', () => {
  const query = context.buildTokenQuery(
    new URLSearchParams(
      'harness=cursor&model=x&session=a&since=2026-10-01T00:00:00Z&until=2026-10-02T00:00:00Z&lang=zh-CN',
    ),
  );
  assert.equal(query.get('harness'), 'cursor');
  assert.equal(query.get('since'), '2026-10-01T00:00:00Z');
  assert.equal(query.has('lang'), false);
});

test('token range prioritizes explicit URL, then saved preference, then seven days', () => {
  const saved = JSON.stringify({ range: '30d' });
  assert.equal(
    context.resolveTokenRange(new URLSearchParams('range=all'), saved).get('range'),
    'all',
  );
  assert.equal(
    context.resolveTokenRange(new URLSearchParams('since=2026-01-01'), saved).get('range'),
    'custom',
  );
  assert.equal(context.resolveTokenRange(new URLSearchParams(), saved).get('range'), '30d');
  assert.equal(context.resolveTokenRange(new URLSearchParams(), '{').get('range'), '7d');
  const custom = JSON.stringify({
    range: 'custom',
    since: '2026-10-01T00:00:00Z',
    until: '2026-10-02T00:00:00Z',
  });
  assert.equal(
    context.resolveTokenRange(new URLSearchParams(), custom).get('since'),
    '2026-10-01T00:00:00Z',
  );
  const invalid = JSON.stringify({ range: 'custom', since: 'bad', until: 'bad' });
  assert.equal(context.resolveTokenRange(new URLSearchParams(), invalid).get('range'), '7d');
  assert.equal(
    context.buildTokenQuery(new URLSearchParams('range=all&since=2026-01-01')).has('since'),
    false,
  );
});
test('rolling ranges advance with refresh and use daily buckets for thirty days', () => {
  const now = new Date('2026-10-29T02:00:00Z');
  const query = context.buildTokenQuery(new URLSearchParams('range=7d'), now);
  assert.equal(query.get('since'), '2026-10-22T02:00:00.000Z');
  assert.equal(query.get('until'), now.toISOString());
  assert.equal(context.buildTokenQuery(new URLSearchParams('range=30d'), now).get('bucket'), '24h');
  const today = context.buildTokenQuery(new URLSearchParams('range=today'), now);
  assert.equal(new Date(today.get('since')).getHours(), 0);
});
test('session search and sorting preserve the original report and zero costs', () => {
  const groups = [
    {
      key: 'ABC',
      usage: { input_tokens: 10, estimated_cost_usd: 0, cost_source: 'estimated', events: 4 },
    },
    { key: 'def', usage: { input_tokens: 20, estimated_cost_usd: 3, events: 1 } },
  ];
  assert.equal(context.selectTokenSessions(groups, '', 'tokens')[0].key, 'def');
  assert.equal(context.selectTokenSessions(groups, '', 'events')[0].key, 'ABC');
  assert.equal(context.selectTokenSessions(groups, 'ab', 'cost')[0].key, 'ABC');
  assert.equal(context.selectTokenSessions(groups, '', 'cost')[0].key, 'def');
  const withUnknown = [...groups, { key: 'unknown', usage: {} }];
  assert.equal(context.selectTokenSessions(withUnknown, '', 'cost').at(-1).key, 'unknown');
  const withPartial = [
    ...withUnknown,
    { key: 'partial', usage: { estimated_cost_usd: 100, unpriced_events: 1 } },
  ];
  assert.equal(context.selectTokenSessions(withPartial, '', 'cost')[0].key, 'def');
  assert.equal(context.selectTokenSessions(withPartial, '', 'cost').at(-1).key, 'unknown');
  assert.equal(context.selectTokenSessions(groups, 'missing', 'session').length, 0);
  assert.equal(groups[0].key, 'ABC');
});

test('session lookup includes project and runtime and sorts by activity', () => {
  const groups = [
    {
      key: 'one',
      metadata: {
        repository: 'project-a',
        harness: 'cursor',
        last_event_at: '2026-10-28T00:00:00Z',
      },
    },
    { key: 'two', metadata: { last_event_at: '2026-10-29T00:00:00Z' } },
  ];
  assert.equal(context.selectTokenSessions(groups, 'PROJECT-A', 'time')[0].key, 'one');
  assert.equal(context.selectTokenSessions(groups, 'cursor', 'time')[0].key, 'one');
  assert.equal(context.selectTokenSessions(groups, '', 'time')[0].key, 'two');
});
