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
    aria-label={active ? `Assistant endpoint: ${active.label}` : 'Assistant endpoints'}
    title={active ? `Connected to: ${active.label} (${active.url})` : 'Assistant endpoints'}
    disabled={switching || endpointsService.loading}
  >
    <!-- server icon (Lucide) — single icon-only target on narrow widths -->
    <svg class="trigger-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
      <line x1="6" y1="6" x2="6.01" y2="6"/>
      <line x1="6" y1="18" x2="6.01" y2="18"/>
    </svg>
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
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    font-size: var(--text-sm);
    color: var(--color-text);
    cursor: pointer;
    max-width: 240px;
    overflow: hidden;
  }
  .trigger:hover:not(:disabled) {
    background: var(--color-surface-hover);
  }
  .trigger:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  /* Default (wide) view: dot + label + caret. The server icon is hidden. */
  .trigger-icon {
    display: none;
    flex-shrink: 0;
    color: var(--color-text-secondary);
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

  /* Narrow widths (Electron sidecar mode, small mobile): collapse the
     trigger to a single icon button. The dropdown menu still opens with
     full labels + URLs — only the closed trigger shrinks. */
  @media (max-width: 600px) {
    .trigger {
      width: 32px;
      padding: 0;
      justify-content: center;
      gap: 0;
      max-width: 32px;
    }
    .trigger-icon {
      display: inline-block;
    }
    .dot,
    .label,
    .caret {
      display: none;
    }
  }

  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 100;
    /* Fit in a 300px-wide Electron sidecar with margin to spare. */
    min-width: min(280px, calc(100vw - 24px));
    max-width: min(360px, calc(100vw - 24px));
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    box-shadow: var(--shadow-lg);
    padding: var(--space-2);
  }

  /* On narrow widths, anchor the menu to the viewport's top-right corner
     (just below the navbar) rather than the trigger button. Because the
     trigger is one of several icon buttons in navbar-actions, its right
     edge is NOT the viewport's right edge — `right: 0` on the trigger
     parent pushes the menu off-screen to the left when the trigger sits
     mid-navbar. Fixed positioning fixes that. */
  @media (max-width: 600px) {
    .menu {
      position: fixed;
      top: calc(var(--nav-height) + 6px);
      right: var(--space-3);
    }
  }

  .menu-header {
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
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
    background: var(--color-bg-tertiary);
  }
  .menu-item:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .menu-item.active {
    background: var(--color-bg-tertiary);
  }

  .check {
    flex-shrink: 0;
    width: 14px;
    color: var(--color-primary);
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
    color: var(--color-text-secondary);
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
    color: var(--color-primary);
    text-decoration: none;
  }
</style>
