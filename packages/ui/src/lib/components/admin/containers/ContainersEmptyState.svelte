<script lang="ts">
  import type { ContainerListResponse } from '$lib/types.js';

  interface Props {
    loading: boolean;
    error: string;
    containerData: ContainerListResponse | null;
    tokenStored: boolean;
    onRefresh: () => void;
  }

  let { loading, error, containerData, tokenStored, onRefresh }: Props = $props();
</script>

<div class="empty-state">
  <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
  </svg>
  {#if loading}
    <p>Loading container status...</p>
  {:else if error}
    <p class="text-danger">{error}</p>
    <button class="btn btn-secondary btn-sm" onclick={onRefresh} disabled={!tokenStored}>
      Try Again
    </button>
  {:else if containerData && !containerData.dockerAvailable}
    <p>Docker is not available on this host.</p>
    <p class="hint">Ensure Docker is running and the admin service has access to the Docker socket.</p>
  {:else}
    <p>No containers found. Services may not be installed yet.</p>
  {/if}
</div>

<style>
  .text-danger {
    color: var(--s-seal);
  }

  .empty-state .btn {
    margin-top: var(--s-sp-2);
  }

  .empty-state .hint {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    max-width: 32ch;
  }
</style>
