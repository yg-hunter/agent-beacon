/* Overview tab: KPI row, trend, ranking, composition and method notes.
   Raw telemetry and billing values are never rewritten; missing data stays missing. */
(() => {
  'use strict';
  const t = window.BeaconI18n.t;
  const number = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
  let snapshot = null;
  let currentReport = null;
  let currentSessions = null;
  let currentStatus = {};
  let coverageData = null;
  let projectMode = 'tokens';
  let trendMode = 'component';
  let trendScale = 'absolute';
  let trendExcludeRead = false;
  const MAX_TREND_BUCKETS = 72;

  // Hue-separated palette: stacked segments must stay distinguishable at a glance.
  const palette = {
    fresh: '#2f6f62',
    read: '#4e8fc7',
    write: '#d9a441',
    output: '#8a6fc8',
  };
  const donutPalette = ['#2f6f62', '#5b8f80', '#8fbdb0', '#c4d6ce'];

  function metrics(usage = {}) {
    const fresh = number(usage.input_tokens);
    const read = number(usage.cache_read_input_tokens);
    const write = number(usage.cache_creation_input_tokens);
    const output = number(usage.output_tokens);
    const input = fresh + read + write;
    return {
      fresh,
      read,
      write,
      output,
      input,
      total: input + output,
      cacheReadShare: input ? read / input : null,
      freshShare: input ? fresh / input : null,
      average: number(usage.events) ? (input + output) / usage.events : null,
    };
  }

  function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    // Spreadsheet programs must treat externally supplied identifiers as text.
    if (/^[\s]*[=+@-]/u.test(text)) {
      text = `'${text}`;
    }
    return `"${text.replaceAll('"', '""')}"`;
  }

  function exportCSV() {
    if (!snapshot) {
      return;
    }
    const columns = [
      'dimension',
      'key',
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'reasoning_output_tokens',
      'cost_usd',
      'estimated_cost_usd',
      'cost_source',
      'unpriced_events',
      'events',
    ];
    const rows = [columns];
    const report = snapshot.report ?? {};
    rows.push(['totals', 'all', ...columns.slice(2).map((key) => report.totals?.[key])]);
    for (const dimension of [
      'by_model',
      'by_session',
      'by_harness',
      'by_user',
      'by_run',
      'by_repository',
      'by_agent_model',
      'by_agent_project',
      'by_agent_time',
    ]) {
      for (const group of report[dimension] ?? []) {
        rows.push([dimension, group.key, ...columns.slice(2).map((key) => group.usage?.[key])]);
      }
    }
    for (const [key, value] of Object.entries(snapshot.filters ?? {})) {
      rows.push(['filter', key, value]);
    }
    rows.push(
      ['metadata', 'exported_at', snapshot.exported_at],
      ['metadata', 'timezone', snapshot.timezone],
      ['metadata', 'captured_at', snapshot.captured_at],
      ['metadata', 'pricing', JSON.stringify(report.pricing ?? {})],
    );
    const blob = new Blob(['\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    });
    download(blob, 'csv');
  }

  function exportJSON() {
    if (!snapshot) {
      return;
    }
    const data = {
      ...snapshot,
      exported_at: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    download(blob, 'json');
  }

  function download(blob, format) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `beacon-tokens-${Date.now()}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---- Static view tabs (Overview / Agents / Details / Sources) ---- */

  function showView(key, push = true) {
    for (const button of document.querySelectorAll('#token-view-tabs [role="tab"]')) {
      const active = button.id === `token-view-tab-${key}`;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(button.getAttribute('aria-controls'));
      if (panel) {
        panel.hidden = !active;
      }
    }
    if (push) {
      const params = new URLSearchParams(window.location.search);
      if (key === 'overview') {
        params.delete('view');
      } else {
        params.set('view', key);
      }
      history.replaceState(null, '', params.toString() ? `?${params.toString()}` : window.location.pathname);
    }
  }

  function setupViews() {
    const nav = document.querySelector('#token-view-tabs');
    if (!nav) {
      return;
    }
    const initial = new URLSearchParams(window.location.search).get('view');
    const valid = ['overview', 'agents', 'details', 'sources'];
    showView(valid.includes(initial) ? initial : 'overview', false);
    nav.addEventListener('click', (event) => {
      const button = event.target.closest('[role="tab"]');
      if (button) {
        showView(button.id.replace('token-view-tab-', ''));
      }
    });
    nav.addEventListener('keydown', (event) => {
      const buttons = [...nav.querySelectorAll('[role="tab"]')];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click();
      buttons[next].focus();
    });
    const trendToggle = document.querySelector('#trend-toggle');
    if (trendToggle) {
      trendToggle.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-mode]');
        if (!button) {
          return;
        }
        trendMode = button.dataset.mode;
        for (const option of trendToggle.querySelectorAll('button')) {
          option.classList.toggle('active', option === button);
        }
        renderTrend();
      });
    }
    const scaleToggle = document.querySelector('#trend-scale');
    if (scaleToggle) {
      scaleToggle.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-scale]');
        if (!button) {
          return;
        }
        trendScale = button.dataset.scale;
        for (const option of scaleToggle.querySelectorAll('button')) {
          option.classList.toggle('active', option === button);
        }
        renderTrend();
      });
    }
    const excludeRead = document.querySelector('#trend-exclude-read');
    if (excludeRead) {
      excludeRead.addEventListener('change', () => {
        trendExcludeRead = excludeRead.checked;
        renderTrend();
      });
    }
    const rankMore = document.querySelector('#token-rank-more');
    if (rankMore) {
      rankMore.addEventListener('click', () => showView('agents'));
    }
    const projectToggle = document.querySelector('#project-toggle');
    if (projectToggle) {
      projectToggle.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-key]');
        if (!button) {
          return;
        }
        projectMode = button.dataset.key;
        for (const option of projectToggle.querySelectorAll('button')) {
          option.classList.toggle('active', option === button);
        }
        renderProjects();
      });
    }
    const exportButton = document.querySelector('#shell-export');
    if (exportButton) {
      exportButton.addEventListener('click', () => {
        exportCSV();
      });
      exportButton.title = t('Exports use the last successful filtered report and exact numbers.');
    }
    const sample = document.querySelector('#grok-format-sample');
    if (sample) {
      sample.addEventListener('click', () => {
        const example = {
          version: 1,
          rows: [
            {
              request_id: 'req-001',
              model: 'grok-4',
              status: 'completed',
              fresh_input_tokens: 1204,
              output_tokens: 3560,
              cache_read_tokens: 182240,
              cache_write_tokens: 2048,
            },
          ],
        };
        const line = document.querySelector('#import-state-line');
        if (line) {
          line.textContent = t('Format example') + ': ' + JSON.stringify(example);
          line.className = 'import-state-ok';
        }
      });
    }
  }

  /* ---- KPI row ---- */

  function coverageCounts() {
    const rows = coverageData?.runtimes ?? [];
    const by = (statusKey) => rows.filter((row) => row.status === statusKey).length;
    return {
      total: rows.length,
      covered: by('covered'),
      silent: by('silent'),
      inactive: by('inactive'),
      notInstrumented: by('not_instrumented'),
      warnings: number(coverageData?.warnings?.length ?? currentReport?.native?.warnings?.length ?? 0),
    };
  }

  function stateChip(kind, label) {
    return `<span class="state-pill ${kind}">${window.escapeHTML(label)}</span>`;
  }

  function renderKpis() {
    const el = document.querySelector('#token-kpis');
    if (!el || !currentReport) {
      return;
    }
    const totals = currentReport.totals ?? {};
    const values = metrics(totals);
    const pricing = currentReport.pricing ?? {};
    const unpriced = pricing.unpriced?.length ?? 0;
    const eventsWithUsage = number(currentReport.events_with_usage);
    const pricedShare =
      eventsWithUsage > 0 && totals.unpriced_events !== undefined
        ? Math.max(0, 1 - number(totals.unpriced_events) / eventsWithUsage)
        : null;
    const counts = coverageCounts();
    const chips = [
      counts.covered ? stateChip('ok', `${t('Usage received')} ${counts.covered}`) : '',
      counts.silent ? stateChip('activity', `${t('Activity without expected usage')} ${counts.silent}`) : '',
      counts.inactive ? stateChip('muted', `${t('No activity in range')} ${counts.inactive}`) : '',
      counts.notInstrumented ? stateChip('muted', `${t('No token capture path')} ${counts.notInstrumented}`) : '',
      counts.warnings ? stateChip('warn', `${t('Read failures')} ${counts.warnings}`) : '',
    ];
    const cards = [
      {
        label: t('Captured tokens'),
        value: window.formatCompactTokens(values.total),
        title: window.formatExactTokens(values.total),
        hint: `<span class="kpi-split"><span><i class="dot dot-fresh"></i>${window.escapeHTML(t('Fresh input'))} ${values.input ? Math.round((values.fresh / values.input) * 100) : 0}%</span><span><i class="dot dot-output"></i>${window.escapeHTML(t('Output'))} ${values.total ? Math.round((values.output / values.total) * 100) : 0}%</span></span>`,
      },
      {
        label: `${t('Priced cost estimate')} <span class="granularity-chip task">${window.escapeHTML(t('estimate'))}</span>`,
        value:
          totals.estimated_cost_usd > 0
            ? `$${totals.estimated_cost_usd.toFixed(2)}`
            : t('Unknown'),
        hint:
          (unpriced
            ? `${window.escapeHTML(t('{count} models without list price', { count: unpriced }))} · `
            : '') +
          window.escapeHTML(t('Unknown is not free')) +
          (pricedShare !== null
            ? ` · ${window.escapeHTML(t('covers {percent} of captured usage', { percent: Math.round(pricedShare * 100) + '%' }))}`
            : ''),
      },
      {
        label: t('Cache read share'),
        value: values.cacheReadShare === null ? t('Unknown') : `${(values.cacheReadShare * 100).toFixed(1)}%`,
        hint: `${window.escapeHTML(t('Read'))} ${window.escapeHTML(window.formatTokens(values.read))} · ${window.escapeHTML(t('Write'))} ${window.escapeHTML(window.formatTokens(values.write))}`,
      },
      {
        label: t('Collection status summary'),
        status: true,
        count: `${counts.covered}<small>/ ${counts.total} ${window.escapeHTML(t('sources'))}</small>`,
        hint: `<span class="kpi-chip-row">${chips.filter(Boolean).join('') || stateChip('muted', t('No runtime evidence in this range'))}</span>`,
      },
    ];
    el.innerHTML = cards
      .map((card) => {
        if (card.status) {
          return `<div class="kpi-card kpi-status"><span class="kpi-label">${card.label}</span><span class="kpi-count">${card.count}</span><span class="kpi-hint">${card.hint}</span></div>`;
        }
        return `<div class="kpi-card"><span class="kpi-label">${card.label}</span><span class="kpi-value" title="${window.escapeHTML(card.title ?? '')}">${card.value}</span><span class="kpi-hint">${card.hint}</span></div>`;
      })
      .join('');
    // KPI split dots share the chart palette through the CSSOM.
    const freshDot = el.querySelector('.dot-fresh');
    const outputDot = el.querySelector('.dot-output');
    if (freshDot) {
      freshDot.style.background = palette.fresh;
    }
    if (outputDot) {
      outputDot.style.background = palette.output;
    }
  }

  /* ---- Trend chart (stacked by component) ---- */

  // Long ranges would either overflow the chart or hide most of the history behind a
  // truncation cap. Merging consecutive buckets keeps the full selected range visible;
  // the merge factor is reported so the wider granularity stays explicit.
  function mergeBuckets(rows, maxBars) {
    if (rows.length <= maxBars) {
      return { rows, note: '' };
    }
    const factor = Math.ceil(rows.length / maxBars);
    const merged = [];
    for (let index = 0; index < rows.length; index += factor) {
      const chunk = rows.slice(index, index + factor);
      const row = { ...chunk[0] };
      for (const part of chunk.slice(1)) {
        for (const key of Object.keys(part)) {
          if (key !== 'start' && typeof part[key] === 'number') {
            row[key] = (row[key] ?? 0) + part[key];
          }
        }
      }
      merged.push(row);
    }
    return {
      rows: merged,
      note: t('Merged {src} buckets into {dst} to show the full range', {
        src: rows.length,
        dst: merged.length,
      }),
    };
  }

  function trendRows() {
    const raw = (currentReport?.series ?? [])
      .map((bucket) => {
        const usage = bucket.usage ?? {};
        return {
          start: bucket.start,
          fresh: number(usage.input_tokens),
          read: number(usage.cache_read_input_tokens),
          write: number(usage.cache_creation_input_tokens),
          output: number(usage.output_tokens),
        };
      })
      .filter((row) => row.fresh + row.read + row.write + row.output > 0);
    const merged = mergeBuckets(raw, MAX_TREND_BUCKETS);
    return { rows: merged.rows, note: merged.note };
  }

  const agentPalette = ['#2f6f62', '#4e8fc7', '#8a6fc8', '#d9a441', '#c4703f', '#b3577f', '#7fb069', '#9aa8a0'];

  function stackedTrendSvg(rows, seriesKeys, colorFor) {
    const el = document.querySelector('#token-trend');
    const legend = document.querySelector('#token-trend-legend');
    if (!el) {
      return;
    }
    const legendItems = seriesKeys
      .map(([, , label]) => `<span><i class="dot"></i>${window.escapeHTML(label)}</span>`)
      .join('');
    if (!rows.length) {
      legend.innerHTML = legendItems;
      el.innerHTML = `<p class="muted section-pad">${window.escapeHTML(t('No token throughput captured yet.'))}</p>`;
      return;
    }
    const width = 760;
    const height = 240;
    const padLeft = 46;
    const padBottom = 26;
    const padTop = 10;
    const share = trendScale === 'share';
    const max = share ? 100 : Math.max(...rows.map((row) => row.total), 1);
    const slot = (width - padLeft - 8) / rows.length;
    const barWidth = Math.max(2, Math.min(34, slot * 0.62));
    const scale = (value) => ((height - padBottom - padTop) * value) / max;
    let bars = '';
    rows.forEach((row, index) => {
      const x = padLeft + index * slot + (slot - barWidth) / 2;
      let cursor = height - padBottom;
      for (const [key] of seriesKeys) {
        const sized = scale(share && row.total ? (row[key] / row.total) * 100 : row[key]);
        if (sized <= 0) {
          continue;
        }
        cursor -= sized;
        bars += `<rect class="trend-bar" x="${x.toFixed(1)}" y="${cursor.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${sized.toFixed(1)}" fill="${colorFor(key)}"><title>${window.escapeHTML(row.label)} · ${window.escapeHTML(row.titles[key])}</title></rect>`;
      }
    });
    let grid = '';
    for (let i = 0; i <= 3; i += 1) {
      const value = (max * (3 - i)) / 3;
      const y = height - padBottom - scale(value);
      const axisLabel = share ? `${Math.round(value)}%` : window.formatCompactTokens(value);
      grid += `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - 4}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/><text x="${padLeft - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)">${window.escapeHTML(axisLabel)}</text>`;
    }
    const labelEvery = Math.ceil(rows.length / 7);
    let labels = '';
    rows.forEach((row, index) => {
      if (index % labelEvery !== 0 && index !== rows.length - 1) {
        return;
      }
      const x = padLeft + index * slot + slot / 2;
      labels += `<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="9" fill="var(--muted)">${window.escapeHTML(row.label)}</text>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${window.escapeHTML(t('Token trend'))}">${grid}${bars}${labels}</svg>`;
    legend.innerHTML = legendItems;
    // Legend swatches share the bar palette through the CSSOM (single source of truth),
    // so a stale cached stylesheet can never desynchronize legend from bars.
    const legendDots = legend.querySelectorAll('i.dot');
    seriesKeys.forEach(([, color], index) => {
      if (legendDots[index]) {
        legendDots[index].style.background = color;
      }
    });
  }

  function agentTrendRows() {
    const buckets = new Map();
    const totals = new Map();
    for (const row of currentReport?.by_agent_time ?? []) {
      const separator = row.key.lastIndexOf(' / ');
      if (separator < 0) {
        continue;
      }
      const harness = row.key.slice(0, separator);
      const start = row.key.slice(separator + 3);
      const usage = row.usage ?? {};
      const value =
        number(usage.input_tokens) +
        number(usage.cache_read_input_tokens) +
        number(usage.cache_creation_input_tokens) +
        number(usage.output_tokens);
      if (!buckets.has(start)) {
        buckets.set(start, {});
      }
      const bucket = buckets.get(start);
      bucket[harness] = (bucket[harness] ?? 0) + value;
      totals.set(harness, (totals.get(harness) ?? 0) + value);
    }
    const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const shown = ordered.slice(0, 7);
    const rest = ordered.slice(7);
    const keys = [...shown, ...(rest.length ? ['__other__'] : [])];
    const starts = [...buckets.keys()].sort();
    const colorOf = (key) =>
      key === '__other__' ? '#9aa8a0' : agentPalette[shown.indexOf(key) % agentPalette.length];
    const nameOf = (key) => (key === '__other__' ? t('Other sources') : window.harnessLabel(key));
    const raw = starts.map((start) => {
      const bucket = buckets.get(start) ?? {};
      const row = { start };
      for (const key of keys) {
        row[key] =
          key === '__other__'
            ? rest.reduce((sum, name) => sum + (bucket[name] ?? 0), 0)
            : bucket[key] ?? 0;
      }
      return row;
    });
    const merged = mergeBuckets(raw, MAX_TREND_BUCKETS);
    const rows = merged.rows.map((row) => {
      const display = {
        label: new Date(row.start).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
        total: 0,
        titles: {},
      };
      for (const key of keys) {
        display[key] = row[key] ?? 0;
        display.total += display[key];
        display.titles[key] = `${nameOf(key)} ${window.formatExactTokens(display[key])}`;
      }
      return display;
    });
    const seriesKeys = keys.map((key) => [key, colorOf(key), nameOf(key)]);
    return { rows, seriesKeys, colorOf, note: merged.note };
  }

  function renderTrend() {
    const el = document.querySelector('#token-trend');
    if (!el || !currentReport) {
      return;
    }
    document.querySelector('#trend-exclude-wrap').hidden = trendMode !== 'component';
    if (trendMode === 'agent') {
      const agent = agentTrendRows();
      stackedTrendSvg(agent.rows, agent.seriesKeys, agent.colorOf);
      setTrendNote(agent.note);
      return;
    }
    const { rows, note: mergedNote } = trendRows();
    const componentRows = rows.map((row) => ({
      label: new Date(row.start).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      fresh: row.fresh,
      read: row.read,
      write: row.write,
      output: row.output,
      total: row.fresh + row.read + row.write + row.output,
      titles: {
        fresh: `${t('Fresh input')} ${window.formatExactTokens(row.fresh)}`,
        read: `${t('Cache read')} ${window.formatExactTokens(row.read)}`,
        write: `${t('Cache write')} ${window.formatExactTokens(row.write)}`,
        output: `${t('Output')} ${window.formatExactTokens(row.output)}`,
      },
    }));
    const series = [
      ['fresh', palette.fresh, t('Fresh input')],
      ...(trendExcludeRead
        ? []
        : [['read', palette.read, t('Cache read')]]),
      ['write', palette.write, t('Cache write')],
      ['output', palette.output, t('Output')],
    ];
    for (const row of componentRows) {
      if (trendExcludeRead) {
        row.total -= row.read;
      }
      row.titles.read = `${t('Cache read')} ${window.formatExactTokens(row.read)}`;
    }
    stackedTrendSvg(componentRows, series, (key) => palette[key]);
    setTrendNote(
      [
        trendExcludeRead
          ? t('This view excludes cache read; hover a segment for exact values.')
          : trendScale === 'share'
            ? t('Each bar is normalized to 100% of its bucket.')
            : '',
        mergedNote,
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }

  function setTrendNote(text) {
    const note = document.querySelector('#trend-view-note');
    if (note) {
      note.textContent = text;
      note.hidden = !text;
    }
  }

  /* ---- Agent ranking ---- */

  function agentRowState(name, usage, activity, coverageStatus) {
    if (usage) {
      const unpriced = number(usage.unpriced_events);
      if (name === 'autoclaw') {
        return { kind: 'warn', label: t('Run totals, not stackable') };
      }
      if (unpriced > 0) {
        return { kind: 'warn', label: t('Partially priced') };
      }
      return { kind: 'ok', label: t('Normal') };
    }
    if (name === 'grok_bot') {
      return { kind: 'warn', label: t('Not connected; import available') };
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

  function renderRank() {
    const el = document.querySelector('#token-rank');
    if (!el || !currentReport) {
      return;
    }
    const grandTotal = (currentReport.by_harness ?? []).reduce(
      (sum, row) => sum + window.BeaconAgentView.total(row.usage ?? {}),
      0,
    );
    const rows = (window.BeaconAgentView.agentNames(currentReport, coverageData ?? { runtimes: [] }, currentStatus) ?? [])
      .map((name) => ({
        name,
        usage: currentReport.by_harness?.find((row) => row.key === name)?.usage,
        activity: currentReport.native?.activity?.find((row) => row.harness === name),
        coverageStatus: coverageData?.runtimes?.find((row) => row.harness === name)?.status,
      }))
      .map((row) => ({ ...row, total: row.usage ? window.BeaconAgentView.total(row.usage) : null }))
      .sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || window.harnessLabel(a.name).localeCompare(window.harnessLabel(b.name)));
    const scope = document.querySelector('#token-rank-scope');
    if (scope) {
      scope.textContent = `${rows.length} ${t('sources')}`;
    }
    if (!rows.length) {
      el.innerHTML = `<p class="muted">${window.escapeHTML(t('No runtime evidence in this range'))}</p>`;
      return;
    }
    el.innerHTML = `<table class="rank-table"><thead><tr><th>${window.escapeHTML(t('Agent'))}</th><th>${window.escapeHTML(t('Captured tokens'))}</th><th>${window.escapeHTML(t('Share'))}</th><th>${window.escapeHTML(t('Status'))}</th></tr></thead><tbody>${rows
      .map((row) => {
        const state = agentRowState(row.name, row.usage, row.activity, row.coverageStatus);
        const share = row.total !== null && grandTotal ? (row.total / grandTotal) * 100 : null;
        const tokenCell =
          row.total !== null
            ? `<strong title="${window.escapeHTML(window.formatExactTokens(row.total))}">${window.escapeHTML(window.formatTokens(row.total))}</strong>`
            : `<span class="muted">${window.escapeHTML(t('Unknown'))}${row.activity ? ` · ${window.escapeHTML(t('activity only'))}` : ''}</span>`;
        const shareCell =
          share === null
            ? '<span class="muted">—</span>'
            : `<span class="share-bar"><span class="share-track"><span class="share-fill"></span></span><em>${share.toFixed(1)}%</em></span>`;
        const detail =
          row.name === 'doubao_work' && row.activity
            ? `<div class="limit-note">${window.escapeHTML(t('{count} activity records; not ranked by tokens', { count: row.activity.messages ?? row.activity.sessions ?? 0 }))}</div>`
            : '';
        return `<tr><td><button type="button" class="rank-agent" data-harness="${window.escapeHTML(row.name)}">${window.escapeHTML(window.harnessLabel(row.name))}</button>${detail}</td><td>${tokenCell}</td><td>${shareCell}</td><td><span class="state-pill ${state.kind}">${window.escapeHTML(state.label)}</span></td></tr>`;
      })
      .join('')}</tbody></table>`;
    // CSP forbids style attributes in markup; dynamic widths go through the CSSOM instead.
    const tableRows = el.querySelectorAll('tbody tr');
    rows.forEach((row, index) => {
      const fill = tableRows[index]?.querySelector('.share-fill');
      if (fill && row.total !== null && grandTotal) {
        fill.style.width = `${Math.max(1, (row.total / grandTotal) * 100).toFixed(1)}%`;
      }
    });
    for (const button of el.querySelectorAll('.rank-agent')) {
      button.addEventListener('click', () => {
        const params = new URLSearchParams(window.location.search);
        params.set('harness', button.dataset.harness);
        params.delete('session');
        window.location.search = params.toString();
      });
    }
  }

  /* ---- Model donut & project bars ---- */

  function renderDonut() {
    const el = document.querySelector('#token-models-donut');
    if (!el || !currentReport) {
      return;
    }
    const values = metrics(currentReport.totals ?? {});
    const rows = (currentReport.by_model ?? [])
      .map((row) => ({ key: row.key, total: window.BeaconAgentView.total(row.usage ?? {}) }))
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total);
    if (!values.total) {
      el.innerHTML = `<p class="muted">${window.escapeHTML(t('No model token attribution for this range.'))}</p>`;
      return;
    }
    const top = rows.slice(0, 3);
    const restTotal = rows.slice(3).reduce((sum, row) => sum + row.total, 0);
    const segments = [
      ...top.map((row, index) => ({
        label: row.key,
        value: row.total,
        color: donutPalette[index % donutPalette.length],
      })),
      ...(restTotal > 0
        ? [
            {
              label: t('{count} more models', { count: rows.length - top.length }),
              value: restTotal,
              color: '#9aa8a0',
            },
          ]
        : []),
    ];
    let cursor = 0;
    const stops = segments
      .map((segment) => {
        const start = cursor;
        cursor += (segment.value / values.total) * 100;
        return `${segment.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
      })
      .join(', ');
    const legend = segments
      .map(
        (segment, index) =>
          `<div><i class="dot ${index < 3 ? `dot-c${index + 1}` : 'dot-other'}"></i><span>${window.escapeHTML(segment.label)}</span><em>${Math.round((segment.value / values.total) * 100)}%</em></div>`,
      )
      .join('');
    // The conic gradient and legend swatches go through the CSSOM: CSP forbids style attributes.
    el.replaceChildren();
    const donut = document.createElement('div');
    donut.className = 'token-donut';
    donut.style.background = `conic-gradient(${stops})`;
    const center = document.createElement('div');
    const total = document.createElement('strong');
    total.textContent = window.formatCompactTokens(values.total);
    const caption = document.createElement('span');
    caption.textContent = t('total tokens');
    center.append(total, caption);
    donut.append(center);
    const legendBox = document.createElement('div');
    legendBox.className = 'donut-legend';
    legendBox.innerHTML = legend;
    el.append(donut, legendBox);
    const gap = document.querySelector('#token-model-gap');
    const unpriced = currentReport.pricing?.unpriced?.length ?? 0;
    if (gap) {
      gap.hidden = unpriced === 0;
      gap.textContent = t('{count} unpriced', { count: unpriced });
    }
  }

  function renderProjects() {
    const el = document.querySelector('#token-projects');
    if (!el || !currentReport) {
      return;
    }
    let rows;
    if (projectMode === 'sessions') {
      const counts = new Map();
      let unattributed = 0;
      for (const session of currentSessions?.sessions ?? []) {
        if (!(currentReport.by_session ?? []).some((group) => group.key === session.id)) {
          continue;
        }
        if (session.repository) {
          counts.set(session.repository, (counts.get(session.repository) ?? 0) + 1);
        } else {
          unattributed += 1;
        }
      }
      rows = [...counts.entries()]
        .map(([key, value]) => ({ key, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 5);
      if (unattributed > 0) {
        rows.push({ key: t('Unattributed projects'), value: unattributed, muted: true });
      }
    } else {
      rows = (currentReport.by_repository ?? [])
        .map((row) => ({ key: row.key, value: window.BeaconAgentView.total(row.usage ?? {}) }))
        .filter((row) => row.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 5);
    }
    if (!rows.length) {
      el.innerHTML = `<p class="muted">${window.escapeHTML(t('No usage evidence for this dimension'))}</p>`;
      return;
    }
    const max = Math.max(...rows.map((row) => row.value), 1);
    el.innerHTML = rows
      .map((row) => {
        const label =
          projectMode === 'sessions'
            ? `${row.value} ${t('sessions')}`
            : window.formatTokens(row.value);
        return `<div class="project-bar-row${row.muted ? ' unattributed' : ''}"><span title="${window.escapeHTML(String(row.value))}">${window.escapeHTML(row.key)}</span><span class="pb-track"><span class="pb-fill"></span></span><em>${window.escapeHTML(label)}</em></div>`;
      })
      .join('');
    // Dynamic bar widths must go through the CSSOM (CSP forbids style attributes).
    const barRows = el.querySelectorAll('.project-bar-row');
    rows.forEach((row, index) => {
      const fill = barRows[index]?.querySelector('.pb-fill');
      if (fill) {
        fill.style.width = `${Math.max(2, (row.value / max) * 100).toFixed(1)}%`;
      }
    });
  }


  /* ---- Model usage bars (per-model stacked components) ---- */

  function renderModelBars() {
    const el = document.querySelector('#token-model-bars');
    if (!el || !currentReport) {
      return;
    }
    const rows = (currentReport.by_model ?? [])
      .map((row) => ({
        key: row.key,
        fresh: number(row.usage?.input_tokens),
        read: number(row.usage?.cache_read_input_tokens),
        write: number(row.usage?.cache_creation_input_tokens),
        output: number(row.usage?.output_tokens),
      }))
      .map((row) => ({ ...row, total: row.fresh + row.read + row.write + row.output }))
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
    if (!rows.length) {
      el.innerHTML = `<p class="muted">${window.escapeHTML(t('No model token attribution for this range.'))}</p>`;
      return;
    }
    const max = Math.max(...rows.map((row) => row.total), 1);
    el.innerHTML = rows
      .map(
        (row) =>
          `<div class="model-bar-row"><span title="${window.escapeHTML(row.key)}">${window.escapeHTML(row.key)}</span><span class="mb-track"><span class="mb-seg mb-fresh" title="${window.escapeHTML(t('Fresh input'))} ${window.formatExactTokens(row.fresh)}"></span><span class="mb-seg mb-read" title="${window.escapeHTML(t('Cache read'))} ${window.formatExactTokens(row.read)}"></span><span class="mb-seg mb-write" title="${window.escapeHTML(t('Cache write'))} ${window.formatExactTokens(row.write)}"></span><span class="mb-seg mb-output" title="${window.escapeHTML(t('Output'))} ${window.formatExactTokens(row.output)}"></span></span><em title="${window.escapeHTML(window.formatExactTokens(row.total))}">${window.escapeHTML(window.formatCompactTokens(row.total))}</em></div>`,
      )
      .join('');
    // Segment widths go through the CSSOM: the CSP forbids style attributes in markup.
    const barRows = el.querySelectorAll('.model-bar-row');
    rows.forEach((row, index) => {
      const track = barRows[index]?.querySelector('.mb-track');
      if (!track) {
        return;
      }
      for (const [className, value] of [
        ['.mb-fresh', row.fresh],
        ['.mb-read', row.read],
        ['.mb-write', row.write],
        ['.mb-output', row.output],
      ]) {
        const segment = track.querySelector(className);
        if (segment) {
          segment.style.width = `${((value / max) * 100).toFixed(2)}%`;
        }
      }
    });
  }

  function renderMethod() {
    const el = document.querySelector('#token-method-details');
    if (!el || !currentReport) {
      return;
    }
    const items = [
      t('Total = fresh input + cache read + cache write + output. Reasoning is included in output; do not add it again.'),
      t('Cache read share is a token proportion, not a request hit rate. Averages use usage events, not necessarily API calls.'),
      t('Estimates are list prices, not invoices; unknown costs remain unknown.'),
      t('Coverage uses the time and Agent filters only; it does not prove billing completeness.'),
      t('Inventory detection is separate from observed activity and may not detect native snapshots.'),
      currentReport.native?.warnings?.length
        ? `${t('Native source warnings')}: ${currentReport.native.warnings.join(' · ')}`
        : '',
    ].filter(Boolean);
    el.innerHTML = `<ul>${items.map((item) => `<li>${window.escapeHTML(item)}</li>`).join('')}</ul>`;
  }

  /* ---- Status pill ---- */

  function renderStatusPill() {
    const pill = document.querySelector('#shell-status');
    if (!pill) {
      return;
    }
    const collector = currentStatus?.collector;
    const healthy = collector?.health_ready === true;
    pill.className = `status-pill ${healthy ? '' : 'is-warn'}`;
    pill.textContent = healthy ? t('Collection normal') : t('Health not confirmed');
  }

  /* ---- Public update hooks ---- */

  function buildSnapshot(report, filters, sessions) {
    return {
      captured_at: new Date().toISOString(),
      report,
      filters: Object.fromEntries(filters ?? []),
      sessions: (sessions?.sessions ?? [])
        .filter((row) => (report.by_session ?? []).some((group) => group.key === row.id))
        .map((row) => ({
          id: row.id,
          harness: row.harness,
          repository: row.repository,
          first_event_at: row.first_event_at,
          last_event_at: row.last_event_at,
        })),
      metadata_truncated: sessions?.truncated ?? false,
    };
  }

  function update(report, status, filters, sessions, metadataError) {
    currentReport = report;
    currentStatus = status ?? {};
    currentSessions = sessions;
    snapshot = buildSnapshot(report, filters, sessions);
    renderStatusPill();
    renderKpis();
    renderTrend();
    renderRank();
    renderDonut();
    renderModelBars();
    renderProjects();
    renderMethod();
    if (metadataError) {
      const pill = document.querySelector('#shell-status');
      if (pill) {
        pill.textContent += ` · ${t('Session metadata unavailable')}: ${metadataError}`;
      }
    } else if (sessions?.truncated) {
      const pill = document.querySelector('#shell-status');
      if (pill) {
        pill.textContent += ` · ${t('Session metadata truncated')}`;
      }
    }
  }

  function coverage(value) {
    coverageData = value;
    renderKpis();
    renderRank();
  }

  function stale() {
    const pill = document.querySelector('#shell-status');
    if (pill) {
      pill.className = 'status-pill is-danger';
      pill.textContent = t('Connection failed; Collector health is unknown');
    }
  }

  window.BeaconTokenInsights = Object.freeze({
    setupViews,
    update,
    coverage,
    stale,
    metrics,
    csvCell,
    exportCSV,
    exportJSON,
    buildSnapshot,
    showView,
  });
})();
