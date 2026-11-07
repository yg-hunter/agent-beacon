import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = fs.readFileSync(new URL('../../static/app.js', import.meta.url), 'utf8');
const names = new Set(['safeSessionReturnURL', 'sessionPageURL']);
const functions = parse(source, { ecmaVersion: 'latest' })
  .body.filter((node) => node.type === 'FunctionDeclaration' && names.has(node.id.name))
  .map((node) => source.slice(node.start, node.end));
assert.equal(functions.length, names.size);
const context = vm.createContext({
  URL,
  URLSearchParams,
  isSessionsPage: true,
  window: {
    location: { pathname: '/', search: '?harness=cursor&range=7d&lang=zh-CN' },
    BeaconI18n: { language: 'zh-CN' },
  },
});
vm.runInContext(functions.join('\n'), context);

test('session navigation retains filters and language and rejects external return URLs', () => {
  const url = new URL(context.sessionPageURL('id/a'), 'http://localhost');
  assert.equal(url.searchParams.get('id'), 'id/a');
  assert.equal(url.searchParams.get('lang'), 'zh-CN');
  const saved = url.searchParams.get('return');
  assert.equal(saved, '/?harness=cursor&range=7d&lang=zh-CN');
  assert.equal(context.safeSessionReturnURL(saved, 'http://localhost'), saved);
  assert.equal(
    context.safeSessionReturnURL('/tokens.html?view=agents', 'http://localhost'),
    '/tokens.html?view=agents',
  );
  for (const input of [
    '//example.com/',
    '/\\example.com/',
    'https://example.com/',
    '/other.html',
  ]) {
    assert.equal(context.safeSessionReturnURL(input, 'http://localhost'), null);
  }
});

test('session audit page includes the result status that drives notices and filter chips', () => {
  const html = fs.readFileSync(new URL('../../static/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="result-meta"/u);
  assert.match(html, /id="notice"/u);
  assert.match(html, /id="active-filters"/u);
});

test('session error and detail return links preserve the Token page and use the correct label', async () => {
  const fn = parse(source, { ecmaVersion: 'latest' }).body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'loadSessionPage',
  );
  assert.ok(fn);
  const label = { dataset: {} };
  const errorLink = { dataset: {}, querySelector: () => null };
  const detailLink = { dataset: {}, querySelector: () => label };
  const params = new URLSearchParams({ return: '/tokens.html?view=agents&harness=cursor' });
  const local = vm.createContext({
    URL,
    URLSearchParams,
    window: { location: { search: `?${params}`, origin: 'http://localhost' } },
    safeSessionReturnURL: context.safeSessionReturnURL,
    $$: () => [errorLink, detailLink],
    t: (value) => value,
    state: {},
    renderSessionPage: () => {},
  });
  vm.runInContext(source.slice(fn.start, fn.end), local);
  await local.loadSessionPage();
  for (const link of [errorLink, detailLink])
    assert.equal(link.href, '/tokens.html?view=agents&harness=cursor');
  assert.equal(errorLink.textContent, 'Back to token usage');
  assert.equal(label.textContent, 'Back to token usage');
  assert.equal(label.dataset.i18n, 'Back to token usage');
});

test('session detail error view offers retry and a return path', () => {
  const html = fs.readFileSync(new URL('../../static/session.html', import.meta.url), 'utf8');
  assert.match(html, /id="session-detail-retry"/u);
  assert.match(html, /id="session-detail-error-actions"/u);
  const fn = parse(source, { ecmaVersion: 'latest' }).body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'setSessionDetailViewState',
  );
  assert.ok(fn);
  const elements = {
    '#session-detail-view': {},
    '#session-detail-status': { classList: { toggle: () => {} } },
    '#session-detail-error-actions': {},
  };
  const context = vm.createContext({
    $: (selector) => elements[selector],
    setText: () => {},
    t: (text) => text,
  });
  vm.runInContext(source.slice(fn.start, fn.end), context);
  context.setSessionDetailViewState('error', 'failed');
  assert.equal(elements['#session-detail-view'].hidden, true);
  assert.equal(elements['#session-detail-error-actions'].hidden, false);
  context.setSessionDetailViewState('loading');
  assert.equal(elements['#session-detail-error-actions'].hidden, true);
});

test('session time ranges roll forward and explicit timestamps remain fixed', () => {
  const selected = new Set(['restoreRangeFromURL', 'syncSinceFromRange']);
  const code = parse(source, { ecmaVersion: 'latest' })
    .body.filter((node) => node.type === 'FunctionDeclaration' && selected.has(node.id.name))
    .map((node) => source.slice(node.start, node.end));
  assert.equal(code.length, selected.size);
  const range = {
    value: '30d',
    options: ['30d', '7d', 'all', 'custom'].map((value) => ({ value })),
  };
  const since = { value: '2026-01-01T00:00:00.000Z' };
  const clock = class extends Date {
    static now() {
      return Date.parse('2026-11-03T00:00:00Z');
    }
  };
  const localWindow = { location: { search: '?since=2026-01-01T00%3A00%3A00.000Z' } };
  const local = vm.createContext({
    Date: clock,
    URLSearchParams,
    window: localWindow,
    $: (selector) => (selector === '#range-filter' ? range : since),
  });
  vm.runInContext(code.join('\n'), local);
  local.restoreRangeFromURL();
  local.syncSinceFromRange();
  assert.equal(range.value, 'custom');
  assert.equal(since.value, '2026-01-01T00:00:00.000Z');
  localWindow.location.search = '?range=7d';
  local.restoreRangeFromURL();
  local.syncSinceFromRange();
  assert.equal(since.value, '2026-10-27T00:00:00.000Z');
  localWindow.location.search = '?range=all&since=2026-01-01';
  local.restoreRangeFromURL();
  local.syncSinceFromRange();
  assert.equal(since.value, '');
});

test('returning to the same filtered session list restores its scroll once', () => {
  const selected = new Set(['saveSessionListScroll', 'restoreSessionListScroll']);
  const code = parse(source, { ecmaVersion: 'latest' })
    .body.filter((node) => node.type === 'FunctionDeclaration' && selected.has(node.id.name))
    .map((node) => source.slice(node.start, node.end));
  assert.equal(code.length, 2);
  const saved = new Map();
  const positions = [];
  const localWindow = {
    location: { pathname: '/', search: '?harness=cursor' },
    scrollY: 625,
    sessionStorage: {
      setItem: (key, value) => saved.set(key, value),
      getItem: (key) => saved.get(key),
      removeItem: (key) => saved.delete(key),
    },
    requestAnimationFrame: (callback) => callback(),
    scrollTo: (_x, y) => positions.push(y),
  };
  const local = vm.createContext({ window: localWindow, isSessionsPage: true, console });
  vm.runInContext(code.join('\n'), local);
  local.saveSessionListScroll();
  local.restoreSessionListScroll();
  local.restoreSessionListScroll();
  assert.deepEqual(positions, [625]);
  local.saveSessionListScroll();
  localWindow.location.search = '?harness=codex';
  local.restoreSessionListScroll();
  assert.deepEqual(positions, [625]);
});
