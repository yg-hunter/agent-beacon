import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = fs.readFileSync(
  new URL('../../static/token-agent-view.js', import.meta.url),
  'utf8',
);
const body = parse(source, { ecmaVersion: 'latest' }).body[0].expression.callee.body.body;
const fn = body.find(
  (node) => node.type === 'FunctionDeclaration' && node.id.name === 'previewGrok',
);
assert.ok(fn);

test('replacing a file clears its old preview and ignores errors from an earlier selection', async () => {
  let resolveText;
  const oldFile = {
    size: 10,
    text: () =>
      new Promise((resolve) => {
        resolveText = resolve;
      }),
  };
  const input = { files: [oldFile] };
  const nodes = {
    '#grok-usage-file': input,
    '#grok-usage-import': {},
    '#grok-usage-preview': {},
    '#grok-file-row': { hidden: false },
    '#grok-counts': { hidden: false },
    '#grok-count-cards': { replaceChildren: () => {} },
    '#grok-import-result': {},
  };
  const context = vm.createContext({
    document: { querySelector: (selector) => nodes[selector] },
    t: (text) => text,
    inspectGrokSnapshot: () => {
      throw new Error('invalid');
    },
  });
  vm.runInContext(source.slice(fn.start, fn.end), context);
  const request = context.previewGrok();
  assert.equal(nodes['#grok-file-row'].hidden, true);
  assert.equal(nodes['#grok-counts'].hidden, true);
  assert.equal(nodes['#grok-usage-import'].disabled, true);
  input.files = [{ size: 1 }];
  resolveText('bad');
  await request;
});

test('snapshot import prevents concurrent submission and unlocks after the response', async () => {
  const importFn = body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'importGrok',
  );
  assert.ok(importFn);
  let resolveFetch;
  let calls = 0;
  const file = { size: 2, text: async () => '{}' };
  const input = { files: [file] };
  const button = {};
  const close = {};
  const cancel = {};
  const nodes = {
    '#grok-usage-file': input,
    '#grok-usage-import': button,
    '#grok-dialog-close': close,
    '#grok-cancel': cancel,
  };
  const context = vm.createContext({
    document: { querySelector: (selector) => nodes[selector] },
    inspectGrokSnapshot: () => ({ problems: [] }),
    fetch: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
    AbortSignal,
    t: (text) => text,
    setImportFeedback: () => {},
    window: {},
  });
  vm.runInContext(
    `let grokImportPending = false;\n${source.slice(importFn.start, importFn.end)}`,
    context,
  );
  const first = context.importGrok();
  await context.importGrok();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(input.disabled, true);
  assert.equal(close.disabled, true);
  resolveFetch({ ok: true });
  await first;
  assert.equal(input.disabled, false);
  assert.equal(close.disabled, false);
});

test('dropping files only selects one and never starts an import', async () => {
  const dropFn = body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'handleGrokDrop',
  );
  assert.ok(dropFn);
  const input = {};
  let resets = 0;
  let previews = 0;
  const context = vm.createContext({
    document: { querySelector: () => input },
    resetGrokFile: () => {
      resets += 1;
    },
    previewGrok: async () => {
      previews += 1;
    },
    t: (text) => text,
  });
  vm.runInContext(
    `let grokImportPending = false;\n${source.slice(dropFn.start, dropFn.end)}`,
    context,
  );
  const files = [{ name: 'snapshot.json' }];
  await context.handleGrokDrop(files);
  assert.equal(input.files, files);
  assert.equal(previews, 1);
  await assert.rejects(context.handleGrokDrop([{}, {}]), /exactly one/u);
  assert.equal(resets, 1);
  vm.runInContext('grokImportPending = true', context);
  await context.handleGrokDrop([{}]);
  assert.equal(previews, 1);
});
