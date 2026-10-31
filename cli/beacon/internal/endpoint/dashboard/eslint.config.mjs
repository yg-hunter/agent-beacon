import { createRequire } from 'node:module';

const require = createRequire(new URL('./testdata/i18n/package.json', import.meta.url));
const js = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

export default defineConfig(
  {
    files: [
      'static/i18n.js',
      'static/token-insights.js',
      'static/token-agent-view.js',
      'testdata/i18n/*.mjs',
      'eslint.config.mjs',
    ],
    extends: [js.configs.recommended],
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['static/i18n.js', 'static/token-insights.js', 'static/token-agent-view.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['testdata/i18n/*.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
