<script lang="ts">
  import type { ContainerListResponse } from '$lib/types.js';
  import IconServer from '@openpalm/ui-kit/components/icons/IconServer.svelte';

  interface Props {
    loading: boolean;
    error: string;
    containerData: ContainerListResponse | null;
    onRefresh: () => void;
  }

  let { loading, error, containerData, onRefresh }: Props = $props();
</script>

<div class="empty-state">
  <IconServer size={40} />
  {#if loading}
    <p>Loading container status...</p>
  {:else if error}
    <p class="text-danger">{error}</p>
    <button class="btn btn-secondary btn-sm" onclick={onRefresh}>
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
