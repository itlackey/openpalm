<script lang="ts">
  import Spinner from '$lib/components/common/Spinner.svelte';
  import Panel from '$lib/components/common/Panel.svelte';
  import ContainerRow from '$lib/components/admin/containers/ContainerRow.svelte';
  import ContainerDetail from '$lib/components/admin/containers/ContainerDetail.svelte';
  import ContainersEmptyState from '$lib/components/admin/containers/ContainersEmptyState.svelte';
  import type { ContainerListResponse, ServiceEntry } from '$lib/types.js';

  interface Props {
    containerData: ContainerListResponse | null;
    serviceEntries: ServiceEntry[];
    loading: boolean;
    error: string;
    selectedContainerId: string | null;
    onToggleContainer: (id: string) => void;
    onStart: (id: string) => void;
    onStop: (id: string) => void;
    onRestart: (id: string) => void;
    onRefresh: () => void;
    onPullImages: () => void;
    lastUpdated: string | null;
    pullLoading: boolean;
  }

  let {
    containerData,
    serviceEntries,
    loading,
    error,
    selectedContainerId,
    onToggleContainer,
    onStart,
    onStop,
    onRestart,
    onRefresh,
    onPullImages,
    lastUpdated,
    pullLoading
  }: Props = $props();

  let hasEntries = $derived(serviceEntries.length > 0);

  // ── Per-entry row state ──────────────────────────────────────────────
  type RowState = { inFlight: 'start' | 'stop' | 'restart' | null; confirm: 'start' | 'stop' | 'restart' | null; feedback: { type: 'success' | 'error'; message: string } | null };
  let rowState = $state<Record<string, RowState>>({});

  function rowFor(id: string): RowState {
    if (!rowState[id]) rowState[id] = { inFlight: null, confirm: null, feedback: null };
    return rowState[id];
  }

  function requestRowAction(id: string, action: 'start' | 'stop' | 'restart', e: MouseEvent): void {
    e.stopPropagation();
    rowFor(id).confirm = action;
  }

  function cancelConfirm(id: string, e: MouseEvent): void {
    e.stopPropagation();
    rowFor(id).confirm = null;
  }

  async function executeAction(id: string, service: string, action: 'start' | 'stop' | 'restart', e: MouseEvent): Promise<void> {
    e.stopPropagation();
    const row = rowFor(id);
    row.confirm = null;
    row.inFlight = action;
    row.feedback = null;
    try {
      if (action === 'start') onStart(service);
      else if (action === 'stop') onStop(service);
      else onRestart(service);
      row.feedback = { type: 'success', message: `${action.charAt(0).toUpperCase() + action.slice(1)} initiated` };
    } catch (err) {
      row.feedback = { type: 'error', message: `${action} failed: ${err instanceof Error ? err.message : err}` };
    }
    row.inFlight = null;
    setTimeout(() => {
      row.feedback = null;
    }, 3000);
  }
</script>

<Panel title="Container Status" role="tabpanel">
  {#snippet actions()}
    {#if lastUpdated}
      <span class="last-updated">Updated {lastUpdated}</span>
    {/if}
    <button class="btn btn-secondary btn-sm" onclick={onPullImages} disabled={pullLoading}>
      {#if pullLoading}
        <Spinner />
      {/if}
      Pull Images
    </button>
    <button class="btn btn-secondary btn-sm" onclick={onRefresh} disabled={loading}>
      {#if loading}
        <Spinner />
      {/if}
      Refresh
    </button>
  {/snippet}
  <div class="panel-body panel-body--flush">
    {#if hasEntries}
      <div class="container-table">
        <div class="container-table-header">
          <span class="ct-col ct-col--name">Container</span>
          <span class="ct-col ct-col--image">Image</span>
          <span class="ct-col ct-col--tag">Tag</span>
          <span class="ct-col ct-col--status">Status</span>
          <span class="ct-col ct-col--actions"></span>
        </div>
        {#each serviceEntries as entry (entry.id)}
          {@const selected = selectedContainerId === entry.id}
          <ContainerRow {entry} {selected} onToggle={() => onToggleContainer(entry.id)} />

          {#if selected}
            <ContainerDetail
              {entry}
              actionInFlight={rowState[entry.id]?.inFlight ?? null}
              confirmAction={rowState[entry.id]?.confirm ?? null}
              feedback={rowState[entry.id]?.feedback ?? null}
              onRequestAction={(action, e) => requestRowAction(entry.id, action, e)}
              onCancelConfirm={(e) => cancelConfirm(entry.id, e)}
              onExecuteAction={(action, e) => executeAction(entry.id, entry.service, action, e)}
            />
          {/if}
        {/each}
      </div>
    {:else}
      <ContainersEmptyState {loading} {error} {containerData} {onRefresh} />
    {/if}
  </div>
</Panel>

<style>
  .container-table {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .container-table-header {
    display: flex;
    align-items: center;
    padding: var(--s-sp-2) var(--s-sp-6);
    background: var(--s-paper-deep);
    border-bottom: var(--s-hair) solid var(--s-line);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .last-updated {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    white-space: nowrap;
  }

  @media (max-width: 768px) {
    .container-table-header {
      display: none;
    }
  }
</style>
