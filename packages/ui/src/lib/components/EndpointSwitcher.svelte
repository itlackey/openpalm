<script lang="ts">
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  const menuId = 'endpoint-menu';

  let switching = $state(false);
  // Track popover open state for aria-expanded. Updated via the popover toggle event.
  let isOpen = $state(false);

  const active = $derived(endpointsService.active);
  const endpoints = $derived(endpointsService.endpoints);
  const hasChoices = $derived(endpoints.length > 1);

  $effect(() => {
    void endpointsService.load();
  });

  /** Called when the trigger is clicked. If no choices and not open, navigate directly. */
  function handleTriggerClick(ev: MouseEvent): void {
    if (!hasChoices) {
      // No alternatives yet — go straight to the management page.
      // Prevent the popovertarget from toggling (we're navigating away).
      ev.preventDefault();
      window.location.href = '/admin/endpoints';
    }
    // When hasChoices is true, popovertarget="menuId" handles toggle declaratively.
  }

  async function activate(id: string): Promise<void> {
    if (switching) return;
    if (id === active?.id) return;
    switching = true;
    try {
      await endpointsService.activate(id);
    } catch {
      // error surfaced via endpointsService.error
    } finally {
      switching = false;
    }
  }

  /** Sync isOpen from the popover toggle event (fired by the browser). */
  function onPopoverToggle(ev: Event): void {
    const e = ev as ToggleEvent;
    isOpen = e.newState === 'open';
  }
</script>

<div class="switcher">
  <button
    type="button"
    class="trigger"
    id="endpoint-trigger"
    popovertarget={hasChoices ? menuId : undefined}
    onclick={handleTriggerClick}
    aria-haspopup="menu"
    aria-expanded={isOpen}
    aria-controls={menuId}
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

  <!--
    popover="auto": browser provides Escape + light-dismiss (outside-click) for free.
    Position is entirely CSS-driven via anchor positioning — no JS coordinates.
    The element is always in the DOM (hidden via UA popover styles).
  -->
  <div
    id={menuId}
    class="menu"
    popover="auto"
    role="menu"
    tabindex="-1"
    ontoggle={onPopoverToggle}
  >
    <div class="menu-header">Assistant endpoint</div>
    {#each endpoints as ep (ep.id)}
      <button
        type="button"
        class="menu-item"
        class:active={ep.id === active?.id}
        role="menuitemradio"
        aria-checked={ep.id === active?.id}
        popovertarget={menuId}
        popovertargetaction="hide"
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
    <a
      class="menu-item link"
      href="/admin/endpoints"
      role="menuitem"
    >
      Manage endpoints…
    </a>
  </div>
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
    /* Static anchor name — no v-bind, no JS, works across the popover top-layer. */
    anchor-name: --endpoint-anchor;
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
   * Popover menu: positioned via CSS Anchor Positioning — no JS coordinates.
   *
   * `position: fixed` places the element in the top layer (escapes all overflow
   * clipping natively, without JS).
   * `position-anchor` binds to the trigger's static --endpoint-anchor anchor name.
   * `position-area: bottom span-inline-start` aligns the menu's inline-start
   * edge to the trigger's inline-start edge, opening below.
   * `position-try-fallbacks: flip-block` flips above when no room below.
   *
   * Browsers that don't support anchor positioning (pre-Chrome 125 / pre-Safari 26 /
   * pre-Firefox 147) see only `position: fixed` and the menu appears at the top-left
   * of the viewport — still functional, still no clipping.
   */
  .menu {
    /* Reset UA popover margin/padding. */
    margin: 0;
    padding: var(--space-2);

    position: fixed;
    /* Static anchor name — resolves correctly across the popover top-layer. */
    position-anchor: --endpoint-anchor;
    position-area: block-end span-inline-start;
    margin-top: 6px;
    position-try-fallbacks: flip-block;
    /* Constrain width: at least 280px, at most 360px, capped by viewport. */
    min-width: 280px;
    max-width: min(360px, calc(100vw - 24px));

    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    box-shadow: var(--shadow-lg);

    /* Popover elements are hidden by default by the UA. No JS open/close. */
    z-index: 400;
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
