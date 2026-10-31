import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

// Exercise the shipping functions without starting the dashboard's polling or DOM rendering.
const source = fs.readFileSync(new URL('../../static/app.js', import.meta.url), 'utf8');
const names = new Set(['formatTokens', 'formatCompactTokens', 'formatExactTokens']);
const functions = parse(source, { ecmaVersion: 'latest' })
  .body.filter((node) => node.type === 'FunctionDeclaration' && names.has(node.id.name))
  .map((node) => source.slice(node.start, node.end));
assert.equal(functions.length, names.size);
const context = vm.createContext({});
vm.runInContext(functions.join('\n'), context);

test('uses consistent decimal units without trailing zeroes throughout token views', () => {
  for (const [value, expected] of [
    [0, '0'],
    [999, '999'],
    [1000, '1K'],
    [12345, '12.35K'],
    [59501795, '59.5M'],
    [1234567890, '1.23G'],
    [1234567890123, '1.23T'],
    [1000000000000000, '1P'],
    [1000000000000000000, '1E'],
    ['2345000000', '2.35G'],
  ]) {
    assert.equal(context.formatTokens(value), expected);
    assert.equal(context.formatCompactTokens(value), expected);
  }
});

test('rounding promotes to the next unit at K/M/G boundaries', () => {
  assert.equal(context.formatTokens(999994), '999.99K');
  assert.equal(context.formatTokens(999999), '1M');
  assert.equal(context.formatTokens(999999999), '1G');
});

test('missing values stay zero while invalid and negative counts are unavailable', () => {
  for (const value of [null, undefined, '']) {
    assert.equal(context.formatTokens(value), '0');
  }
  for (const value of [NaN, Infinity, -1, 'invalid', true, {}, []]) {
    assert.equal(context.formatTokens(value), '-');
  }
});

test('hover text retains the full value independently of compact display', () => {
  assert.equal(context.formatExactTokens(59501795), '59,501,795');
  assert.equal(context.formatExactTokens(1234567890), '1,234,567,890');
  assert.equal(context.formatExactTokens(0), '0');
  assert.equal(context.formatExactTokens('invalid'), '-');
});
