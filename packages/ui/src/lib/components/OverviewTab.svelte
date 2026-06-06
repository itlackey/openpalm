<script lang="ts">
  import { onMount } from 'svelte';
  import type { HealthPayload, AutomationsResponse } from '$lib/types.js';
  import type { TabId } from './TabBar.svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { fetchAkmHealth, type AkmHealth } from '$lib/api.js';

  interface Props {
    adminHealth: HealthPayload | null;
    operationResult: string;
    operationResultType: 'success' | 'error' | 'info';
    tokenStored: boolean;
    healthLoading: boolean;
    applyLoading: boolean;
    anyDangerousLoading: boolean;
    automationsData: AutomationsResponse | null;
    mergedServices: Map<string, string>;
    onCheckHealth: () => void;
    onApplyChanges: () => void;
    onDismissResult: () => void;
    onNavigate: (tab: TabId) => void;
  }

  let {
    adminHealth,
    operationResult,
    operationResultType,
    tokenStored,
    healthLoading,
    applyLoading,
    anyDangerousLoading,
    automationsData,
    mergedServices,
    onCheckHealth,
    onApplyChanges,
    onDismissResult,
    onNavigate,
  }: Props = $props();

  // AKM (knowledge base) health — fetched here so the Overview is a real
  // dashboard. Fails soft to an "unavailable" card.
  let akm = $state<AkmHealth | null>(null);
  onMount(() => {
    void endpointsService.load();
    void fetchAkmHealth()
      .then((h) => { akm = h; })
      .catch(() => { akm = { available: false }; });
  });

  let akmBadge = $derived.by((): { label: string; cls: string } => {
    if (!akm || !akm.available) return { label: 'Unavailable', cls: 'badge-neutral' };
    // Prefer the reported status; if it's missing/unknown, derive from the
    // check counts so the badge never reads "Unknown" while metrics are present.
    let status = akm.status;
    if (status !== 'ok' && status !== 'warn' && status !== 'fail') {
      status = akm.checks.fail > 0 ? 'fail' : akm.checks.warn > 0 ? 'warn' : 'ok';
    }
    if (status === 'ok') return { label: 'Healthy', cls: 'badge-success' };
    if (status === 'warn') return { label: 'Warnings', cls: 'badge-warning' };
    return { label: 'Issues', cls: 'badge-danger' };
  });
  let akmCheckTotal = $derived(
    akm && akm.available ? akm.checks.pass + akm.checks.warn + akm.checks.fail : 0
  );

  let automationCount = $derived(automationsData?.automations.length ?? 0);
  let enabledAutomationCount = $derived(
    automationsData?.automations.filter((a) => a.enabled).length ?? 0
  );

  let containerCounts = $derived.by(() => {
    if (mergedServices.size === 0) return null;
    const total = mergedServices.size;
    const running = [...mergedServices.values()].filter((s) => s === 'running').length;
    return { total, running };
  });

  // Services that aren't running, by name — drives the actionable status line.
  let downServices = $derived.by(() => {
    const out: string[] = [];
    for (const [name, status] of mergedServices) {
      if (status !== 'running') out.push(name);
    }
    return out;
  });

  let health = $derived.by((): { status: 'ok' | 'warning' | 'unknown'; title: string; detail: string } => {
    if (!containerCounts) {
      return { status: 'unknown', title: 'Checking services…', detail: 'Fetching the latest status from Docker.' };
    }
    if (containerCounts.running === containerCounts.total && containerCounts.total > 0) {
      return {
        status: 'ok',
        title: 'All systems operational',
        detail: `${containerCounts.total} of ${containerCounts.total} services are running normally.`,
      };
    }
    const down = containerCounts.total - containerCounts.running;
    const names = downServices.map((n) => n.charAt(0).toUpperCase() + n.slice(1)).join(', ');
    return {
      status: 'warning',
      title: `${down} of ${containerCounts.total} services not running`,
      detail: names ? `Not running: ${names}.` : 'One or more services need attention.',
    };
  });
</script>

<!-- Status hero: the one thing an operator needs on landing — is it healthy,
     and if not, what's wrong and how do I fix it. -->
