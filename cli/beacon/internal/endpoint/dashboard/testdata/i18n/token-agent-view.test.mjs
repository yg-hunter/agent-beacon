import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const window = { BeaconI18n: { t: (value) => value } };
vm.runInNewContext(
  fs.readFileSync(new URL('../../static/token-agent-view.js', import.meta.url), 'utf8'),
  { window },
);
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
  assert.equal(window.BeaconAgentView.inspectGrokSnapshot('{"version":1,"rows":[]}'), 0);
  assert.equal(window.BeaconAgentView.inspectGrokSnapshot('{"version":1,"rows":[{}]}'), 1);
  for (const input of ['{', '{}', '{"version":1}', '{"version":2,"rows":[]}']) {
    assert.throws(() => window.BeaconAgentView.inspectGrokSnapshot(input));
  }
});
