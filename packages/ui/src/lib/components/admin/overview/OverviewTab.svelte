<script lang="ts">
  import { onMount } from 'svelte';
  import type { HealthPayload, AutomationsResponse } from '$lib/types.js';
  import type { TabId } from '$lib/components/chrome/TabBar.svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { fetchAkmHealth, type AkmHealth } from '$lib/api.js';
  import StatusHero from './StatusHero.svelte';
  import OperationOutput from './OperationOutput.svelte';
  import MetricTile from './MetricTile.svelte';
  import AkmHealthCard from './AkmHealthCard.svelte';
  import ConfigureShortcuts from './ConfigureShortcuts.svelte';

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

<!-- Only surface the status hero when something needs attention — the
     "all systems operational" state is redundant noise, so it stays hidden. -->
{#if health.status !== 'ok'}
  <StatusHero
    status={health.status}
    title={health.title}
    detail={health.detail}
    {healthLoading}
    {applyLoading}
    {anyDangerousLoading}
    {tokenStored}
    {onCheckHealth}
    {onApplyChanges}
    {onNavigate}
  />
{/if}

<OperationOutput {operationResult} {operationResultType} {onDismissResult} />

<!-- Live metrics — each tile is a shortcut to where you act on it. -->
<div class="tile-grid">
  <MetricTile
    label="Services running"
    onClick={() => onNavigate('containers')}
    value={containerCounts?.running}
    sub={containerCounts ? `/${containerCounts.total}` : null}
    loaded={!!containerCounts}
  />
  <MetricTile label="View logs" onClick={() => onNavigate('logs')}>
    {#snippet icon()}
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    {/snippet}
  </MetricTile>
  <MetricTile label="Check for updates" onClick={() => onNavigate('updates')}>
    {#snippet icon()}
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="8 17 12 21 16 17" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29" />
      </svg>
    {/snippet}
  </MetricTile>
</div>

<!-- Knowledge base (AKM) health -->
<h3 class="section-heading">Knowledge base (AKM)</h3>
<AkmHealthCard {akm} badge={akmBadge} checkTotal={akmCheckTotal} {onNavigate} />

<!-- Configure shortcuts: the common setup destinations, one click away. -->
<h3 class="section-heading">Configure</h3>
<ConfigureShortcuts {onNavigate} />

<style>
  /* ── Metric tiles grid ── */
  .tile-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: var(--space-4);
    margin-bottom: var(--space-8);
  }

  /* ── Section headings ── */
  .section-heading {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text-secondary);
    margin-bottom: var(--space-3);
  }
</style>
