<script lang="ts">
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  // The assistant-endpoint chooser body. Rendered both inside the navbar drawer
  // (small screens) and inline in the chat side panel (large screens), so it is
  // purely the list + manage link — no trigger, no positioning.
  interface Props {
    /** Called after the active endpoint changes (e.g. to close the drawer). */
    onChosen?: () => void;
  }
  let { onChosen }: Props = $props();

  const active = $derived(endpointsService.active);
  const endpoints = $derived(endpointsService.endpoints);

  let switching = $state(false);

  async function activate(id: string): Promise<void> {
    if (switching) return;
    if (id === active?.id) {
      onChosen?.();
      return;
    }
    switching = true;
    try {
      await endpointsService.activate(id);
      onChosen?.();
    } catch {
      // error surfaced via endpointsService.error
    } finally {
      switching = false;
    }
  }
</script>

<div class="endpoint-list">
  {#if endpointsService.error}
    <p class="list-error" role="alert">{endpointsService.error}</p>
  {/if}
  {#each endpoints as ep (ep.id)}
    <button
      type="button"
      class="list-item"
      class:active={ep.id === active?.id}
      aria-current={ep.id === active?.id ? 'true' : undefined}
      onclick={() => activate(ep.id)}
      disabled={switching}
    >
      <span class="check" aria-hidden="true">{ep.id === active?.id ? '●' : '○'}</span>
      <span class="item-text">
        <span class="item-label">{ep.label}</span>
        <span class="item-url">{ep.url}</span>
      </span>
    </button>
  {/each}

  <div class="divider"></div>

  <a class="list-item link" href="/admin/endpoints" onclick={() => onChosen?.()}>
    Manage endpoints…
  </a>
</div>

<style>
  .endpoint-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .list-error {
    margin: 0 0 var(--space-2);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    color: var(--color-danger);
  }

  .list-item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm, 6px);
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--color-text);
  }
  .list-item:hover:not(:disabled),
  .list-item:focus-visible {
    background: var(--color-bg-tertiary);
  }
  .list-item:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .list-item.active {
    background: var(--color-bg-tertiary);
  }

  .check {
    flex-shrink: 0;
    width: 14px;
    color: var(--color-primary);
  }

  .item-text {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .item-label {
    font-weight: 500;
    font-size: var(--text-sm);
  }
  .item-url {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .divider {
    height: 1px;
    margin: var(--space-2) 0;
    background: var(--color-border);
  }

  .list-item.link {
    color: var(--color-primary);
    text-decoration: none;
  }
</style>
