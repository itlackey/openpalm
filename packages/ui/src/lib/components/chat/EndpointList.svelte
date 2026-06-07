<script lang="ts">
  import { isLocalAssistantUrl } from '$lib/assistant-endpoint.js';
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
  const showManageAssistant = $derived(isLocalAssistantUrl(active?.url));

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
  <div class="group" role="group" aria-label="Assistant endpoints">
    {#each endpoints as ep (ep.id)}
      <button
        type="button"
        class="list-item"
        class:active={ep.id === active?.id}
        aria-current={ep.id === active?.id ? 'true' : undefined}
        onclick={() => activate(ep.id)}
        disabled={switching}
      >
        <span class="item-text">
          <span class="item-label">{ep.label}{#if ep.id === active?.id}<span class="sr-only"> (current)</span>{/if}</span>
          <span class="item-url">{ep.url}</span>
        </span>
      </button>
    {/each}
  </div>

  <div class="divider"></div>

  {#if showManageAssistant}
    <a class="list-item link" href="/admin" onclick={() => onChosen?.()}>
      Manage this assistant…
    </a>
  {/if}

  <a class="list-item link" href="/admin/endpoints" onclick={() => onChosen?.()}>
    Manage assistant connections…
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
  /* Active row: an inset primary bar instead of a background tint, so secondary
     metadata keeps full contrast against the panel/drawer surface. */
  .list-item.active {
    box-shadow: inset 3px 0 0 var(--color-primary);
  }
  .list-item.active .item-label {
    font-weight: 600;
  }

  .item-text {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
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

  /* Secondary action — normal text colour (orange is reserved for fills); an
     underline on hover/focus marks it as a navigation link, not a list row. */
  .list-item.link {
    color: var(--color-text);
    text-decoration: none;
  }
  .list-item.link:hover,
  .list-item.link:focus-visible {
    text-decoration: underline;
  }
</style>