<section class="hero hero--{health.status}" role="status" aria-live="polite">
  <span class="hero-icon" aria-hidden="true">
    {#if health.status === 'warning'}
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    {:else if health.status === 'ok'}
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    {:else}
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    {/if}
  </span>
  <div class="hero-text">
    <h2 class="hero-title">{health.title}</h2>
    <p class="hero-detail">{health.detail}</p>
  </div>
  <div class="hero-actions">
    <button class="btn btn-secondary" onclick={onCheckHealth} disabled={healthLoading}>
      {healthLoading ? 'Checking…' : 'Re-check'}
    </button>
    {#if health.status === 'warning'}
      <button class="btn btn-primary" onclick={() => onNavigate('containers')}>View containers</button>
    {/if}
    <button class="btn btn-secondary" onclick={onApplyChanges} disabled={anyDangerousLoading || !tokenStored}>
      {applyLoading ? 'Applying…' : 'Apply config & restart'}
    </button>
  </div>
</section>

<!-- Operation output -->
{#if operationResult}
  <section class="output-section output-section--{operationResultType}">
    <div class="output-header">
      <h3>Operation output</h3>
      <button class="btn-ghost" aria-label="Dismiss" onclick={onDismissResult}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <pre class="output-code">{operationResult}</pre>
  </section>
{/if}

<!-- Live metrics — each tile is a shortcut to where you act on it. -->
<div class="tile-grid">
  <button class="tile" onclick={() => onNavigate('containers')}>
    <span class="tile-metric">
      {#if containerCounts}{containerCounts.running}<span class="tile-metric-sub">/{containerCounts.total}</span>{:else}—{/if}
    </span>
    <span class="tile-label">Services running</span>
  </button>
  <button class="tile" onclick={() => onNavigate('automations')}>
    <span class="tile-metric">
      {#if automationsData}{enabledAutomationCount}<span class="tile-metric-sub">/{automationCount}</span>{:else}—{/if}
    </span>
    <span class="tile-label">Automations active</span>
  </button>
  <button class="tile" onclick={() => onNavigate('logs')}>
    <span class="tile-metric tile-metric--icon" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    </span>
    <span class="tile-label">View logs</span>
  </button>
  <button class="tile" onclick={() => onNavigate('updates')}>
    <span class="tile-metric tile-metric--icon" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="8 17 12 21 16 17" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29" />
      </svg>
    </span>
    <span class="tile-label">Check for updates</span>
  </button>
</div>

<!-- Knowledge base (AKM) health -->
<h3 class="section-heading">Knowledge base (AKM)</h3>
<button class="akm-card" onclick={() => onNavigate('akm')} aria-label="AKM health — open Knowledge settings">
  <div class="akm-head">
    <span class="akm-title">AKM runtime health</span>
    <span class="badge {akmBadge.cls}">{akmBadge.label}</span>
  </div>
  {#if akm && akm.available}
    <div class="akm-metrics">
      <div class="akm-metric">
        <span class="akm-num">{akm.index?.entryCount?.toLocaleString() ?? '—'}</span>
        <span class="akm-cap">Indexed assets</span>
      </div>
      <div class="akm-metric">
        <span class="akm-num">{akm.checks.pass}<span class="akm-num-sub">/{akmCheckTotal}</span></span>
        <span class="akm-cap">Health checks passing</span>
      </div>
      <div class="akm-metric">
        <span class="akm-num">{akm.index?.hasEmbeddings ? 'On' : 'Off'}</span>
        <span class="akm-cap">Semantic search</span>
      </div>
      {#if akm.metrics && typeof akm.metrics.taskFailRate === 'number'}
        <div class="akm-metric">
          <span class="akm-num">{Math.round(akm.metrics.taskFailRate * 100)}%</span>
          <span class="akm-cap">Task failure rate</span>
        </div>
      {/if}
    </div>
  {:else}
    <p class="akm-unavailable">
      Metrics unavailable — the akm CLI isn't reachable from the admin host.
    </p>
  {/if}
</button>

<!-- Configure shortcuts: the common setup destinations, one click away. -->
<h3 class="section-heading">Configure</h3>
<div class="shortcut-grid">
  <button class="shortcut" onclick={() => onNavigate('connections')}>
    <span class="shortcut-name">AI Providers</span>
    <span class="shortcut-desc">Models &amp; provider credentials</span>
  </button>
  <button class="shortcut" onclick={() => onNavigate('akm')}>
    <span class="shortcut-name">Knowledge</span>
    <span class="shortcut-desc">Assistant memory &amp; behavior</span>
  </button>
  <button class="shortcut" onclick={() => onNavigate('voice')}>
    <span class="shortcut-name">Voice</span>
    <span class="shortcut-desc">Speech-to-text &amp; text-to-speech</span>
  </button>
  <button class="shortcut" onclick={() => onNavigate('addons')}>
    <span class="shortcut-name">Channels &amp; add-ons</span>
    <span class="shortcut-desc">Discord, Slack, API &amp; more</span>
  </button>
  <button class="shortcut" onclick={() => onNavigate('secrets')}>
    <span class="shortcut-name">Secrets</span>
    <span class="shortcut-desc">Stack &amp; channel credentials</span>
  </button>
  <a class="shortcut" href="/setup?rerun=1">
    <span class="shortcut-name">Re-run setup</span>
    <span class="shortcut-desc">Walk through the setup wizard again</span>
  </a>
</div>

<style>
  /* ── Status hero ── */
  .hero {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
    padding: var(--space-5);
    border-radius: var(--radius-lg);
    border: 1px solid transparent;
    margin-bottom: var(--space-6);
  }
  .hero--ok {
    background: var(--color-success-bg);
    border-color: var(--color-success-border);
  }
  .hero--warning {
    background: var(--color-warning-bg);
    border-color: var(--color-warning);
  }
  .hero--unknown {
    background: var(--color-bg-secondary);
    border-color: var(--color-border);
  }
  .hero-icon {
    display: inline-flex;
    flex-shrink: 0;
  }
  .hero--ok .hero-icon {
    color: var(--color-badge-success-fg);
  }
  .hero--warning .hero-icon {
    color: var(--color-badge-warning-fg);
  }
  .hero--unknown .hero-icon {
    color: var(--color-text-secondary);
  }
  .hero-text {
    flex: 1 1 240px;
    min-width: 0;
  }
  .hero-title {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }
  .hero-detail {
    margin-top: 2px;
    font-size: var(--text-sm);
    /* Accessible on the tinted hero backgrounds (secondary is only ~3.9:1 on the
       amber warning tint). */
    color: var(--color-badge-neutral-fg);
    max-width: 68ch;
  }
  .hero-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    max-width: 100%;
  }
  .hero-actions :global(.btn) {
    flex-shrink: 0;
  }
  @media (max-width: 560px) {
    /* Give the action group the full row and let the buttons share it so none
       runs off-screen at phone widths. */
    .hero-actions {
      width: 100%;
    }
    .hero-actions :global(.btn) {
      flex: 1 1 auto;
    }
  }

  /* ── Output ── */
  .output-section {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    margin-bottom: var(--space-6);
  }
  .output-section--success { border-color: var(--color-success-border); }
  .output-section--error { border-color: var(--color-danger); }
  .output-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-5);
    background: var(--color-bg-secondary);
    border-bottom: 1px solid var(--color-border);
  }
  .output-header h3 {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }
  .output-code {
    margin: 0;
    padding: var(--space-4) var(--space-5);
    max-height: 320px;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.6;
    color: #e4e8f0;
    background: #1e2330;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ── Metric tiles ── */
  .tile-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: var(--space-4);
    margin-bottom: var(--space-8);
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-4) var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    text-align: left;
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }
  .tile:hover {
    border-color: var(--color-border-hover);
    box-shadow: var(--shadow-sm);
  }
  .tile:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .tile-metric {
    font-size: var(--text-2xl);
    font-weight: var(--font-bold);
    color: var(--color-text);
    line-height: 1.1;
  }
  .tile-metric-sub {
    font-size: var(--text-lg);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
  }
  .tile-metric--icon {
    color: var(--color-text-secondary);
  }
  .tile-label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  /* ── Configure shortcuts ── */
  .section-heading {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text-secondary);
    margin-bottom: var(--space-3);
  }
  .shortcut-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
  }
  .shortcut {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: left;
    text-decoration: none;
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast), background var(--transition-fast);
  }
  .shortcut:hover {
    border-color: var(--color-border-hover);
    background: var(--color-surface-hover);
  }
  .shortcut:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .shortcut-name {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }
  .shortcut-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  /* ── AKM health card ── */
  .akm-card {
    display: block;
    width: 100%;
    text-align: left;
    font-family: var(--font-sans);
    padding: var(--space-5);
    margin-bottom: var(--space-8);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }
  .akm-card:hover {
    border-color: var(--color-border-hover);
    box-shadow: var(--shadow-sm);
  }
  .akm-card:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .akm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  .akm-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }
  .akm-metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-4);
  }
  .akm-metric {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .akm-num {
    font-size: var(--text-xl);
    font-weight: var(--font-bold);
    color: var(--color-text);
    line-height: 1.1;
  }
  .akm-num-sub {
    font-size: var(--text-base);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
  }
  .akm-cap {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
  .akm-unavailable {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    max-width: 68ch;
  }
</style>
