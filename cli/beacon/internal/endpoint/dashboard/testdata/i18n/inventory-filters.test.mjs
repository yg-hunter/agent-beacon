import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = fs.readFileSync(new URL('../../static/app.js', import.meta.url), 'utf8');
const names = new Set(['titleCasePathBase', 'renderInventoryFilterOptions', 'filterHookAssets']);
const functions = parse(source, { ecmaVersion: 'latest' })
  .body.filter((node) => node.type === 'FunctionDeclaration' && names.has(node.id.name))
  .map((node) => source.slice(node.start, node.end));
assert.equal(functions.length, names.size);

test('local user name handles Windows and Unix home paths', () => {
  const context = vm.createContext({});
  vm.runInContext(functions.join('\n'), context);
  assert.equal(context.titleCasePathBase('C:\\Users\\alice'), 'Alice');
  assert.equal(context.titleCasePathBase('/home/alice'), 'Alice');
});

test('changing views preserves a selected runtime and unknown user', () => {
  const user = {};
  const runtime = {};
  const state = { inventoryView: 'configs', inventoryRuntime: 'cursor', inventoryUser: 'Other' };
  const context = vm.createContext({
    state,
    $: (selector) => (selector === '#inventory-user-filter' ? user : runtime),
    inventoryIdentity: () => ({ user: 'Local' }),
    inventoryRowsForView: () => [{ runtime: 'codex' }],
    inventoryRuntimeValue: (row) => row.runtime,
    uniqueSorted: (values) => values,
    runtimeLabel: (value) => value,
    escapeHTML: (value) => String(value),
    t: (value) => value,
  });
  vm.runInContext(functions.join('\n'), context);
  context.renderInventoryFilterOptions({});
  assert.equal(state.inventoryRuntime, 'cursor');
  assert.match(runtime.innerHTML, /value="cursor" selected/u);
  assert.match(user.innerHTML, /value="Other" selected/u);
});

test('hook search matches runtime, status and path without changing source records', () => {
  const context = vm.createContext({});
  vm.runInContext(functions.join('\n'), context);
  const rows = [
    { target: 'cursor', status: 'installed', path: 'C:\\Users\\A\\hooks.json' },
    { runtime: 'codex', parser_status: 'partial', path: '/home/a/hooks.toml' },
  ];
  assert.equal(context.filterHookAssets(rows, 'CURSOR').length, 1);
  assert.equal(context.filterHookAssets(rows, 'partial')[0].runtime, 'codex');
  assert.equal(context.filterHookAssets(rows, 'hooks').length, 2);
  assert.equal(context.filterHookAssets(rows, 'missing').length, 0);
  assert.equal(rows.length, 2);
});
