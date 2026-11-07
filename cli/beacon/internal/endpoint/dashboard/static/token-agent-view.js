/* Agent comparison and detailed-analysis tabs; Grok Bot snapshot import.
   Absent telemetry stays absent rather than becoming zero. */
(() => {
  'use strict';
  const t = window.BeaconI18n.t;
  let currentReport = null;
  let grokImportPending = false;
  let currentStatus = {};
  let sessionMetadata = [];
  let sessionMetadataState = { available: false, truncated: false };
  let currentCoverage = { runtimes: [] };
  let dimension = 'by_model';
  let detailAgent = null;
  let detailSessionId = null;
  let dimensionPage = 0;
  const dimensionPageSize = 50;
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
  function estimateDetails(usage) {
    const value = usage?.estimated_cost_usd;
    if (!Number.isFinite(value) || value < 0) return null;
    if (value === 0 && !['estimated', 'mixed'].includes(usage?.cost_source)) return null;
    return { value, partial: Number(usage?.unpriced_events ?? 0) > 0 };
  }
  function sessionCount(name, groups, metadata, metadataState) {
    if (!metadataState.available) {
      return null;
    }
    const ids = new Set(groups.map((group) => group.key));
    const known = new Set(metadata.map((item) => item.id));
    return {
      count: metadata.filter((item) => item.harness === name && ids.has(item.id)).length,
      partial: metadataState.truncated || [...ids].some((id) => !known.has(id)),
    };
  }
  function recentAgentSessions(name, groups, metadata, limit = 3) {
    const byId = new Map(
      metadata.filter((item) => item.harness === name).map((item) => [item.id, item]),
    );
    return groups
      .filter((group) => byId.has(group.key))
      .map((group) => ({ ...group, metadata: byId.get(group.key) }))
      .sort(
        (a, b) =>
          (Date.parse(b.metadata.last_event_at) || 0) -
            (Date.parse(a.metadata.last_event_at) || 0) ||
          String(a.key).localeCompare(String(b.key)),
      )
      .slice(0, limit);
  }
  function sessionTime(value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString() : t('Unknown');
  }
  function auditAvailability(id, state) {
    if (state.auditIds?.includes(id)) return 'available';
    return !state.available || state.truncated ? 'unknown' : 'absent';
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
  const ALLOWED_STATUS = new Set(['completed', 'error', 'cancelled']);

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
    const affectedRows = new Set();
    const problems = [
      { kind: 'duplicate', rows: 0, detail: '' },
      { kind: 'counts', rows: 0, detail: '' },
      { kind: 'status', rows: 0, detail: '' },
      { kind: 'identity', rows: 0, detail: '' },
      { kind: 'metadata', rows: 0, detail: '' },
    ];
    const sums = { fresh: 0n, output: 0n, read: 0n, write: 0n };
    const encoder = new TextEncoder();
    const validIdentity = (value, limit) =>
      typeof value === 'string' && value.length > 0 && encoder.encode(value).length <= limit;
    const optionalInteger = (value, min) =>
      value === null || value === undefined || (Number.isSafeInteger(value) && value >= min);
    payload.rows.forEach((row, index) => {
      const id = row?.id;
      if (
        !validIdentity(id, 256) ||
        !validIdentity(row?.session, 256) ||
        !Number.isSafeInteger(row?.completed_at_ms) ||
        row.completed_at_ms <= 0
      ) {
        problems[3].rows += 1;
        affectedRows.add(index);
        problems[3].detail ||= t(
          'Example: row {row} requires valid id, session and completed_at_ms',
          { row: index + 1 },
        );
      }
      if (typeof id === 'string' && id.length > 0) {
        if (seen.has(id)) {
          problems[0].rows += 1;
          affectedRows.add(index);
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
        if (!Number.isSafeInteger(value) || value < 0 || value > 1e12) {
          countsOk = false;
          problems[1].detail ||= t('Example: row {row} has invalid {field}', {
            row: index + 1,
            field,
          });
        }
      }
      const reasoning = row?.reasoning_tokens ?? 0;
      if (
        !Number.isSafeInteger(reasoning) ||
        reasoning < 0 ||
        (Number.isSafeInteger(row?.output_tokens) && reasoning > row.output_tokens)
      ) {
        countsOk = false;
        problems[1].detail ||= t('Example: row {row} has invalid reasoning_tokens', {
          row: index + 1,
        });
      }
      if (!countsOk) {
        problems[1].rows += 1;
        affectedRows.add(index);
      }
      if (countsOk) {
        sums.fresh += BigInt(row.fresh_input_tokens);
        sums.output += BigInt(row.output_tokens);
        sums.read += BigInt(row.cache_read_tokens);
        sums.write += BigInt(row.cache_write_tokens);
      }
      if (!ALLOWED_STATUS.has(row?.status)) {
        problems[2].rows += 1;
        affectedRows.add(index);
        problems[2].detail ||= t('Example: row {row} has status "{status}"', {
          row: index + 1,
          status: String(row?.status),
        });
      }
      const model = row?.model ?? '';
      if (
        typeof model !== 'string' ||
        encoder.encode(model).length > 150 ||
        !optionalInteger(row?.duration_ms, 0) ||
        !optionalInteger(row?.ttft_ms, 0) ||
        !optionalInteger(row?.attempt, -1)
      ) {
        problems[4].rows += 1;
        affectedRows.add(index);
        problems[4].detail ||= t('Example: row {row} has invalid model or timing metadata', {
          row: index + 1,
        });
      }
    });
    return { count: payload.rows.length, sums, problems, affectedRows: affectedRows.size };
  }

  /* ---- Setup ---- */

  function setup() {
    const grokDialog = document.querySelector('#grok-import-dialog');
    document
      .querySelector('#grok-open-dialog')
      ?.addEventListener('click', () => grokDialog.showModal());
    document.querySelector('#grok-dialog-close')?.addEventListener('click', () => {
      if (!grokImportPending) grokDialog.close();
    });
    grokDialog?.addEventListener('cancel', (event) => {
      if (grokImportPending) event.preventDefault();
    });
    grokDialog?.addEventListener('close', resetGrokFile);
    const dropzone = document.querySelector('#grok-dropzone');
    dropzone?.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (!grokImportPending) dropzone.classList.add('is-dragging');
    });
    dropzone?.addEventListener('dragleave', (event) => {
      if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove('is-dragging');
    });
    dropzone?.addEventListener('drop', (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-dragging');
      handleGrokDrop(event.dataTransfer?.files).catch((error) =>
        setImportFeedback(error.message, false),
      );
    });
    const detail = document.querySelector('#agent-detail-dialog');
    document.querySelector('#agent-detail-close')?.addEventListener('click', () => detail.close());
    document.querySelector('#token-session-close')?.addEventListener('click', () => {
      document.querySelector('#token-session-dialog').close();
    });
    document.querySelector('#token-session-copy')?.addEventListener('click', async () => {
      const sessionId = detailSessionId;
      const status = document.querySelector('#token-session-copy-status');
      if (!sessionId || !status) return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(sessionId);
        if (detailSessionId === sessionId) status.textContent = t('Copied');
      } catch {
        if (detailSessionId === sessionId) status.textContent = t('Could not copy session ID');
      }
    });
    document.querySelector('#agent-detail-filter')?.addEventListener('click', () => {
      if (!detailAgent) return;
      const params = new URLSearchParams(window.location.search);
      params.set('harness', detailAgent);
      params.set('view', 'details');
      params.delete('session');
      window.location.search = params.toString();
    });
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
      dimensionPage = 0;
      for (const option of tabs.querySelectorAll('button')) {
        option.classList.toggle('active', option === button);
      }
      renderDimension();
    });
    document.querySelector('#dimension-exact')?.addEventListener('change', renderDimension);
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
      dimensionSelect.addEventListener('change', resetDimensionPage);
    }
    document.querySelector('#dimension-prev')?.addEventListener('click', () => {
      dimensionPage = Math.max(0, dimensionPage - 1);
      renderDimension();
    });
    document.querySelector('#dimension-next')?.addEventListener('click', () => {
      dimensionPage += 1;
      renderDimension();
    });
    document.querySelector('#grok-usage-file')?.addEventListener('change', () =>
      previewGrok().catch((error) => {
        setImportFeedback(error.message, false);
      }),
    );
    document.querySelector('#grok-usage-import')?.addEventListener('click', () =>
      importGrok().catch((error) => {
        setImportFeedback(error.message, false);
      }),
    );
    document.querySelector('#grok-cancel')?.addEventListener('click', () => {
      if (!grokImportPending) grokDialog.close();
    });
    document.querySelector('#grok-rechoose')?.addEventListener('click', () => {
      if (!grokImportPending) resetGrokFile();
    });
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
      .map(
        ([kind, label]) =>
          `<span class="granularity-chip ${kind}">${window.escapeHTML(label)}</span>`,
      )
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

  async function handleGrokDrop(files) {
    if (grokImportPending) return;
    if (!files || files.length !== 1) {
      resetGrokFile();
      throw new Error(t('Drop exactly one JSON snapshot.'));
    }
    const input = document.querySelector('#grok-usage-file');
    try {
      input.files = files;
    } catch {
      resetGrokFile();
      throw new Error(t('Unable to select the dropped file; use the file chooser.'));
    }
    await previewGrok();
  }

  function renderGrokErrors(problems, affectedRows) {
    const titles = {
      duplicate: t('Duplicate record IDs'),
      counts: t('Invalid token counts (negative or missing)'),
      status: t('Invalid status field'),
      identity: t('Invalid request identity or completion time'),
      metadata: t('Invalid model or timing metadata'),
    };
    const active = problems
      .map((problem, index) => ({ ...problem, index: index + 1 }))
      .filter((problem) => problem.rows > 0);
    if (!active.length) {
      return '';
    }
    return `<div class="import-error-banner"><strong>${window.escapeHTML(
      t('Validation failed; snapshot not imported'),
    )}</strong>${window.escapeHTML(
      t('{kinds} error kinds · {rows} rows affected. The previous snapshot is kept.', {
        kinds: active.length,
        rows: affectedRows,
      }),
    )}</div>${active
      .map(
        (problem) =>
          `<div class="import-error-item"><div class="error-title"><span class="error-index">${problem.index}</span>${window.escapeHTML(titles[problem.kind])}<span class="error-badge">${window.escapeHTML(t('{count} rows', { count: problem.rows }))}</span></div><p>${window.escapeHTML(problem.detail ?? '')}</p></div>`,
      )
      .join('')}`;
  }

  async function previewGrok() {
    const input = document.querySelector('#grok-usage-file');
    const button = document.querySelector('#grok-usage-import');
    const preview = document.querySelector('#grok-usage-preview');
    button.disabled = true;
    preview.textContent = '';
    document.querySelector('#grok-file-row').hidden = true;
    document.querySelector('#grok-counts').hidden = true;
    document.querySelector('#grok-count-cards').replaceChildren();
    const result = document.querySelector('#grok-import-result');
    if (result) {
      result.textContent = '';
    }
    const file = input.files[0];
    if (!file) {
      return;
    }
    let inspected;
    try {
      if (file.size > 8 * 1024 * 1024) {
        throw new Error(t('Choose a JSON file up to 8 MiB'));
      }
      inspected = inspectGrokSnapshot(await file.text());
    } catch (error) {
      if (input.files[0] !== file) return;
      throw error;
    }
    if (input.files[0] !== file) {
      return;
    }
    const row = document.querySelector('#grok-file-row');
    row.hidden = false;
    document.querySelector('#grok-file-name').textContent = file.name;
    document.querySelector('#grok-file-meta').textContent =
      `${(file.size / (1024 * 1024)).toFixed(1)} MB · ${inspected.count.toLocaleString()} ${t('rows')} · version 1`;
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
    preview.innerHTML = renderGrokErrors(inspected.problems, inspected.affectedRows);
    button.disabled = failed;
  }

  async function importGrok() {
    if (grokImportPending) return;
    const file = document.querySelector('#grok-usage-file')?.files[0];
    if (!file || file.size > 8 * 1024 * 1024) {
      throw new Error(t('Choose a JSON file up to 8 MiB'));
    }
    const button = document.querySelector('#grok-usage-import');
    const input = document.querySelector('#grok-usage-file');
    const close = document.querySelector('#grok-dialog-close');
    const cancel = document.querySelector('#grok-cancel');
    grokImportPending = true;
    button.disabled = true;
    input.disabled = true;
    close.disabled = true;
    cancel.disabled = true;
    try {
      const body = await file.text();
      const inspected = inspectGrokSnapshot(body);
      if (inspected.problems.some((problem) => problem.rows > 0)) {
        throw new Error(t('Validation failed; snapshot not imported'));
      }
      if (document.querySelector('#grok-usage-file').files[0] !== file) {
        return;
      }
      const response = await fetch('/api/native-usage/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(30000),
      });
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
      setImportFeedback(
        t('Import complete; the snapshot replaced the previous one. Refresh to view.'),
        true,
      );
      window.clearDataCache?.('/api/tokens');
    } finally {
      grokImportPending = false;
      input.disabled = false;
      close.disabled = false;
      cancel.disabled = false;
      if (input.files[0] === file) button.disabled = false;
    }
  }

  /* ---- Agent comparison tab ---- */

  function sourceLabel(name, expectation, activity, context) {
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
    return expectations[expectation] ?? '—';
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
      return usage
        ? { kind: 'snapshot', label: t('Snapshot usage received') }
        : { kind: 'warn', label: t('Not connected; import available') };
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
        expectation: currentCoverage.runtimes?.find((row) => row.harness === name)?.expectation,
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
        const cache =
          number_or_zero(usage.cache_read_input_tokens) +
          number_or_zero(usage.cache_creation_input_tokens);
        const sessions = row.usage
          ? sessionCount(
              row.name,
              currentReport.by_session ?? [],
              sessionMetadata,
              sessionMetadataState,
            )
          : row.context
            ? { count: row.context.sessions, partial: false }
            : row.activity
              ? { count: row.activity.sessions, partial: false }
              : null;
        const sessionsCell =
          sessions === null || !Number.isFinite(sessions.count)
            ? `<span class="muted">${window.escapeHTML(t('Unknown'))}</span>`
            : sessions.partial
              ? `<span title="${window.escapeHTML(t('Session metadata is incomplete; count is a minimum'))}">≥ ${sessions.count.toLocaleString()}</span>`
              : sessions.count.toLocaleString();
        const estimate = estimateDetails(row.usage);
        const costCell = estimate
          ? `<span title="${window.escapeHTML(String(estimate.value))}">~$${estimate.value.toFixed(2)}${estimate.partial ? ' *' : ''}</span>`
          : `<span class="muted">${window.escapeHTML(t('Unknown'))}</span>`;
        const granCell = gran
          ? `<span class="granularity-chip ${gran[0]}">${window.escapeHTML(gran[1])}</span>`
          : '<span class="muted">—</span>';
        const tokenCell = row.usage
          ? `<strong title="${window.escapeHTML(String(all))}">${window.escapeHTML(window.formatTokens(all))}</strong>`
          : `<span class="muted">${window.escapeHTML(t('Unknown'))}</span>`;
        return `<tr><td><button type="button" class="rank-agent" data-harness="${window.escapeHTML(row.name)}">${window.escapeHTML(friendly(row.name))}</button></td><td>${tokenCell}</td><td>${share === null ? '<span class="muted">—</span>' : `${share.toFixed(1)}%`}</td><td>${row.usage ? window.escapeHTML(window.formatTokens(number_or_zero(usage.input_tokens))) : '<span class="muted">—</span>'}</td><td>${row.usage ? window.escapeHTML(window.formatTokens(number_or_zero(usage.output_tokens))) : '<span class="muted">—</span>'}</td><td title="${window.escapeHTML(`${number_or_zero(usage.cache_read_input_tokens)} / ${number_or_zero(usage.cache_creation_input_tokens)}`)}">${row.usage ? window.escapeHTML(window.formatTokens(cache)) : '<span class="muted">—</span>'}</td><td>${costCell}</td><td>${sessionsCell}</td><td>${window.escapeHTML(sourceLabel(row.name, row.expectation, row.activity, row.context))}</td><td>${granCell}</td><td><span class="state-pill ${state.kind}">${window.escapeHTML(state.label)}</span></td></tr>`;
      })
      .join('');
    el.innerHTML = `<table class="rank-table"><thead><tr>${head
      .map((label) => `<th>${window.escapeHTML(label)}</th>`)
      .join('')}</tr></thead><tbody>${body}</tbody></table>`;
    for (const button of el.querySelectorAll('.rank-agent')) {
      button.addEventListener('click', () => {
        const row = rows.find((item) => item.name === button.dataset.harness);
        if (row) openAgentDetail(row, grandTotal);
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

  function openAgentDetail(row, grandTotal) {
    const dialog = document.querySelector('#agent-detail-dialog');
    const content = document.querySelector('#agent-detail-content');
    if (!dialog || !content) return;
    detailAgent = row.name;
    document.querySelector('#agent-detail-title').textContent = friendly(row.name);
    const usage = row.usage;
    const state = rowState(row.name, usage, row.activity, row.coverageStatus, row.context);
    const granularity = granularityLabel(row.name, usage, row.context);
    const count = usage
      ? sessionCount(
          row.name,
          currentReport.by_session ?? [],
          sessionMetadata,
          sessionMetadataState,
        )
      : null;
    const sessions = count
      ? `${count.partial ? '≥ ' : ''}${count.count.toLocaleString()}`
      : t('Unknown');
    const estimate = estimateDetails(usage);
    const cost = estimate
      ? `~$${estimate.value.toFixed(2)}${estimate.partial ? ' *' : ''}`
      : t('Unknown');
    const cards = [
      [t('Captured tokens'), usage ? window.formatTokens(total(usage)) : t('Unknown')],
      [t('Share'), usage ? dimensionShare(total(usage), grandTotal) : '—'],
      [t('Active sessions'), sessions],
      [t('Priced cost estimate'), cost],
    ];
    const composition = [
      [t('Input (fresh)'), usage?.input_tokens],
      [t('Cache read'), usage?.cache_read_input_tokens],
      [t('Cache write'), usage?.cache_creation_input_tokens],
      [t('Output'), usage?.output_tokens],
    ];
    const fields = [
      [t('Data source'), sourceLabel(row.name, row.expectation, row.activity, row.context)],
      [t('Record granularity'), granularity?.[1] ?? '—'],
      [t('Status'), state.label],
    ];
    const esc = window.escapeHTML;
    const recent = recentAgentSessions(row.name, currentReport.by_session ?? [], sessionMetadata);
    const recentMessage = !sessionMetadataState.available
      ? t('Session metadata unavailable')
      : recent.length
        ? ''
        : t('No matching sessions in this range');
    content.innerHTML = `<div class="agent-detail-cards">${cards.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>`).join('')}</div>
      <h3>${esc(t('Token composition'))}</h3><dl class="agent-detail-fields">${composition.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(usage ? window.formatTokens(number_or_zero(value)) : t('Unknown'))}</dd>`).join('')}
      ${fields.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(String(value))}</dd>`).join('')}</dl>
      <h3>${esc(t('Recent active sessions'))}</h3>
      <p class="method-note">${esc(t('Sessions match the selected usage range; activity times cover the entire session and may fall outside that range.'))}</p>
      ${sessionMetadataState.truncated ? `<p class="method-note">${esc(t('Session metadata truncated'))}</p>` : ''}
      ${recentMessage ? `<p class="method-note">${esc(recentMessage)}</p>` : ''}
      <div class="agent-recent-sessions">${recent.map((item, index) => `<button type="button" data-recent-session="${index}"><strong>${esc(item.metadata.title || item.metadata.repository || item.key)}</strong><span>${esc(item.key)} · ${esc(window.formatTokens(total(item.usage ?? {})))} · ${esc(sessionTime(item.metadata.last_event_at))}</span></button>`).join('')}</div>`;
    content.querySelectorAll('[data-recent-session]').forEach((button) => {
      button.addEventListener('click', () => {
        dialog.close();
        openTokenSession(recent[Number(button.dataset.recentSession)]);
      });
    });
    dialog.showModal();
  }

  function renderSummaries(rows) {
    const el = document.querySelector('#agent-summaries');
    if (!el || !currentReport) {
      return;
    }
    const withUsage = rows.filter((row) => row.usage);
    const top = [...withUsage].sort((a, b) => total(b.usage) - total(a.usage))[0];
    const grandTotal = (currentReport.by_harness ?? []).reduce(
      (sum, row) => sum + total(row.usage ?? {}),
      0,
    );
    const priced = withUsage.filter((row) => {
      const estimate = estimateDetails(row.usage);
      return estimate !== null && !estimate.partial;
    }).length;
    const partial = withUsage.filter((row) => estimateDetails(row.usage)?.partial).length;
    const unpricedModels = (currentReport.pricing?.unpriced ?? [])
      .slice(0, 3)
      .map((model) => model.model)
      .filter(Boolean);
    const gaps = rows.filter((row) => !row.usage);
    let topCache = '';
    if (top) {
      const input =
        number_or_zero(top.usage.input_tokens) +
        number_or_zero(top.usage.cache_read_input_tokens) +
        number_or_zero(top.usage.cache_creation_input_tokens);
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
          ? `<span class="summary-strong">${gaps.length} ${window.escapeHTML(t('sources cannot provide tokens'))}</span><p>${window.escapeHTML(
              gaps
                .slice(0, 3)
                .map((row) => friendly(row.name))
                .join(', '),
            )}${gaps.length > 3 ? ' …' : ''}</p>`
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

  function dimensionTotal(rows, requestLevel) {
    return rows.reduce(
      (sum, row) => sum + (requestLevel ? (row.tokens ?? 0) : total(row.usage ?? {})),
      0,
    );
  }

  function dimensionShare(value, totalValue) {
    if (!totalValue) {
      return '—';
    }
    const percent = (value / totalValue) * 100;
    return percent > 0 && percent < 0.05 ? '<0.1%' : `${percent.toFixed(1)}%`;
  }

  function dimensionPageBounds(length, page, size = dimensionPageSize) {
    const pages = Math.max(1, Math.ceil(length / size));
    const selected = Math.max(0, Math.min(page, pages - 1));
    return {
      page: selected,
      pages,
      start: selected * size,
      end: Math.min(length, (selected + 1) * size),
    };
  }

  function resetDimensionPage() {
    dimensionPage = 0;
    renderDimension();
  }

  function renderDimension() {
    if (!currentReport) {
      return;
    }
    const nativeBar = document.querySelector('#native-dimension-bar');
    const sessionTools = document.querySelector('#session-tools');
    const key =
      dimension === 'native'
        ? (document.querySelector('#agent-dimension')?.value ?? 'by_agent_model')
        : dimension;
    if (nativeBar) {
      nativeBar.hidden = dimension !== 'native';
    }
    if (sessionTools) {
      sessionTools.hidden = dimension !== 'by_session';
    }
    const requestLevel = !key.startsWith('by_');
    const dimensionRows = requestLevel
      ? (currentReport.native?.groups?.[key] ?? [])
      : (currentReport[key] ?? []);
    let rows = dimensionRows;
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
          (requestLevel ? (b.tokens ?? 0) : total(b.usage ?? {})) -
          (requestLevel ? (a.tokens ?? 0) : total(a.usage ?? {})),
      );
    }
    const count = document.querySelector('#dimension-count');
    const bounds = dimensionPageBounds(rows.length, dimensionPage);
    dimensionPage = bounds.page;
    if (count) {
      count.textContent = rows.length
        ? t('Showing {start}–{end} of {total} groups', {
            start: bounds.start + 1,
            end: bounds.end,
            total: rows.length,
          })
        : t('No usage evidence for this dimension');
    }
    const pagination = document.querySelector('#dimension-pagination');
    if (pagination) {
      pagination.hidden = bounds.pages <= 1;
      document.querySelector('#dimension-prev').disabled = bounds.page === 0;
      document.querySelector('#dimension-next').disabled = bounds.page === bounds.pages - 1;
      document.querySelector('#dimension-page').textContent = t('Page {page} of {pages}', {
        page: bounds.page + 1,
        pages: bounds.pages,
      });
    }
    const table = document.querySelector('#agent-dimension-table');
    if (!rows.length) {
      table.innerHTML = `<p class="muted section-pad">${window.escapeHTML(t('No usage evidence for this dimension'))}</p>`;
      renderDimensionNote(key, requestLevel);
      return;
    }
    const grand = dimensionTotal(dimensionRows, requestLevel);
    const columns = requestLevel
      ? [
          t('Group'),
          t('Tokens'),
          t('Share'),
          t('Usage reports / records'),
          t('Mean duration (ms)'),
          t('Mean first-token latency (ms)'),
        ]
      : [t('Group'), t('Tokens'), t('Share'), t('Events'), t('Est. USD')];
    const body = rows
      .slice(bounds.start, bounds.end)
      .map((row, index) => {
        const value = requestLevel ? (row.tokens ?? 0) : total(row.usage ?? {});
        const share = dimensionShare(value, grand);
        const cells = [
          key === 'by_session'
            ? `<button type="button" class="rank-agent" data-session-index="${index}">${window.escapeHTML(displayKey(row.key))}</button>`
            : window.escapeHTML(displayKey(row.key)),
          requestLevel && !row.usage_requests
            ? `<span class="muted">—</span>`
            : window.escapeHTML(format(value)),
          window.escapeHTML(share),
          requestLevel
            ? `${row.usage_requests ?? 0} / ${row.requests ?? 0}`
            : window.escapeHTML(String(row.usage?.events ?? 0)),
        ];
        if (requestLevel) {
          cells.push(
            row.timed_requests > 0
              ? String(Math.round(row.duration_ms / row.timed_requests))
              : `<span class="muted">—</span>`,
          );
          cells.push(
            row.ttft_requests > 0
              ? String(Math.round(row.ttft_ms / row.ttft_requests))
              : `<span class="muted" title="${window.escapeHTML(t('Source does not provide this field'))}">—</span>`,
          );
        } else {
          const cost = estimateDetails(row.usage);
          cells.push(
            cost
              ? `<span title="${window.escapeHTML(String(cost.value))}">~$${cost.value.toFixed(4)}${cost.partial ? ' *' : ''}</span>`
              : `<span class="muted">${window.escapeHTML(t('Unknown'))}</span>`,
          );
        }
        return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
      })
      .join('');
    table.innerHTML = `<table class="rank-table"><thead><tr>${columns
      .map((label) => `<th>${window.escapeHTML(label)}</th>`)
      .join('')}</tr></thead><tbody>${body}</tbody></table>`;
    table.querySelectorAll('[data-session-index]').forEach((button) => {
      button.addEventListener('click', () =>
        openTokenSession(rows[bounds.start + Number(button.dataset.sessionIndex)]),
      );
    });
    renderDimensionNote(key, requestLevel);
  }

  function openTokenSession(row) {
    const dialog = document.querySelector('#token-session-dialog');
    const content = document.querySelector('#token-session-content');
    if (!dialog || !content || !row) return;
    detailSessionId = row.key;
    const copyStatus = document.querySelector('#token-session-copy-status');
    if (copyStatus) copyStatus.textContent = '';
    const usage = row.usage ?? {};
    const meta = row.metadata ?? {};
    const estimate = estimateDetails(usage);
    const esc = window.escapeHTML;
    const fields = [
      [t('Session ID'), row.key],
      [t('Agent'), meta.harness ? friendly(meta.harness) : t('Unknown')],
      [t('Project'), meta.repository ?? t('Unknown')],
      [t('First activity across session'), sessionTime(meta.first_event_at)],
      [t('Latest activity across session'), sessionTime(meta.last_event_at)],
      [t('Captured tokens'), window.formatTokens(total(usage))],
      [t('Input (fresh)'), window.formatTokens(number_or_zero(usage.input_tokens))],
      [t('Cache read'), window.formatTokens(number_or_zero(usage.cache_read_input_tokens))],
      [t('Cache write'), window.formatTokens(number_or_zero(usage.cache_creation_input_tokens))],
      [t('Output'), window.formatTokens(number_or_zero(usage.output_tokens))],
      [t('Usage records'), Number.isFinite(usage.events) ? String(usage.events) : t('Unknown')],
      [
        t('Priced cost estimate'),
        estimate
          ? `~$${estimate.value.toFixed(4)}${estimate.partial ? ` · ${t('partial')}` : ''}`
          : t('Unknown'),
      ],
    ];
    content.innerHTML = `<dl class="agent-detail-fields">${fields.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(String(value))}</dd>`).join('')}</dl><p class="method-note">${esc(t('Estimates are list prices, not invoices; unknown costs remain unknown.'))}</p>
      <h3>${esc(t('Request-level evidence'))}</h3>
      <p class="method-note">${esc(t('This session aggregate does not provide attributable first-token latency, retry rate or context occupancy.'))}</p>
      <dl class="agent-detail-fields">${[t('First-token latency'), t('Retry rate'), t('Context occupancy')].map((label) => `<dt>${esc(label)}</dt><dd>${esc(t('Unknown'))}</dd>`).join('')}</dl>`;
    const eventsLink = document.querySelector('#token-session-events');
    const availability = auditAvailability(row.key, sessionMetadataState);
    const hasAudit = availability === 'available';
    eventsLink.hidden = !hasAudit;
    const notice = document.querySelector('#token-session-no-events');
    notice.hidden = hasAudit;
    notice.textContent = t(
      availability === 'unknown'
        ? 'Audit session availability could not be confirmed because session metadata is incomplete.'
        : 'No matching audit session is available for this usage record.',
    );
    if (hasAudit) {
      const params = new URLSearchParams({ id: row.key });
      if (window.BeaconI18n?.language) params.set('lang', window.BeaconI18n.language);
      params.set('return', `${window.location.pathname}${window.location.search}`);
      eventsLink.href = `/session.html?${params}`;
    }
    dialog.showModal();
  }

  function displayKey(key) {
    const text = String(key);
    if (text.startsWith('run / ')) {
      return `${t('run')} / ${t(text.slice(6))}`;
    }
    return t(text);
  }

  function selectSessions(rows, search, sort, metadata = sessionMetadata) {
    const needle = search.trim().toLowerCase();
    const enriched = rows.map((row) => ({
      ...row,
      metadata: metadata.find((meta) => meta.id === row.key) ?? row.metadata,
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
        return (
          (Date.parse(b.metadata?.last_event_at) || 0) -
          (Date.parse(a.metadata?.last_event_at) || 0)
        );
      }
      if (sort === 'session') {
        return String(a.key).localeCompare(String(b.key));
      }
      if (sort === 'cost') {
        const left = estimateDetails(a.usage);
        const right = estimateDetails(b.usage);
        const rank = (estimate) => (estimate === null ? 2 : estimate.partial ? 1 : 0);
        return (
          rank(left) - rank(right) ||
          (right?.value ?? 0) - (left?.value ?? 0) ||
          String(a.key).localeCompare(String(b.key))
        );
      }
      const value = (row) =>
        sort === 'events' ? (row.usage?.events ?? 0) : total(row.usage ?? {});
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

  function update(
    report,
    status,
    sessions = sessionMetadata,
    metadataState = sessionMetadataState,
  ) {
    sessionMetadata = sessions;
    sessionMetadataState = metadataState;
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
    refresh: resetDimensionPage,
    total,
    estimateDetails,
    agentNames,
    orderAgents,
    sessionCount,
    recentAgentSessions,
    sessionTime,
    auditAvailability,
    dimensionTotal,
    dimensionShare,
    dimensionPageBounds,
    sourceLabel,
    rowState,
    inspectGrokSnapshot,
  });
})();
