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
    <div class="list-error" role="alert">
      <strong>Assistant list unavailable</strong>
      <span>{endpointsService.error}</span>
    </div>
  {/if}
  <div class="panel-intro">
    <p>Choose where this conversation runs. Each assistant keeps its own conversation history.</p>
  </div>
  {#if endpoints.length === 0}
    <div class="empty-state">
      <strong>No assistants connected</strong>
      <span>Add a connection saved in this browser to start chatting.</span>
    </div>
  {:else}
    <div class="group" role="group" aria-label="Assistants">
      {#each endpoints as ep (ep.id)}
        {@const current = ep.id === active?.id}
        <button
          type="button"
          class="list-item"
          class:active={current}
          aria-current={current ? 'true' : undefined}
          aria-label={`${ep.label}, ${current ? 'current assistant, connected' : 'connected'}`}
          onclick={() => activate(ep.id)}
          disabled={switching}
        >
          <span class="assistant-mark" aria-hidden="true">{current ? '✓' : ''}</span>
          <span class="item-text">
            <span class="item-label">{ep.label}</span>
            <span class="item-url"><span>Address</span>{ep.url}</span>
          </span>
          <span class="status"><span class="status-dot" aria-hidden="true"></span>Connected</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .endpoint-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-4);
  }

  .list-error {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
    padding: var(--s-sp-3);
    border: var(--s-hair) solid var(--s-error);
    border-radius: 8px;
    color: var(--s-error);
    font-size: 0.875rem;
  }

  .panel-intro p {
    margin: 0;
    max-width: 36rem;
    color: var(--s-ink-2);
    font-size: 0.875rem;
    line-height: 1.55;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
  }

  .list-item {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: var(--s-sp-3);
    width: 100%;
    min-height: 76px;
    padding: var(--s-sp-3);
    background: color-mix(in srgb, var(--s-paper-deep) 55%, transparent);
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--s-ink);
  }
  .list-item:hover:not(:disabled),
  .list-item:focus-visible {
    border-color: var(--s-ink-3);
    background: var(--s-paper-deep);
  }
  .list-item:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 2px;
  }
  .list-item:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .list-item.active {
    border-color: var(--s-seal);
    box-shadow: inset 3px 0 0 var(--s-seal);
    background: var(--s-paper-deep);
  }

  .assistant-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 50%;
    color: var(--s-seal);
    font-size: 0.875rem;
  }
  .active .assistant-mark {
    border-color: var(--s-seal);
  }

  .item-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
    flex: 1;
    min-width: 0;
  }

  .item-label {
    font-family: var(--s-font-display);
    font-size: 1rem;
    font-weight: 600;
    color: var(--s-ink);
  }

  .item-url {
    display: flex;
    gap: var(--s-sp-2);
    font-family: var(--s-font-mono);
    font-size: 0.75rem;
    color: var(--s-ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item-url span {
    color: var(--s-ink-2);
    font-weight: 600;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-1);
    flex-shrink: 0;
    color: var(--s-ink-2);
    font-family: var(--s-font-mono);
    font-size: 0.75rem;
  }
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--s-moss);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
    padding: var(--s-sp-5);
    border: var(--s-hair) dashed var(--s-line-soft);
    border-radius: 10px;
    color: var(--s-ink-2);
    font-size: 0.875rem;
  }
  .empty-state strong {
    color: var(--s-ink);
    font-size: 1rem;
  }

  @media (max-width: 420px) {
    .list-item {
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .status {
      margin-left: 40px;
    }
    .item-text {
      flex-basis: calc(100% - 40px);
    }
    .item-url {
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }
</style>
