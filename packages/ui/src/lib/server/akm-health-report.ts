import type { ControlPlaneState } from '@openpalm/lib';
import { runAssistantAkmCommand } from '@openpalm/lib';
import { safeParseJsonObject } from './akm.js';

export const AKM_HEALTH_REPORT_WINDOWS = ['24h', '72h', '7d', '14d', '30d'] as const;

export type AkmHealthReportWindow = (typeof AKM_HEALTH_REPORT_WINDOWS)[number];

type Json = Record<string, unknown>;

type ProposalEntry = {
  id: string;
  ref: string;
  source: string;
  createdAt: string;
};

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function clampWindow(value: string | null): AkmHealthReportWindow {
  return (AKM_HEALTH_REPORT_WINDOWS as readonly string[]).includes(value ?? '')
    ? (value as AkmHealthReportWindow)
    : '72h';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function fmtInt(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function fmtPercent(value: number): string {
  return `${(value * 100).toFixed(value === 0 || value >= 0.1 ? 0 : 1)}%`;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

function fmtUtc(value: string): string {
  if (!value) return 'n/a';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'n/a';
  return d.toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }) + ' UTC';
}

function metricDelta(current: number, prior: number): string {
  if (prior === current) return 'flat vs prior window';
  if (prior === 0) return current > 0 ? 'new vs prior window' : 'flat vs prior window';
  const pct = ((current - prior) / Math.abs(prior)) * 100;
  const trend = pct > 0 ? 'up' : 'down';
  return `${trend} ${Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}% vs prior window`;
}

function statusClass(status: string): string {
  if (status === 'ok' || status === 'pass') return 'ok';
  if (status === 'warn') return 'warn';
  return 'fail';
}

function buildCards(current: Json, prior: Json, proposalCount: number): string {
  const invoked = asNumber(current.invoked);
  const completed = asNumber(current.completed);
  const completionRate = invoked > 0 ? completed / invoked : 0;
  const failRate = asNumber(asRecord(current.actions)?.error) > 0 && invoked > 0
    ? asNumber(asRecord(current.actions)?.error) / invoked
    : 0;
  const promoted = asNumber(asRecord(current.consolidation)?.promoted);
  const written = asNumber(asRecord(current.memoryInference)?.written);
  const entities = asNumber(asRecord(current.graphExtraction)?.entities);
  const medianMs = asNumber(asRecord(current.wallTime)?.medianMs);

  const priorInvoked = asNumber(prior.invoked);
  const priorCompleted = asNumber(prior.completed);
  const priorCompletionRate = priorInvoked > 0 ? priorCompleted / priorInvoked : 0;
  const priorFailRate = asNumber(asRecord(prior.actions)?.error) > 0 && priorInvoked > 0
    ? asNumber(asRecord(prior.actions)?.error) / priorInvoked
    : 0;

  const cards = [
    { label: 'Completion rate', value: fmtPercent(completionRate), sub: metricDelta(completionRate, priorCompletionRate) },
    { label: 'Fail rate', value: fmtPercent(failRate), sub: metricDelta(failRate, priorFailRate) },
    { label: 'Promoted', value: fmtInt(promoted), sub: metricDelta(promoted, asNumber(asRecord(prior.consolidation)?.promoted)) },
    { label: 'MI written', value: fmtInt(written), sub: metricDelta(written, asNumber(asRecord(prior.memoryInference)?.written)) },
    { label: 'Graph entities', value: fmtInt(entities), sub: metricDelta(entities, asNumber(asRecord(prior.graphExtraction)?.entities)) },
    { label: 'Median duration', value: fmtDuration(medianMs), sub: metricDelta(medianMs, asNumber(asRecord(prior.wallTime)?.medianMs)) },
    { label: 'Runs', value: fmtInt(completed), sub: metricDelta(completed, priorCompleted) },
    { label: 'Pending proposals', value: fmtInt(proposalCount), sub: proposalCount > 0 ? 'review queue has pending items' : 'no pending proposals' },
  ];

  return cards.map((card) => `
    <div class="card">
      <div class="card-label">${escapeHtml(card.label)}</div>
      <div class="card-value">${escapeHtml(card.value)}</div>
      <div class="card-sub">${escapeHtml(card.sub)}</div>
    </div>`).join('');
}

function buildAdvisories(health: Json): string {
  const items = [
    ...asArray(health.advisories),
    ...asArray(health.hardChecks).filter((item) => {
      const record = asRecord(item);
      const status = asString(record?.status);
      return status === 'warn' || status === 'fail';
    }),
  ]
    .map((item) => asRecord(item))
    .filter((item): item is Json => item !== null);

  if (items.length === 0) {
    return '<div class="notice ok">No active advisories for this window.</div>';
  }

  return items.map((item) => {
    const status = statusClass(asString(item.status));
    const name = asString(item.name) || 'advisory';
    const message = asString(item.message) || 'No details.';
    return `<div class="notice ${status}"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(message)}</span></div>`;
  }).join('');
}

function buildProposalRows(proposals: ProposalEntry[]): string {
  if (proposals.length === 0) {
    return '<tr><td colspan="4" class="empty">No pending proposals.</td></tr>';
  }
  return proposals.slice(0, 20).map((proposal) => `
    <tr>
      <td>${escapeHtml(proposal.ref || proposal.id || 'unknown')}</td>
      <td>${escapeHtml(proposal.source || 'unknown')}</td>
      <td>${escapeHtml(fmtUtc(proposal.createdAt))}</td>
      <td>${escapeHtml(proposal.id || '')}</td>
    </tr>`).join('');
}

function buildRunRows(runs: Json[]): string {
  if (runs.length === 0) {
    return '<tr><td colspan="6" class="empty">No improve runs in this window.</td></tr>';
  }
  return runs.slice(-10).reverse().map((run, index) => {
    const consolidation = asRecord(run.consolidation);
    const memoryInference = asRecord(run.memoryInference);
    const graphExtraction = asRecord(run.graphExtraction);
    const startedAt = asString(run.startedAt);
    const durationMs = asNumber(run.wallTimeMs) || asNumber(run.durationMs);
    return `
      <tr>
        <td>${escapeHtml(asString(run.runId) || asString(run.id) || `run-${index + 1}`)}</td>
        <td>${escapeHtml(fmtUtc(startedAt))}</td>
        <td>${escapeHtml(fmtDuration(durationMs))}</td>
        <td>${escapeHtml(String(asBoolean(run.ok) ? 'ok' : 'fail'))}</td>
        <td>${escapeHtml(fmtInt(asNumber(consolidation?.promoted)))}</td>
        <td>${escapeHtml(fmtInt(asNumber(memoryInference?.written)))}</td>
        <td>${escapeHtml(fmtInt(asNumber(graphExtraction?.entities)))}</td>
      </tr>`;
  }).join('');
}

function buildSummaryRows(current: Json): string {
  const rows = [
    ['Invoked', fmtInt(asNumber(current.invoked))],
    ['Completed', fmtInt(asNumber(current.completed))],
    ['Skipped', fmtInt(asNumber(current.skipped))],
    ['Promoted', fmtInt(asNumber(asRecord(current.consolidation)?.promoted))],
    ['Merged', fmtInt(asNumber(asRecord(current.consolidation)?.merged))],
    ['Deleted', fmtInt(asNumber(asRecord(current.consolidation)?.deleted))],
    ['Judged no action', fmtInt(asNumber(asRecord(current.consolidation)?.judgedNoAction))],
    ['Inference written', fmtInt(asNumber(asRecord(current.memoryInference)?.written))],
    ['Graph entities', fmtInt(asNumber(asRecord(current.graphExtraction)?.entities))],
    ['Median wall time', fmtDuration(asNumber(asRecord(current.wallTime)?.medianMs))],
  ];
  return rows.map(([label, value]) => `
    <tr>
      <th>${escapeHtml(label)}</th>
      <td>${escapeHtml(value)}</td>
    </tr>`).join('');
}

function renderHtml(window: AkmHealthReportWindow, health: Json, proposals: ProposalEntry[]): string {
  const improve = asRecord(health.improve) ?? {};
  const windows = asArray(health.windows).map((item) => asRecord(item)).filter((item): item is Json => item !== null);
  const currentWindow = asRecord(windows.find((item) => asString(item.name) === 'current')?.improve) ?? improve;
  const priorWindow = asRecord(windows.find((item) => asString(item.name) === 'prior')?.improve) ?? {};
  const runs = asArray(health.runs).map((item) => asRecord(item)).filter((item): item is Json => item !== null);
  const status = asString(health.status) || 'unknown';
  const since = asString(health.since);
  const currentWindowMeta = windows.find((item) => asString(item.name) === 'current') ?? {};
  const until = asString(currentWindowMeta.until);
  const semanticAdvisory = asArray(health.advisories)
    .map((item) => asRecord(item))
    .find((item) => asString(item?.name) === 'semantic-search-runtime');
  const semanticStatus = asString(asRecord(semanticAdvisory?.evidence)?.status) || 'unknown';
  const payload = runs.map((run, index) => {
    const consolidation = asRecord(run.consolidation);
    const memoryInference = asRecord(run.memoryInference);
    const graphExtraction = asRecord(run.graphExtraction);
    return {
      label: asString(run.startedAt) ? fmtUtc(asString(run.startedAt)).replace(' UTC', '') : `Run ${index + 1}`,
      wallTimeMs: asNumber(run.wallTimeMs) || asNumber(run.durationMs),
      promoted: asNumber(consolidation?.promoted),
      merged: asNumber(consolidation?.merged),
      deleted: asNumber(consolidation?.deleted),
      judgedNoAction: asNumber(consolidation?.judgedNoAction),
      written: asNumber(memoryInference?.written),
      entities: asNumber(graphExtraction?.entities),
      consolidationMs: asNumber(consolidation?.durationMs),
      memoryInferenceMs: asNumber(memoryInference?.durationMs),
      graphExtractionMs: asNumber(graphExtraction?.durationMs),
      ok: asBoolean(run.ok),
    };
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AKM Health Report (${escapeHtml(window)})</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: #101b2d;
      --panel-soft: #15233a;
      --border: rgba(148, 163, 184, 0.18);
      --text: #e5eefc;
      --muted: #93a4bf;
      --ok: #22c55e;
      --warn: #f59e0b;
      --fail: #ef4444;
      --accent: #60a5fa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      background: radial-gradient(circle at top, #14233d 0%, var(--bg) 55%);
      color: var(--text);
      padding: 24px;
    }
    .shell {
      max-width: 1400px;
      margin: 0 auto;
      display: grid;
      gap: 20px;
    }
    .hero, .panel {
      background: rgba(16, 27, 45, 0.9);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.28);
    }
    .hero {
      padding: 24px;
      display: grid;
      gap: 16px;
    }
    .hero-top {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      flex-wrap: wrap;
    }
    h1, h2, h3, p { margin: 0; }
    .eyebrow { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .title { font-size: clamp(28px, 4vw, 40px); font-weight: 700; }
    .subtitle { color: var(--muted); max-width: 80ch; }
    .status {
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border: 1px solid transparent;
    }
    .status.ok { color: #bbf7d0; background: rgba(34, 197, 94, 0.14); border-color: rgba(34, 197, 94, 0.32); }
    .status.warn { color: #fde68a; background: rgba(245, 158, 11, 0.14); border-color: rgba(245, 158, 11, 0.32); }
    .status.fail { color: #fecaca; background: rgba(239, 68, 68, 0.14); border-color: rgba(239, 68, 68, 0.32); }
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .meta-item, .card {
      background: var(--panel-soft);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
    }
    .meta-label, .card-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
    .meta-value, .card-value { margin-top: 8px; font-size: 22px; font-weight: 700; }
    .card-sub { margin-top: 8px; color: var(--muted); font-size: 13px; }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .grid-two {
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
      gap: 20px;
    }
    .panel { padding: 18px; }
    .panel-title { font-size: 18px; font-weight: 700; margin-bottom: 14px; }
    .chart-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
    }
    .chart {
      height: 320px;
      background: linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0));
      border: 1px solid var(--border);
      border-radius: 14px;
    }
    .notice-list {
      display: grid;
      gap: 10px;
    }
    .notice {
      display: grid;
      gap: 6px;
      border-radius: 14px;
      padding: 14px;
      border: 1px solid var(--border);
      background: var(--panel-soft);
    }
    .notice.ok { border-color: rgba(34, 197, 94, 0.32); }
    .notice.warn { border-color: rgba(245, 158, 11, 0.32); }
    .notice.fail { border-color: rgba(239, 68, 68, 0.32); }
    .summary-table, .data-table {
      width: 100%;
      border-collapse: collapse;
    }
    .summary-table th, .summary-table td, .data-table th, .data-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }
    .summary-table th, .data-table th { color: var(--muted); font-weight: 600; }
    .empty { color: var(--muted); text-align: center; }
    .footer-note { color: var(--muted); font-size: 13px; }
    @media (max-width: 900px) {
      body { padding: 12px; }
      .grid-two { grid-template-columns: 1fr; }
    }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --bg: #f9fafb;
        --panel: #ffffff;
        --panel-soft: #f3f4f6;
        --border: rgba(0, 0, 0, 0.1);
        --text: #111827;
        --muted: #6b7280;
        --ok: #16a34a;
        --warn: #d97706;
        --fail: #dc2626;
        --accent: #2563eb;
      }
      body {
        background: radial-gradient(circle at top, #e9f0ff 0%, var(--bg) 55%);
        color: var(--text);
      }
      .hero, .panel {
        background: rgba(255, 255, 255, 0.95);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
      }
      .status.ok { color: #15803d; background: rgba(22, 163, 74, 0.1); border-color: rgba(22, 163, 74, 0.3); }
      .status.warn { color: #b45309; background: rgba(217, 119, 6, 0.1); border-color: rgba(217, 119, 6, 0.3); }
      .status.fail { color: #b91c1c; background: rgba(220, 38, 38, 0.1); border-color: rgba(220, 38, 38, 0.3); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="hero-top">
        <div>
          <div class="eyebrow">AKM Health Report</div>
          <h1 class="title">Knowledge Health for ${escapeHtml(window)}</h1>
          <p class="subtitle">Generated from live <code>akm health</code> data inside the running assistant container. This mirrors the existing AKM report shape with KPI cards, ECharts trends, advisories, and queue visibility.</p>
        </div>
        <div class="status ${escapeHtml(statusClass(status))}">${escapeHtml(status)}</div>
      </div>
      <div class="meta">
        <div class="meta-item">
          <div class="meta-label">Window</div>
          <div class="meta-value">${escapeHtml(window)}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Since</div>
          <div class="meta-value">${escapeHtml(fmtUtc(since))}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Until</div>
          <div class="meta-value">${escapeHtml(fmtUtc(until))}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Semantic search</div>
          <div class="meta-value">${escapeHtml(semanticStatus)}</div>
        </div>
      </div>
      <div class="cards">${buildCards(currentWindow, priorWindow, proposals.length)}</div>
    </section>

    <section class="panel">
      <h2 class="panel-title">Run Trends</h2>
      <div class="chart-grid">
        <div id="chartWallTime" class="chart"></div>
        <div id="chartPhases" class="chart"></div>
        <div id="chartOutput" class="chart"></div>
        <div id="chartKnowledge" class="chart"></div>
      </div>
    </section>

    <section class="grid-two">
      <div class="panel">
        <h2 class="panel-title">Summary</h2>
        <table class="summary-table">
          <tbody>${buildSummaryRows(currentWindow)}</tbody>
        </table>
      </div>
      <div class="panel">
        <h2 class="panel-title">Advisories</h2>
        <div class="notice-list">${buildAdvisories(health)}</div>
      </div>
    </section>

    <section class="grid-two">
      <div class="panel">
        <h2 class="panel-title">Pending Proposals (${escapeHtml(fmtInt(proposals.length))})</h2>
        <table class="data-table">
          <thead>
            <tr><th>Ref</th><th>Source</th><th>Created</th><th>ID</th></tr>
          </thead>
          <tbody>${buildProposalRows(proposals)}</tbody>
        </table>
      </div>
      <div class="panel">
        <h2 class="panel-title">Recent Runs</h2>
        <table class="data-table">
          <thead>
            <tr><th>Run</th><th>Started</th><th>Duration</th><th>Status</th><th>Promoted</th><th>MI</th><th>Entities</th></tr>
          </thead>
          <tbody>${buildRunRows(runs)}</tbody>
        </table>
      </div>
    </section>

    <div class="footer-note">Charts use Apache ECharts from jsDelivr. If the browser blocks external assets, the summary tables above remain the source of truth.</div>
  </div>

  <script>window.REPORT_DATA = ${scriptJson(payload)};</script>
  <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
  <script>
    const runs = Array.isArray(window.REPORT_DATA) ? window.REPORT_DATA : [];
    const textColor = '#dbe7ff';
    const mutedColor = '#93a4bf';
    const axisStyle = { axisLabel: { color: mutedColor }, axisLine: { lineStyle: { color: '#334155' } }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } } };
    function baseChart(id) {
      const el = document.getElementById(id);
      if (!el || !window.echarts) return null;
      return window.echarts.init(el, null, { renderer: 'canvas' });
    }
    function setEmpty(elId, label) {
      const el = document.getElementById(elId);
      if (!el) return;
      el.innerHTML = '<div style="height:100%;display:grid;place-items:center;color:' + mutedColor + ';font-size:14px;">' + label + '</div>';
    }
    function labels() { return runs.map((run) => run.label); }
    if (!window.echarts) {
      ['chartWallTime', 'chartPhases', 'chartOutput', 'chartKnowledge'].forEach((id) => setEmpty(id, 'ECharts failed to load.'));
    } else if (runs.length === 0) {
      ['chartWallTime', 'chartPhases', 'chartOutput', 'chartKnowledge'].forEach((id) => setEmpty(id, 'No runs in this window.'));
    } else {
      const common = { textStyle: { color: textColor }, animation: false, grid: { left: 48, right: 18, top: 40, bottom: 36 }, tooltip: { trigger: 'axis' } };
      const wallTime = baseChart('chartWallTime');
      wallTime && wallTime.setOption({
        ...common,
        title: { text: 'Wall Time Per Run', textStyle: { color: textColor, fontSize: 14 } },
        xAxis: { type: 'category', data: labels(), ...axisStyle },
        yAxis: { type: 'value', axisLabel: { color: mutedColor, formatter: (value) => Math.round(value / 1000) + 's' }, splitLine: axisStyle.splitLine },
        series: [{ type: 'line', smooth: true, data: runs.map((run) => run.wallTimeMs), lineStyle: { color: '#60a5fa' }, itemStyle: { color: '#60a5fa' }, areaStyle: { color: 'rgba(96,165,250,0.14)' } }]
      });

      const phases = baseChart('chartPhases');
      phases && phases.setOption({
        ...common,
        title: { text: 'Phase Breakdown', textStyle: { color: textColor, fontSize: 14 } },
        legend: { textStyle: { color: mutedColor } },
        xAxis: { type: 'category', data: labels(), ...axisStyle },
        yAxis: { type: 'value', axisLabel: { color: mutedColor, formatter: (value) => Math.round(value / 1000) + 's' }, splitLine: axisStyle.splitLine },
        series: [
          { name: 'Consolidation', type: 'bar', stack: 'phases', data: runs.map((run) => run.consolidationMs), itemStyle: { color: '#60a5fa' } },
          { name: 'Memory Inference', type: 'bar', stack: 'phases', data: runs.map((run) => run.memoryInferenceMs), itemStyle: { color: '#a78bfa' } },
          { name: 'Graph Extraction', type: 'bar', stack: 'phases', data: runs.map((run) => run.graphExtractionMs), itemStyle: { color: '#34d399' } }
        ]
      });

      const output = baseChart('chartOutput');
      output && output.setOption({
        ...common,
        title: { text: 'Consolidation Output', textStyle: { color: textColor, fontSize: 14 } },
        legend: { textStyle: { color: mutedColor } },
        xAxis: { type: 'category', data: labels(), ...axisStyle },
        yAxis: { type: 'value', axisLabel: { color: mutedColor }, splitLine: axisStyle.splitLine },
        series: [
          { name: 'Promoted', type: 'bar', data: runs.map((run) => run.promoted), itemStyle: { color: '#22c55e' } },
          { name: 'Merged', type: 'bar', data: runs.map((run) => run.merged), itemStyle: { color: '#f59e0b' } },
          { name: 'Deleted', type: 'bar', data: runs.map((run) => run.deleted), itemStyle: { color: '#ef4444' } },
          { name: 'No action', type: 'bar', data: runs.map((run) => run.judgedNoAction), itemStyle: { color: '#94a3b8' } }
        ]
      });

      const knowledge = baseChart('chartKnowledge');
      knowledge && knowledge.setOption({
        ...common,
        title: { text: 'Knowledge Growth Signals', textStyle: { color: textColor, fontSize: 14 } },
        legend: { textStyle: { color: mutedColor } },
        xAxis: { type: 'category', data: labels(), ...axisStyle },
        yAxis: { type: 'value', axisLabel: { color: mutedColor }, splitLine: axisStyle.splitLine },
        series: [
          { name: 'MI written', type: 'line', smooth: true, data: runs.map((run) => run.written), itemStyle: { color: '#a78bfa' }, lineStyle: { color: '#a78bfa' } },
          { name: 'Entities', type: 'line', smooth: true, data: runs.map((run) => run.entities), itemStyle: { color: '#34d399' }, lineStyle: { color: '#34d399' } }
        ]
      });

      window.addEventListener('resize', () => {
        wallTime && wallTime.resize();
        phases && phases.resize();
        output && output.resize();
        knowledge && knowledge.resize();
      });
    }
  </script>
</body>
</html>`;
}

export async function buildAkmHealthReport(
  state: ControlPlaneState,
  requestedWindow: string | null,
): Promise<{ html: string; window: AkmHealthReportWindow }> {
  const window = clampWindow(requestedWindow);
  const [healthResult, proposalsResult] = await Promise.all([
    runAssistantAkmCommand(state, ['health', `--since=${window}`, '--group-by', 'run', `--window-compare=${window}`, '--format', 'json'], 20_000),
    runAssistantAkmCommand(state, ['proposal', 'list', '--format', 'json'], 12_000),
  ]);

  const health = safeParseJsonObject(healthResult.stdout);
  const proposalsPayload = safeParseJsonObject(proposalsResult.stdout);

  if (!health) {
    const detail = [healthResult.stderr.trim(), healthResult.stdout.trim()].filter(Boolean).join('\n\n');
    return {
      window,
      html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AKM Health Report</title><style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#07111f;color:#e5eefc;padding:24px}main{max-width:860px;margin:0 auto;background:#101b2d;border:1px solid rgba(148,163,184,.18);border-radius:18px;padding:24px}pre{white-space:pre-wrap;background:#15233a;padding:16px;border-radius:12px;overflow:auto}code{font-family:ui-monospace,SFMono-Regular,monospace}</style></head><body><main><h1>AKM health report unavailable</h1><p>The admin UI could not build the report from <code>akm health</code> for window <code>${escapeHtml(window)}</code>.</p><pre>${escapeHtml(detail || 'The AKM CLI returned no parseable JSON output.')}</pre></main></body></html>`,
    };
  }

  const proposals = asArray(proposalsPayload?.proposals)
    .map((item) => asRecord(item))
    .filter((item): item is Json => item !== null)
    .map((item) => ({
      id: asString(item.id),
      ref: asString(item.ref),
      source: asString(item.source),
      createdAt: asString(item.createdAt),
    }));

  return { html: renderHtml(window, health, proposals), window };
}
