<script lang="ts">
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  interface Props {
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
  <div class="s-ep-section-label">assistant</div>
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
</div>

<style>
  .endpoint-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .list-error {
    margin: 0 0 var(--s-sp-2);
    padding: var(--s-sp-2) var(--s-sp-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-seal);
  }

  .list-item {
    box-sizing: border-box;
    display: flex;
    align-items: flex-start;
    gap: var(--s-sp-2);
    width: 100%;
    min-height: 44px;
    padding: var(--s-sp-2) var(--s-sp-3);
    background: none;
    border: 0;
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    border-radius: 0;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
  }
  .list-item:hover:not(:disabled),
  .list-item:focus-visible {
    color: var(--s-ink-2);
  }
  .list-item:focus {
    outline: 2px solid var(--s-seal);
    outline-offset: -2px;
  }
  .list-item:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  /* Active row: left hairline in seal accent */
  .list-item.active {
    color: var(--s-ink-2);
    border-left: 2px solid var(--s-seal);
    padding-left: calc(var(--s-sp-3) - 2px);
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
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: inherit;
  }

  .item-url {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .s-ep-section-label {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: 0.26em;
    text-transform: uppercase;
    color: var(--s-ink-3);
    margin-bottom: 0.7rem;
    padding: var(--s-sp-2) var(--s-sp-3) 0;
  }
</style>
