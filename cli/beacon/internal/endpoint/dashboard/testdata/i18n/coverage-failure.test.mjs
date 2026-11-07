import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = fs.readFileSync(new URL('../../static/app.js', import.meta.url), 'utf8');
const fn = parse(source, { ecmaVersion: 'latest' }).body.find(
  (node) => node.type === 'FunctionDeclaration' && node.id.name === 'loadTokens',
);
assert.ok(fn);

test('source coverage shows loading, then clears old status and exposes retry on failure', async () => {
  const banner = { hidden: true };
  const cards = {
    cleared: false,
    replaceChildren() {
      this.cleared = true;
    },
  };
  const text = new Map();
  let unavailable = false;
  let pending = false;
  let coverage;
  let rejectCoverage;
  let coverageRequested;
  const requested = new Promise((resolve) => {
    coverageRequested = resolve;
  });
  const context = vm.createContext({
    URLSearchParams,
    Date,
    Map,
    state: {},
    window: {
      location: { search: '' },
      BeaconTokenInsights: {
        update() {},
        coveragePending() {
          pending = true;
        },
        coverageUnavailable() {
          unavailable = true;
        },
        stale() {},
      },
      BeaconAgentView: {
        update() {},
        coverage(value) {
          coverage = value;
        },
      },
    },
    document: { querySelector: () => null },
    $: (selector) =>
      selector === '#source-stale-banner'
        ? banner
        : selector === '#source-status-cards'
          ? cards
          : null,
    setText: (selector, value) => text.set(selector, value),
    setScopeChip: () => {},
    renderTokensPage: () => {},
    dataFreshnessText: () => '',
    t: (value) => value,
    buildTokenQuery: () => new URLSearchParams(),
    tokenJSON: async (path) => {
      if (path.startsWith('/api/tokens/coverage')) {
        coverageRequested();
        return new Promise((resolve, reject) => {
          rejectCoverage = reject;
        });
      }
      if (path.startsWith('/api/sessions')) return { sessions: [] };
      return path === '/api/status' ? {} : { totals: {} };
    },
  });
  vm.runInContext(
    `let tokenRequestPending = false, tokenLastReport = null, tokenSessionMetadata = new Map(), tokenMetadataCache = null, tokenMetadataCachedAt = 0;\n${source.slice(fn.start, fn.end)}`,
    context,
  );
  const loading = context.loadTokens();
  await requested;
  assert.equal(pending, true);
  assert.equal(cards.cleared, true);
  assert.equal(banner.hidden, false);
  assert.equal(text.get('#source-stale-text'), 'Loading collection status...');
  rejectCoverage(new Error('offline'));
  await loading;
  assert.equal(unavailable, true);
  assert.equal(coverage.runtimes.length, 0);
  assert.equal(cards.cleared, true);
  assert.equal(banner.hidden, false);
  assert.match(text.get('#source-stale-text'), /offline/u);
});
