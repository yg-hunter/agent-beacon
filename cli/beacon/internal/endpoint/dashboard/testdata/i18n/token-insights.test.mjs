import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../static/token-insights.js', import.meta.url), 'utf8');
const window = { BeaconI18n: { t: (value) => value } };
vm.runInNewContext(source, { window, URLSearchParams });
const { metrics, csvCell, exportCSV } = window.BeaconTokenInsights;
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
  const csv = exportCSV({
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
