<script lang="ts">
  import type { ContainerListResponse } from '$lib/types.js';
  import ContainerRow from './ContainerRow.svelte';

  interface Props {
    containerData: ContainerListResponse | null;
    loading: boolean;
    error: string;
    tokenStored: boolean;
    selectedContainerId: string | null;
    onToggleContainer: (id: string) => void;
    onStart: (id: string) => void;
    onStop: (id: string) => void;
    onRestart: (id: string) => void;
    onRefresh: () => void;
  }

  let {
    containerData,
    loading,
    error,
    tokenStored,
    selectedContainerId,
    onToggleContainer,
    onStart,
    onStop,
    onRestart,
    onRefresh
  }: Props = $props();

  let hasContainers = $derived(
    containerData !== null &&
      containerData.dockerAvailable &&
      Array.isArray(containerData.dockerContainers) &&
      containerData.dockerContainers.length > 0
  );
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <h2>Container Status</h2>
    <button class="btn btn-secondary btn-sm" onclick={onRefresh} disabled={loading || !tokenStored}>
      {#if loading}
        <span class="spinner"></span>
      {/if}
      Refresh
    </button>
  </div>
  <div class="panel-body panel-body--flush">
    {#if hasContainers && Array.isArray(containerData?.dockerContainers)}
      <div class="container-table">
        <div class="container-table-header">
          <span class="ct-col ct-col--name">Container</span>
          <span class="ct-col ct-col--image">Image</span>
          <span class="ct-col ct-col--tag">Tag</span>
          <span class="ct-col ct-col--status">Status</span>
          <span class="ct-col ct-col--actions"></span>
        </div>
        {#each containerData.dockerContainers as container}
          <ContainerRow
            {container}
            selected={selectedContainerId === container.ID}
            onToggle={() => onToggleContainer(container.ID)}
            onStart={() => onStart(container.Service)}
            onStop={() => onStop(container.Service)}
            onRestart={() => onRestart(container.Service)}
          />
        {/each}
      </div>
    {:else}
      <div class="empty-state">
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
          <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
        </svg>
        {#if loading}
          <p>Loading container status...</p>
        {:else if error}
          <p class="text-danger">{error}</p>
        {:else if containerData && !containerData.dockerAvailable}
          <p>Docker is not available on this host.</p>
        {:else}
          <p>Click Refresh to load container information.</p>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
  }

  .panel-header h2 {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .panel-body {
    padding: var(--space-5);
  }

  .panel-body--flush {
    padding: 0;
  }

  .container-table {
    width: 100%;
  }

  .container-table-header {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-5);
    background: var(--color-bg-tertiary);
    border-bottom: 1px solid var(--color-border);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .ct-col {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .ct-col--name {
    flex: 2;
    min-width: 0;
  }

  .ct-col--image {
    flex: 3;
    min-width: 0;
  }

  .ct-col--tag {
    flex: 1;
    min-width: 0;
  }

  .ct-col--status {
    flex: 1;
    min-width: 0;
  }

  .ct-col--actions {
    flex: 0 0 24px;
    justify-content: center;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--space-10) var(--space-4);
    color: var(--color-text-tertiary);
    text-align: center;
    gap: var(--space-4);
  }

  .empty-state p {
    font-size: var(--text-sm);
  }

  .text-danger {
    color: var(--color-danger);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 8px 16px;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    line-height: 1.4;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-surface-hover);
    border-color: var(--color-border-hover);
  }

  .btn-sm {
    padding: 5px 12px;
    font-size: var(--text-xs);
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 768px) {
    .container-table-header {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
