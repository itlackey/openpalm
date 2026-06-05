<script lang="ts">
  import { onMount } from 'svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  let open = $state(false);
  let switching = $state(false);
  // The root container (used only for outside-click detection).
  let containerEl: HTMLDivElement | undefined = $state();
  // The trigger button — used to compute fixed-position menu coordinates.
  let triggerEl: HTMLButtonElement | undefined = $state();
  // Computed position for the fixed-position menu.
  let menuStyle = $state('');

  const active = $derived(endpointsService.active);
  const endpoints = $derived(endpointsService.endpoints);
  const hasChoices = $derived(endpoints.length > 1);

  /** Compute and cache the fixed-position style string from the trigger rect. */
  function computeMenuStyle(): void {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const menuWidth = Math.min(360, Math.max(280, window.innerWidth - 24));
    // Prefer right-aligning to the trigger's right edge; clamp to viewport.
    const rightFromViewport = window.innerWidth - rect.right;
    const clampedRight = Math.max(12, rightFromViewport);
    menuStyle = `top:${rect.bottom + 6}px;right:${clampedRight}px;width:${menuWidth}px;`;
  }

  onMount(() => {
    void endpointsService.load();

    function onDocClick(ev: MouseEvent) {
      if (!open) return;
      const target = ev.target as Node | null;
      if (containerEl && target && !containerEl.contains(target)) open = false;
    }
    function onResize() {
      if (open) computeMenuStyle();
    }
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('scroll', onResize, { passive: true, capture: true });
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, { capture: true });
    };
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
    if (!open) computeMenuStyle();
    open = !open;
  }
</script>

<div class="switcher" bind:this={containerEl}>
  <button
    type="button"
    class="trigger"
    bind:this={triggerEl}
    onclick={toggle}
    onkeydown={(ev) => { if (ev.key === 'Escape' && open) { ev.stopPropagation(); open = false; } }}
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
    <div class="menu" role="menu" tabindex="-1" style={menuStyle} onkeydown={(ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); open = false; triggerEl?.focus(); } }}>
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

  /*
   * At ≤640px the trigger is only rendered inside the mobile sheet
   * (full-width, overridden by Navbar.svelte's .mobile-control-row :global).
   * No icon-only collapse needed at any header breakpoint.
   */

  /*
   * position:fixed so the menu escapes ANY clipping scroll ancestor —
   * including the mobile sheet body (overflow-y:auto makes overflow-x:auto
   * too per CSS Overflow L3, clipping absolute children geometrically).
   * Coordinates are JS-computed via computeMenuStyle() at open time and on
   * resize/scroll, anchored to the trigger button's getBoundingClientRect().
   * The inline style attribute carries top/right/width; z-index is here.
   */
  .menu {
    position: fixed;
    z-index: 400;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    box-shadow: var(--shadow-lg);
    padding: var(--space-2);
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
