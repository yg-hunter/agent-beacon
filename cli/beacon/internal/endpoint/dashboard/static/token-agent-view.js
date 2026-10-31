/* Agent comparison and detailed-analysis tabs; Grok Bot snapshot import.
   Absent telemetry stays absent rather than becoming zero. */
(() => {
  'use strict';
  const t = window.BeaconI18n.t;
  let currentReport = null;
  let currentStatus = {};
  let sessionMetadata = [];
  let currentCoverage = { runtimes: [] };
  let dimension = 'by_model';
  const labels = {
    zcode: 'ZCode',
    deepseek_harness: 'DeepSeek Harness',
    workbuddy: 'WorkBuddy AI',
    grok_bot: 'Grok Bot',
    grok: 'Grok Build',
    codex_desktop: 'Codex Desktop',
    codex_cli: 'Codex CLI',
    cursor: 'Cursor',
    autoclaw: 'AutoClaw',
    doubao_work: '豆包工作 / Doubao Work',
  };
  const friendly = (key) => labels[key] ?? window.harnessLabel(key);
  function total(usage = {}) {
    return [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ].reduce((sum, key) => sum + (Number.isFinite(usage[key]) ? usage[key] : 0), 0);
  }
  function agentNames(report, coverage, status = {}) {
    return [
      ...new Set([
        'zcode',
        'deepseek_harness',
        'workbuddy',
        'grok_bot',
        'autoclaw',
        'doubao_work',
        ...(report.by_harness?.map((row) => row.key) ?? []),
        ...(coverage.runtimes?.map((row) => row.harness) ?? []),
        ...(status.harnesses
          ?.filter((row) => row.detected || row.telemetry_status === 'enabled')
          .map((row) => row.name) ?? []),
      ]),
    ].sort();
  }
  function orderAgents(names, report, sort, search, displayName) {
    const usages = new Map((report.by_harness ?? []).map((row) => [row.key, row.usage]));
    const needle = search.trim().toLocaleLowerCase();
    return names
      .filter((name) => `${name} ${displayName(name)}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => {
        if (sort === 'name') {
          return displayName(a).localeCompare(displayName(b));
        }
        const value = (name) => {
          const usage = usages.get(name);
          if (!usage) {
            return null;
          }
          const count = sort === 'total' ? total(usage) : usage[sort];
          return Number.isFinite(count) ? count : null;
        };
        const left = value(a);
        const right = value(b);
        if (left === null || right === null) {
          return left === right
            ? displayName(a).localeCompare(displayName(b))
            : left === null
              ? 1
              : -1;
        }
        return right - left || displayName(a).localeCompare(displayName(b));
      });
  }

  /* ---- Grok snapshot inspection (client-side mirror of the server rules) ---- */

  const REQUIRED_COUNTS = [
    ['fresh_input_tokens', 'fresh'],
    ['output_tokens', 'output'],
    ['cache_read_tokens', 'read'],
    ['cache_write_tokens', 'write'],
  ];
  const ALLOWED_STATUS = new Set(['completed', 'failed', 'cancelled']);

  function inspectGrokSnapshot(text) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(t('Invalid JSON file'));
    }
    if (
      !payload ||
      payload.version !== 1 ||
      !Array.isArray(payload.rows) ||
      payload.rows.length > 20000
    ) {
      throw new Error(t('Expected version 1 and a rows array of at most 20000 records'));
    }
    const seen = new Map();
    const problems = [
      { kind: 'duplicate', rows: 0, detail: '' },
      { kind: 'counts', rows: 0, detail: '' },
      { kind: 'status', rows: 0, detail: '' },
    ];
    const sums = { fresh: 0, output: 0, read: 0, write: 0 };
    payload.rows.forEach((row, index) => {
      const id = row?.request_id;
      if (id !== undefined && id !== null) {
        if (seen.has(id) && problems[0].rows < 3) {
          problems[0].rows += 1;
          if (!problems[0].detail) {
            problems[0].detail = t('Example: rows {a} and {b} share id "{id}"', {
              a: seen.get(id) + 1,
              b: index + 1,
              id: String(id),
            });
          }
        } else {
          seen.set(id, index);
        }
      }
      let countsOk = true;
      for (const [field] of REQUIRED_COUNTS) {
        const value = row?.[field];
        if (!Number.isInteger(value) || value < 0) {
          countsOk = false;
          if (problems[1].rows < 3) {
            problems[1].rows += 1;
            problems[1].detail ||= t('Example: row {row} has invalid {field}', {
              row: index + 1,
              field,
            });
          }
        }
      }
      if (countsOk) {
        sums.fresh += row.fresh_input_tokens;
        sums.output += row.output_tokens;
        sums.read += row.cache_read_tokens;
        sums.write += row.cache_write_tokens;
      }
      if (!ALLOWED_STATUS.has(row?.status) && problems[2].rows < 3) {
        problems[2].rows += 1;
        problems[2].detail ||= t('Example: row {row} has status "{status}"', {
          row: index + 1,
          status: String(row?.status),
        });
      }
    });
    return { count: payload.rows.length, sums, problems };
  }

  /* ---- Setup ---- */

  function setup() {
    const search = document.querySelector('#agent-search');
    const sort = document.querySelector('#agent-sort');
    const coveredOnly = document.querySelector('#agent-covered-only');
    search?.addEventListener('input', renderAgents);
    sort?.addEventListener('change', renderAgents);
    coveredOnly?.addEventListener('change', renderAgents);
    for (const format of ['csv', 'json']) {
      document
        .querySelector(`#agent-export-${format}`)
        ?.addEventListener('click', () =>
          format === 'csv'
            ? window.BeaconTokenInsights.exportCSV()
            : window.BeaconTokenInsights.exportJSON(),
        );
    }
    const tabs = document.querySelector('#dimension-tabs');
    tabs?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-dimension]');
      if (!button) {
        return;
      }
      dimension = button.dataset.dimension;
      for (const option of tabs.querySelectorAll('button')) {
        option.classList.toggle('active', option === button);
      }
      renderDimension();
    });
    document
      .querySelector('#dimension-exact')
      ?.addEventListener('change', renderDimension);
    const dimensionSelect = document.querySelector('#agent-dimension');
    if (dimensionSelect) {
      const dimensions = {
        by_agent_time: 'Agent × time',
        by_agent_model: 'Agent × model',
        by_agent_project: 'Agent × project',
        unit: 'Record granularity',
        task: 'Task type',
        worker: 'Worker Agent',
        outcome: 'Request outcome',
        retry: 'Retry metadata',
      };
      for (const [key, label] of Object.entries(dimensions)) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = t(label);
        dimensionSelect.append(option);
      }
      dimensionSelect.value = 'by_agent_model';
      dimensionSelect.addEventListener('change', renderDimension);
    }
    document
      .querySelector('#grok-usage-file')
      ?.addEventListener('change', () =>
        previewGrok().catch((error) => {
          setImportFeedback(error.message, false);
        }),
      );
    document
      .querySelector('#grok-usage-import')
      ?.addEventListener('click', () =>
        importGrok().catch((error) => {
          setImportFeedback(error.message, false);
        }),
      );
    document.querySelector('#grok-cancel')?.addEventListener('click', resetGrokFile);
    document.querySelector('#grok-rechoose')?.addEventListener('click', resetGrokFile);
    renderLegend();
  }

  function renderLegend() {
    const el = document.querySelector('#granularity-legend');
    if (!el) {
      return;
    }
    const items = [
      ['request', t('Request level · supports latency and retry statistics')],
      ['info', t('Model response · one turn can contain several responses')],
      ['task', t('Task run · totals only, not stackable')],
      ['behavior', t('Behavior record · no usage evidence')],
    ];
    el.innerHTML = `<strong>${window.escapeHTML(t('Record granularity'))}</strong>${items
      .map(([kind, label]) => `<span class="granularity-chip ${kind}">${window.escapeHTML(label)}</span>`)
      .join('')}`;
  }

  /* ---- Grok import ---- */

  function setImportFeedback(message, ok) {
    const line = document.querySelector('#import-state-line');
    const result = document.querySelector('#grok-import-result');
    if (result) {
      result.textContent = message;
    }
    if (line) {
      line.textContent = message;
      line.className = ok ? 'import-state-ok' : 'import-state-fail';
    }
  }

  function resetGrokFile() {
    const input = document.querySelector('#grok-usage-file');
    if (input) {
      input.value = '';
    }
    document.querySelector('#grok-file-row')?.setAttribute('hidden', '');
    document.querySelector('#grok-counts')?.setAttribute('hidden', '');
    document.querySelector('#grok-usage-import')?.setAttribute('disabled', '');
    const preview = document.querySelector('#grok-usage-preview');
    if (preview) {
      preview.textContent = '';
    }
    const result = document.querySelector('#grok-import-result');
    if (result) {
      result.textContent = '';
    }
  }

  function renderGrokErrors(problems) {
    const titles = {
      duplicate: t('Duplicate record IDs'),
      counts: t('Invalid token counts (negative or missing)'),
      status: t('Invalid status field'),
    };
    const active = problems
      .map((problem, index) => ({ ...problem, index: index + 1 }))
      .filter((problem) => problem.rows > 0);
    if (!active.length) {
      return '';
    }
    const affected = active.reduce((sum, problem) => sum + problem.rows, 0);
    return `<div class="import-error-banner"><strong>${window.escapeHTML(
      t('Validation failed; snapshot not imported'),
    )}</strong>${window.escapeHTML(
      t('{kinds} error kinds · {rows} rows affected. The previous snapshot is kept.', {
        kinds: active.length,
        rows: affected,
      }),
    )}</div>${active
      .map(
        (problem) => `<div class="import-error-item"><div class="error-title"><span class="error-index">${problem.index}</span>${window.escapeHTML(titles[problem.kind])}<span class="error-badge">${window.escapeHTML(t('{count} rows', { count: problem.rows }))}</span></div><p>${window.escapeHTML(problem.detail ?? '')}</p></div>`,
      )
      .join('')}`;
  }

  async function previewGrok() {
    const input = document.querySelector('#grok-usage-file');
    const button = document.querySelector('#grok-usage-import');
    const preview = document.querySelector('#grok-usage-preview');
    button.disabled = true;
    preview.textContent = '';
    const result = document.querySelector('#grok-import-result');
    if (result) {
      result.textContent = '';
    }
    const file = input.files[0];
    if (!file) {
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      throw new Error(t('Choose a JSON file up to 8 MiB'));
    }
    const inspected = inspectGrokSnapshot(await file.text());
    if (input.files[0] !== file) {
      return;
    }
    const row = document.querySelector('#grok-file-row');
    row.hidden = false;
    document.querySelector('#grok-file-name').textContent = file.name;
    document.querySelector('#grok-file-meta').textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB · ${inspected.count.toLocaleString()} ${t('rows')} · version 1`;
    const state = document.querySelector('#grok-file-state');
    const failed = inspected.problems.some((problem) => problem.rows > 0);
    state.className = failed ? 'import-fail' : 'import-ok';
    state.textContent = failed ? t('Validation failed') : t('Structure check passed');
    const counts = document.querySelector('#grok-counts');
    const cards = document.querySelector('#grok-count-cards');
    counts.hidden = failed;
    if (!failed) {
      const labels = [
        ['fresh', t('Fresh input')],
        ['output', t('Output')],
        ['read', t('Cache read')],
        ['write', t('Cache write')],
      ];
      cards.innerHTML = labels
        .map(
          ([key, label]) =>
            `<div class="import-count-card"><span>${window.escapeHTML(label)}</span><strong title="${inspected.sums[key].toLocaleString()}">${window.escapeHTML(inspected.sums[key].toLocaleString())}</strong></div>`,
        )
        .join('');
    }
    preview.innerHTML = renderGrokErrors(inspected.problems);
    button.disabled = failed;
  }

  async function importGrok() {
    const file = document.querySelector('#grok-usage-file')?.files[0];
    if (!file || file.size > 8 * 1024 * 1024) {
      throw new Error(t('Choose a JSON file up to 8 MiB'));
    }
    const button = document.querySelector('#grok-usage-import');
    button.disabled = true;
    let response;
    try {
      const body = await file.text();
      inspectGrokSnapshot(body);
      if (document.querySelector('#grok-usage-file').files[0] !== file) {
        return;
      }
      response = await fetch('/api/native-usage/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(30000),
      });
    } finally {
      if (document.querySelector('#grok-usage-file').files[0] === file) {
        button.disabled = false;
      }
    }
    if (!response.ok) {
      const error = (await response.json()).error;
      const missingField =
        /^explicit (fresh_input_tokens|output_tokens|cache_read_tokens|cache_write_tokens) required$/.exec(
          error,
        );
      const message = missingField
        ? `${t('Required field missing')}: ${missingField[1]}`
        : t(error);
      throw new Error(t('Import rejected') + ': ' + message);
    }
    setImportFeedback(t('Import complete; the snapshot replaced the previous one. Refresh to view.'), true);
    // Cached token reports no longer match the persisted snapshot.
    window.clearDataCache?.('/api/tokens');
  }

  /* ---- Agent comparison tab ---- */

  function sourceLabel(name, coverageStatus, activity, context) {
    if (context) {
      return t('Local conversation store (read-only)');
    }
    if (name === 'grok_bot') {
      return t('JSON snapshot import');
    }
    if (activity) {
      return t('Local trajectory files');
    }
    const expectations = {
      reported: t('Local usage events'),
      generic_otlp: t('Generic telemetry'),
      none: t('Hook behavior'),
    };
    return expectations[coverageStatus] ?? '—';
  }

  function granularityLabel(name, usage, context) {
    if (context) {
      return ['info', context.context_tokens > 0 ? t('Context occupancy') : t('Model requests')];
    }
    if (name === 'grok_bot') {
      return ['snapshot', t('Snapshot')];
    }
    if (name === 'autoclaw') {
      return ['task', t('Task run')];
    }
    if (name === 'doubao_work') {
      return ['behavior', t('Behavior record')];
    }
    if (usage) {
      return ['info', t('Model response')];
    }
    return null;
  }

  function rowState(name, usage, activity, coverageStatus, context) {
    if (context) {
      return {
        kind: 'info',
        label:
          context.context_tokens > 0
            ? t('Context known; billing tokens unknown')
            : t('Sessions and models known; billing tokens unknown'),
      };
    }
    if (name === 'grok_bot') {
      return { kind: 'warn', label: t('Not connected; import available') };
    }
    if (usage) {
      if (name === 'autoclaw') {
        return { kind: 'warn', label: t('Run totals, not stackable') };
      }
      if (number_or_zero(usage.unpriced_events) > 0) {
        return { kind: 'warn', label: t('Partially priced') };
      }
      return { kind: 'ok', label: t('Normal') };
    }
    if (activity) {
      return { kind: 'activity', label: t('Activity only, no usage') };
    }
    const states = {
      covered: ['ok', t('Usage received')],
      silent: ['activity', t('Activity without expected usage')],
      inactive: ['muted', t('No activity in range')],
      not_instrumented: ['muted', t('No token capture path')],
    };
    const mapped = states[coverageStatus] ?? ['muted', t('Unknown')];
    return { kind: mapped[0], label: mapped[1] };
  }

  function number_or_zero(value) {
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  function renderAgents() {
    const el = document.querySelector('#agent-consumption-cards');
    if (!el || !currentReport) {
      return;
    }
    const selected = document.querySelector('select[name="harness"]')?.value ?? '';
    const search = document.querySelector('#agent-search')?.value ?? '';
    const sort = document.querySelector('#agent-sort')?.value ?? 'total';
    const coveredOnly = document.querySelector('#agent-covered-only')?.checked ?? false;
    const names = agentNames(currentReport, currentCoverage, currentStatus);
    const rows = orderAgents(names, currentReport, sort, search, friendly)
      .filter((name) => !selected || name === selected)
      .map((name) => ({
        name,
        usage: currentReport.by_harness?.find((row) => row.key === name)?.usage,
        activity: currentReport.native?.activity?.find((row) => row.harness === name),
        coverageStatus: currentCoverage.runtimes?.find((row) => row.harness === name)?.status,
        context: currentReport.native?.context_evidence?.find((row) => row.harness === name),
      }))
      .filter((row) => !coveredOnly || row.usage);
    const count = document.querySelector('#agent-count');
    if (count) {
      count.textContent = `${rows.length} / ${names.length} ${t('sources')}`;
    }
    if (!rows.length) {
      el.innerHTML = `<p class="muted section-pad">${window.escapeHTML(t('No matching Agents'))}</p>`;
      renderSummaries(rows);
      return;
    }
    const grandTotal = (currentReport.by_harness ?? []).reduce(
      (sum, row) => sum + total(row.usage ?? {}),
      0,
    );
    const head = [
      t('Agent'),
      t('Captured tokens'),
      t('Share'),
      t('Input (fresh)'),
      t('Output'),
      t('Cache read/write'),
      t('Priced cost estimate'),
      t('Active sessions'),
      t('Data source'),
      t('Record granularity'),
      t('Status'),
    ];
    const body = rows
      .map((row) => {
        const usage = row.usage ?? {};
        const all = total(usage);
        const state = rowState(row.name, row.usage, row.activity, row.coverageStatus, row.context);
        const gran = granularityLabel(row.name, row.usage, row.context);
        const share = all && grandTotal ? (all / grandTotal) * 100 : null;
        const cache = number_or_zero(usage.cache_read_input_tokens) + number_or_zero(usage.cache_creation_input_tokens);
        const ids = new Set((currentReport.by_session ?? []).map((group) => group.key));
        const sessions = usage
          ? sessionMetadata.filter((meta) => meta.harness === row.name && ids.has(meta.id)).length
          : row.context
            ? row.context.sessions
            : row.activity
              ? row.activity.sessions
              : null;
        const sessionsCell = sessions === null ? '—' : sessions.toLocaleString();
        const costCell =
          usage?.estimated_cost_usd > 0
            ? `~$${usage.estimated_cost_usd.toFixed(2)}${usage.unpriced_events > 0 ? ' *' : ''}`
            : `<span class="muted">${window.escapeHTML(t('Unknown'))}</span>`;
        const granCell = gran
          ? `<span class="granularity-chip ${gran[0]}">${window.escapeHTML(gran[1])}</span>`
          : '<span class="muted">—</span>';
        const tokenCell = row.usage
          ? `<strong title="${window.escapeHTML(String(all))}">${window.escapeHTML(window.formatTokens(all))}</strong>`
          : `<span class="muted">${window.escapeHTML(t('Unknown'))}</span>`;
        return `<tr><td><button type="button" class="rank-agent" data-harness="${window.escapeHTML(row.name)}">${window.escapeHTML(friendly(row.name))}</button></td><td>${tokenCell}</td><td>${share === null ? '<span class="muted">—</span>' : `${share.toFixed(1)}%`}</td><td>${row.usage ? window.escapeHTML(window.formatTokens(number_or_zero(usage.input_tokens))) : '<span class="muted">—</span>'}</td><td>${row.usage ? window.escapeHTML(window.formatTokens(number_or_zero(usage.output_tokens))) : '<span class="muted">—</span>'}</td><td title="${window.escapeHTML(`${number_or_zero(usage.cache_read_input_tokens)} / ${number_or_zero(usage.cache_creation_input_tokens)}`)}">${row.usage ? window.escapeHTML(window.formatTokens(cache)) : '<span class="muted">—</span>'}</td><td>${costCell}</td><td>${sessionsCell}</td><td>${window.escapeHTML(sourceLabel(row.name, row.coverageStatus, row.activity, row.context))}</td><td>${granCell}</td><td><span class="state-pill ${state.kind}">${window.escapeHTML(state.label)}</span></td></tr>`;
      })
      .join('');
    el.innerHTML = `<table class="rank-table"><thead><tr>${head
      .map((label) => `<th>${window.escapeHTML(label)}</th>`)
      .join('')}</tr></thead><tbody>${body}</tbody></table>`;
    for (const button of el.querySelectorAll('.rank-agent')) {
      button.addEventListener('click', () => {
        const params = new URLSearchParams(window.location.search);
        params.set('harness', button.dataset.harness);
        params.delete('session');
        window.location.search = params.toString();
      });
    }
    const footnote = document.querySelector('#agent-footnote');
    if (footnote) {
      footnote.textContent = t(
        'Doubao Work has activity records only and takes no part in token ranking or cost conclusions; task-run totals are not stackable with model responses.',
      );
    }
    renderSummaries(rows);
  }

  function renderSummaries(rows) {
    const el = document.querySelector('#agent-summaries');
    if (!el || !currentReport) {
      return;
    }
    const withUsage = rows.filter((row) => row.usage);
    const top = [...withUsage].sort(
      (a, b) => total(b.usage) - total(a.usage),
    )[0];
    const grandTotal = (currentReport.by_harness ?? []).reduce(
      (sum, row) => sum + total(row.usage ?? {}),
      0,
    );
    const priced = withUsage.filter(
      (row) => row.usage.estimated_cost_usd > 0 && number_or_zero(row.usage.unpriced_events) === 0,
    ).length;
    const partial = withUsage.filter(
      (row) => row.usage.estimated_cost_usd > 0 && number_or_zero(row.usage.unpriced_events) > 0,
    ).length;
    const unpricedModels = (currentReport.pricing?.unpriced ?? [])
      .slice(0, 3)
      .map((model) => model.model)
      .filter(Boolean);
    const gaps = rows.filter((row) => !row.usage);
    let topCache = '';
    if (top) {
      const input = number_or_zero(top.usage.input_tokens) + number_or_zero(top.usage.cache_read_input_tokens) + number_or_zero(top.usage.cache_creation_input_tokens);
      topCache =
        input > 0
          ? ` · ${t('cache read is {percent} of its own usage', { percent: Math.round((number_or_zero(top.usage.cache_read_input_tokens) / input) * 100) + '%' })}`
          : '';
    }
    el.innerHTML = [
      {
        title: t('Highest consumption'),
        body: top
          ? `<span class="summary-strong">${window.escapeHTML(friendly(top.name))} · ${window.escapeHTML(window.formatTokens(total(top.usage)))}</span><p>${window.escapeHTML(t('Share of all captured tokens: {percent}', { percent: grandTotal ? ((total(top.usage) / grandTotal) * 100).toFixed(1) + '%' : '—' }))}${topCache}</p>`
          : `<p>${window.escapeHTML(t('No usage evidence in this range'))}</p>`,
      },
      {
        title: t('Cost completeness'),
        body: withUsage.length
          ? `<span class="summary-strong">${priced} / ${withUsage.length} ${window.escapeHTML(t('sources fully priced'))}${partial ? ` · ${partial} ${window.escapeHTML(t('partial'))}` : ''}</span><p>${unpricedModels.length ? `${window.escapeHTML(t('Missing list prices'))}: ${window.escapeHTML(unpricedModels.join(', '))}${(currentReport.pricing?.unpriced?.length ?? 0) > unpricedModels.length ? ' …' : ''}` : window.escapeHTML(t('All models with usage have list prices'))}</p>`
          : `<p>${window.escapeHTML(t('No usage evidence in this range'))}</p>`,
      },
      {
        title: t('Data gaps'),
        body: gaps.length
          ? `<span class="summary-strong">${gaps.length} ${window.escapeHTML(t('sources cannot provide tokens'))}</span><p>${window.escapeHTML(gaps.slice(0, 3).map((row) => friendly(row.name)).join(', '))}${gaps.length > 3 ? ' …' : ''}</p>`
          : `<p>${window.escapeHTML(t('Every source in range provided usage or an explicit status'))}</p>`,
      },
    ]
      .map(
        (card) =>
          `<div class="summary-card"><h3>${window.escapeHTML(card.title)}</h3>${card.body}</div>`,
      )
      .join('');
  }

  /* ---- Detailed analysis tab ---- */

  function renderDimension() {
    if (!currentReport) {
      return;
    }
    const nativeBar = document.querySelector('#native-dimension-bar');
    const sessionTools = document.querySelector('#session-tools');
    const key = dimension === 'native' ? document.querySelector('#agent-dimension')?.value ?? 'by_agent_model' : dimension;
    if (nativeBar) {
      nativeBar.hidden = dimension !== 'native';
    }
    if (sessionTools) {
      sessionTools.hidden = dimension !== 'by_session';
    }
    const requestLevel = !key.startsWith('by_');
    let rows = requestLevel
      ? (currentReport.native?.groups?.[key] ?? [])
      : (currentReport[key] ?? []);
    const exact = document.querySelector('#dimension-exact')?.checked ?? false;
    const format = (value) => (exact ? Number(value).toLocaleString() : window.formatTokens(value));
    if (key === 'by_session') {
      const search = document.querySelector('#token-session-search')?.value ?? '';
      const sort = document.querySelector('#token-session-sort')?.value ?? 'tokens';
      rows = selectSessions(rows, search, sort);
    } else if (key === 'by_agent_time') {
      rows = [...rows].sort(
        (a, b) =>
          b.key.split(' / ').at(-1).localeCompare(a.key.split(' / ').at(-1)) ||
          a.key.localeCompare(b.key),
      );
    } else {
      rows = [...rows].sort(
        (a, b) =>
          (requestLevel ? b.tokens ?? 0 : total(b.usage ?? {})) -
          (requestLevel ? a.tokens ?? 0 : total(a.usage ?? {})),
      );
    }
    const count = document.querySelector('#dimension-count');
    const capped = rows.length > 100;
    if (count) {
      count.textContent = `${Math.min(rows.length, 100)} / ${rows.length}${capped ? ` · ${t('showing first 100 groups')}` : ''}`;
    }
    const table = document.querySelector('#agent-dimension-table');
    if (!rows.length) {
      table.innerHTML = `<p class="muted section-pad">${window.escapeHTML(t('No usage evidence for this dimension'))}</p>`;
      renderDimensionNote(key, requestLevel);
      return;
    }
    const grand = (currentReport[key] ?? []).reduce(
      (sum, row) => sum + (requestLevel ? row.tokens ?? 0 : total(row.usage ?? {})),
      0,
    );
    const columns = requestLevel
      ? [t('Group'), t('Tokens'), t('Share'), t('Usage reports / records'), t('Mean duration (ms)'), t('Mean first-token latency (ms)')]
      : [t('Group'), t('Tokens'), t('Share'), t('Events'), t('Est. USD')];
    const body = rows.slice(0, 100)
      .map((row) => {
        const value = requestLevel ? row.tokens ?? 0 : total(row.usage ?? {});
        const share = grand ? ((value / grand) * 100).toFixed(1) + '%' : '—';
        const cells = [
          window.escapeHTML(displayKey(row.key)),
          requestLevel && !row.usage_requests ? `<span class="muted">—</span>` : window.escapeHTML(format(value)),
          share,
          requestLevel
            ? `${row.usage_requests ?? 0} / ${row.requests ?? 0}`
            : window.escapeHTML(String(row.usage?.events ?? 0)),
        ];
        if (requestLevel) {
          cells.push(
            row.duration_ms > 0 ? String(Math.round(row.duration_ms / row.timed_requests)) : `<span class="muted">—</span>`,
          );
          cells.push(
            row.ttft_requests > 0 ? String(Math.round(row.ttft_ms / row.ttft_requests)) : `<span class="muted" title="${window.escapeHTML(t('Source does not provide this field'))}">—</span>`,
          );
        } else {
          const cost = row.usage?.estimated_cost_usd;
          cells.push(
            cost > 0 ? `~$${cost.toFixed(4)}` : `<span class="muted">${window.escapeHTML(t('Unknown'))}</span>`,
          );
        }
        return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
      })
      .join('');
    table.innerHTML = `<table class="rank-table"><thead><tr>${columns
      .map((label) => `<th>${window.escapeHTML(label)}</th>`)
      .join('')}</tr></thead><tbody>${body}</tbody></table>`;
    renderDimensionNote(key, requestLevel);
  }

  function displayKey(key) {
    const text = String(key);
    if (text.startsWith('run / ')) {
      return `${t('run')} / ${t(text.slice(6))}`;
    }
    return t(text);
  }

  function selectSessions(rows, search, sort) {
    const needle = search.trim().toLowerCase();
    const enriched = rows.map((row) => ({
      ...row,
      metadata: sessionMetadata.find((meta) => meta.id === row.key),
    }));
    const filtered = enriched.filter((row) =>
      [row.key, row.metadata?.repository, row.metadata?.harness, row.metadata?.title]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
    return filtered.sort((a, b) => {
      if (sort === 'time') {
        return (Date.parse(b.metadata?.last_event_at) || 0) - (Date.parse(a.metadata?.last_event_at) || 0);
      }
      if (sort === 'session') {
        return String(a.key).localeCompare(String(b.key));
      }
      const value = (row) =>
        sort === 'cost'
          ? row.usage?.estimated_cost_usd ?? 0
          : sort === 'events'
            ? row.usage?.events ?? 0
            : total(row.usage ?? {});
      return value(b) - value(a) || String(a.key).localeCompare(String(b.key));
    });
  }

  function renderDimensionNote(key, requestLevel) {
    const note = document.querySelector('#agent-dimension-note');
    if (!note) {
      return;
    }
    note.textContent = t(
      requestLevel
        ? 'Native dimensions count usage records, not necessarily API requests. AutoClaw 2.x uses run aggregates, separated by a run prefix; its model is the run connection model and its request latency is unavailable. Doubao activity is excluded. Unknown retries and latency remain unknown.'
        : 'Cross dimensions use the same deduplicated usage as the main report. Unknown prices remain unknown; estimates may exclude unpriced models.',
    );
  }

  /* ---- Public hooks ---- */

  function update(report, status, sessions = sessionMetadata) {
    sessionMetadata = sessions;
    currentReport = report;
    currentStatus = status;
    const select = document.querySelector('select[name="harness"]');
    const selected =
      select.value || new URLSearchParams(window.location.search).get('harness') || '';
    const names = agentNames(report, currentCoverage, status);
    if (selected && !names.includes(selected)) {
      names.push(selected);
    }
    select.replaceChildren();
    for (const name of ['', ...names]) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name ? friendly(name) : t('All Agents');
      select.append(option);
    }
    select.value = selected;
    renderAgents();
    renderDimension();
  }

  function coverage(value) {
    currentCoverage = value;
    if (currentReport) {
      // Add runtimes with activity but no token records to the filter too.
      update(currentReport, currentStatus);
    }
  }

  window.BeaconAgentView = Object.freeze({
    setup,
    update,
    coverage,
    refresh: renderDimension,
    total,
    agentNames,
    orderAgents,
    inspectGrokSnapshot,
  });
})();
