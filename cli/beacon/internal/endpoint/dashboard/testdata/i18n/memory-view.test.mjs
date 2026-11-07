import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = fs.readFileSync(new URL('../../static/app.js', import.meta.url), 'utf8');
const fn = parse(source, { ecmaVersion: 'latest' }).body.find(
  (node) => node.type === 'FunctionDeclaration' && node.id.name === 'loadMemory',
);
assert.ok(fn);

test('memory search passes page and query and ignores late responses', async () => {
  const pending = [];
  const state = {};
  const context = vm.createContext({
    URLSearchParams,
    isMemoryPage: true,
    state,
    renderMemoryLoading: () => {},
    renderMemory: () => {},
    getJSON: (url) => new Promise((resolve) => pending.push({ url, resolve })),
  });
  vm.runInContext(
    `const memoryPageSize = 50; let memoryPage = 1; let memoryQuery = ''; let memoryGeneration = 0;\n${source.slice(fn.start, fn.end)}`,
    context,
  );
  const first = context.loadMemory();
  vm.runInContext("memoryQuery = 'needle'; memoryPage = 2", context);
  const second = context.loadMemory();
  assert.equal(pending[1].url, '/api/memory?limit=50&page=2&q=needle');
  pending[1].resolve({ status: { candidates: 1 } });
  await second;
  pending[0].resolve({ status: { candidates: 999 } });
  await first;
  assert.equal(state.memory.status.candidates, 1);
  assert.equal(state.memoryLoadedPage, 2);
  assert.equal(state.memoryLoadedQuery, 'needle');
});
