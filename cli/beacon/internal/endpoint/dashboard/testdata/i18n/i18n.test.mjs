import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../static/i18n.js', import.meta.url), 'utf8');

function load({ saved = null, query = '', storageThrows = false } = {}) {
  const warnings = [];
  const document = { addEventListener() {} };
  const window = {
    location: { href: `http://127.0.0.1:8765/tokens.html${query}` },
    localStorage: {
      getItem() {
        if (storageThrows) {
          throw new Error('Storage disabled');
        }
        return saved;
      },
    },
  };
  vm.runInNewContext(source, {
    window,
    document,
    URL,
    console: { warn: (...args) => warnings.push(args) },
  });
  return { ...window.BeaconI18n, warnings };
}

test('defaults to English and rejects invalid persisted language values', () => {
  assert.equal(load().t('Token Usage'), 'Token Usage');
  assert.equal(load({ saved: '<script>' }).language, 'en');
});

test('uses a persisted Chinese preference, with an explicit URL override', () => {
  assert.equal(load({ saved: 'zh-CN' }).t('Token Usage'), 'Token 用量');
  assert.equal(load({ saved: 'zh-CN', query: '?lang=en&harness=cursor' }).language, 'en');
});

test('storage failure is observable and leaves the dashboard usable', () => {
  const result = load({ storageThrows: true });
  assert.equal(result.language, 'en');
  assert.equal(result.warnings.length, 1);
});

test('preserves evidence and handles zero-valued interpolation literally', () => {
  const { t } = load({ saved: 'zh-CN' });
  for (const evidence of ['command.executed', 'Get-Date', 'gpt-6.1-sol', '{"input":0}']) {
    assert.equal(t(evidence), evidence);
  }
  assert.equal(t('{count} events', { count: 0 }), '0 条事件');
  assert.equal(t('{count} events'), '{count} 条事件');
  assert.equal(t('{count} events', { count: '<script>' }), '<script> 条事件');
});

test('all dashboard pages load translations before rendering and include the language style', () => {
  const staticDir = new URL('../../static/', import.meta.url);
  const pages = fs.readdirSync(staticDir).filter((name) => name.endsWith('.html'));
  assert.equal(pages.length, 9);
  for (const page of pages) {
    const html = fs.readFileSync(new URL(page, staticDir), 'utf8');
    assert.ok(html.indexOf('src="/i18n.js"') < html.indexOf('src="/app.js"'), page);
    assert.ok(html.includes('href="/i18n.css"'), page);
    assert.ok(html.includes('data-i18n="Token Usage"'), page);
  }
});
