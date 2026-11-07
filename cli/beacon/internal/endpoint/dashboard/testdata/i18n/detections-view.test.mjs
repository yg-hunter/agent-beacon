import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = fs.readFileSync(new URL('../../static/app.js', import.meta.url), 'utf8');
const names = new Set(['detectionStatusPill', 'detectionPostureLabel']);
const functions = parse(source, { ecmaVersion: 'latest' })
  .body.filter((node) => node.type === 'FunctionDeclaration' && names.has(node.id.name))
  .map((node) => source.slice(node.start, node.end));
assert.equal(functions.length, names.size);
const context = vm.createContext({ t: (value) => value, escapeHTML: (value) => value });
vm.runInContext(functions.join('\n'), context);

test('rule maturity and enforcement posture remain separate concepts', () => {
  assert.match(context.detectionStatusPill('stable'), /Stable/u);
  assert.match(context.detectionStatusPill('experimental'), /Experimental/u);
  assert.equal(context.detectionPostureLabel('detect'), 'Detection only');
  assert.equal(context.detectionPostureLabel('enforce-capable'), 'Enforcement-capable rule');
  assert.equal(context.detectionPostureLabel(''), 'Unknown');
});
