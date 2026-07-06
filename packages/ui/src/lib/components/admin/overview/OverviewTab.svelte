<script lang="ts">
  import { onMount } from 'svelte';
  import type { TabId } from '$lib/components/chrome/TabBar.svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { fetchAkmHealth, type AkmHealth } from '$lib/api.js';
  import StatusHero from './StatusHero.svelte';
  import MetricTile from './MetricTile.svelte';
  import AkmHealthCard from './AkmHealthCard.svelte';
  import ConfigureShortcuts from './ConfigureShortcuts.svelte';
  import IconTerminal from '@openpalm/ui-kit/components/icons/IconTerminal.svelte';
  import IconCloudDownload from '@openpalm/ui-kit/components/icons/IconCloudDownload.svelte';

  interface Props {
    healthLoading: boolean;
    mergedServices: Map<string, string>;
    /**
     * Services this stack actually deploys (compose model resolved with active
     * profiles). Health is measured against THIS set so a service the stack
     * never deploys (e.g. guardian on a no-portal install) is never counted as
     * a failed container. Falls back to the merged container keys when empty.
     */
    managedServices: string[];
    onCheckHealth: () => void;
    onNavigate: (tab: TabId) => void;
  }

  let {
    healthLoading,
    mergedServices,
    managedServices,
    onCheckHealth,
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

  // Measure health against the services the stack actually deploys, not every
  // container Docker happens to report or the optimistic seed. Falls back to the
  // merged container keys for older server responses that omit managedServices.
  let healthServices = $derived(
    managedServices.length > 0 ? managedServices : [...mergedServices.keys()]
  );

  let containerCounts = $derived.by(() => {
    if (healthServices.length === 0) return null;
    const running = healthServices.filter((name) => mergedServices.get(name) === 'running').length;
    return { total: healthServices.length, running };
  });

  // Services that aren't running, by name — drives the actionable status line.
  let downServices = $derived.by(() =>
    healthServices.filter((name) => mergedServices.get(name) !== 'running')
  );

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

<StatusHero
  status={health.status}
  title={health.title}
  detail={health.detail}
  {healthLoading}
  {onCheckHealth}
  {onNavigate}
/>

<!-- Live metrics — each tile is a shortcut to where you act on it. -->
<div class="tile-grid">
  <MetricTile
    label="Services running"
    onClick={() => onNavigate('containers')}
    value={containerCounts?.running}
    sub={containerCounts ? `/${containerCounts.total}` : null}
    loaded={!!containerCounts}
    status={containerCounts?.running === containerCounts?.total ? 'ok' : 'warn'}
    badge={containerCounts?.running === containerCounts?.total ? 'operational' : `${(containerCounts?.total ?? 0) - (containerCounts?.running ?? 0)} down`}
  />
  <MetricTile label="View logs" onClick={() => onNavigate('logs')}>
    {#snippet icon()}
      <IconTerminal size={22} />
    {/snippet}
  </MetricTile>
  <MetricTile label="Check for updates" onClick={() => onNavigate('updates')}>
    {#snippet icon()}
      <IconCloudDownload size={22} />
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
    gap: var(--s-sp-4);
    margin-bottom: var(--s-sp-8);
  }

  /* ── Section headings ── */
  .section-heading {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
    margin-bottom: var(--s-sp-3);
  }
</style>
