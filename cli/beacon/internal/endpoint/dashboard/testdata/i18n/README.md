# Dashboard translation checks

Use Node 24.19.0 (the tested local runtime), `npm ci`, `npm test`, `npm run lint`, and
`npm run format`. Tool versions are exact in package.json and package-lock.json. This
subproject follows the global common/JavaScript standards supplied for this task;
the repository has no .code-style/docs snapshot yet. Existing dashboard app.js uses
the upstream formatting convention; avoid unrelated whole-file formatting.

Static UI text is explicitly annotated with data-i18n; generated UI uses
BeaconI18n.t. Never translate user prompts, event payloads, commands, paths, model
identifiers, rule IDs or raw JSON. Missing keys fall back to English. Language
changes reload the current URL with filters/session identity preserved and store
the choice under beacon.dashboard.language. No translation service or network
dependency is used. Lens iframe content and rule bodies remain original text.
