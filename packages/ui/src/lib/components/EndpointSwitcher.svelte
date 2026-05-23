<script lang="ts">
  import { onMount } from 'svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  let open = $state(false);
  let switching = $state(false);
  let menuEl: HTMLDivElement | undefined = $state();

  const active = $derived(endpointsService.active);
  const endpoints = $derived(endpointsService.endpoints);
  const hasChoices = $derived(endpoints.length > 1);

  onMount(() => {
    void endpointsService.load();

    function onDocClick(ev: MouseEvent) {
      if (!open) return;
      const target = ev.target as Node | null;
      if (menuEl && target && !menuEl.contains(target)) open = false;
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  });

  async function activate(id: string): Promise<void> {
    if (switching) return;
    if (id === active?.id) {
      open = false;
      return;
    }
    switching = true;
    try {
      await endpointsService.activate(id);
      open = false;
    } catch {
      // error surfaced via endpointsService.error
    } finally {
      switching = false;
    }
  }

  function toggle(): void {
    if (!hasChoices && !open) {
      // No alternatives yet — go straight to the management page
      window.location.href = '/admin/endpoints';
      return;
    }
    open = !open;
  }
</script>

<div class="switcher" bind:this={menuEl}>
  <button
    type="button"
    class="trigger"
    onclick={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    title={active ? `Connected to: ${active.label} (${active.url})` : 'Assistant endpoints'}
    disabled={switching || endpointsService.loading}
  >
    <span class="dot" aria-hidden="true"></span>
    <span class="label">{active?.label ?? 'Endpoint…'}</span>
    <span class="caret" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <div class="menu" role="menu">
      <div class="menu-header">Assistant endpoint</div>
      {#each endpoints as ep (ep.id)}
        <button
          type="button"
          class="menu-item"
          class:active={ep.id === active?.id}
          role="menuitemradio"
          aria-checked={ep.id === active?.id}
          onclick={() => activate(ep.id)}
          disabled={switching}
        >
          <span class="check" aria-hidden="true">{ep.id === active?.id ? '●' : '○'}</span>
          <span class="menu-item-text">
            <span class="menu-item-label">{ep.label}</span>
            <span class="menu-item-url">{ep.url}</span>
          </span>
        </button>
      {/each}
      <div class="menu-divider"></div>
      <a class="menu-item link" href="/admin/endpoints" onclick={() => (open = false)} role="menuitem">
        Manage endpoints…
      </a>
    </div>
  {/if}
</div>

<style>
  .switcher {
    position: relative;
  }

  .trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    height: 32px;
    background: var(--color-surface, rgba(255, 255, 255, 0.7));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    font-size: var(--text-sm);
    color: var(--color-text);
    cursor: pointer;
    max-width: 240px;
    overflow: hidden;
  }
  .trigger:hover:not(:disabled) {
    background: var(--color-surface-hover, rgba(255, 255, 255, 0.9));
  }
  .trigger:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-success, #16a34a);
    flex-shrink: 0;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  }

  .caret {
    font-size: 10px;
    opacity: 0.6;
  }

  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 100;
    min-width: 280px;
    max-width: 360px;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
    padding: var(--space-2);
  }

  .menu-header {
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .menu-item {
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
  .menu-item:hover:not(:disabled),
  .menu-item:focus-visible {
    background: var(--color-surface-hover, rgba(0, 0, 0, 0.04));
  }
  .menu-item:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .menu-item.active {
    background: var(--color-surface-hover, rgba(0, 0, 0, 0.04));
  }

  .check {
    flex-shrink: 0;
    width: 14px;
    color: var(--color-accent, #2563eb);
  }

  .menu-item-text {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .menu-item-label {
    font-weight: 500;
    font-size: var(--text-sm);
  }
  .menu-item-url {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu-divider {
    height: 1px;
    margin: var(--space-2) 0;
    background: var(--color-border);
  }

  .menu-item.link {
    color: var(--color-accent, #2563eb);
    text-decoration: none;
  }
</style>
