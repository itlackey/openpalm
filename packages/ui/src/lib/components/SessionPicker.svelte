<script lang="ts">
  import { onMount } from 'svelte';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  let open = $state(false);
  let showAll = $state(false);
  // The root container — used only for outside-click detection.
  let containerEl: HTMLDivElement | undefined = $state();
  // The trigger button — used to compute fixed-position menu coordinates.
  let triggerEl: HTMLButtonElement | undefined = $state();
  // Computed position for the fixed-position menu.
  let menuStyle = $state('');

  const SESSION_LIST_CAP = 50;

  const active = $derived(endpointsService.active);
  const endpointState = $derived(
    active ? (chat.byEndpoint.get(active.id) ?? null) : null
  );
  const sessions = $derived(endpointState?.sessions ?? []);
  const loading = $derived(endpointState?.sessionsLoading ?? false);
  const error = $derived(endpointState?.sessionsError ?? '');
  const activeSessionId = $derived(chat.activeSessionId);

  const activeSummary = $derived(
    sessions.find((s) => s.id === activeSessionId) ?? null
  );
  const triggerLabel = $derived(
    activeSummary
      ? activeSummary.title || `Untitled · ${formatRelative(activeSummary.updatedAt)}`
      : 'New session'
  );
  /**
   * Live-updates indicator. True when the chat service's SSE stream to
   * `/proxy/assistant/event` is connected — out-of-band session changes
   * (CLI, other clients) will flow through. Shown as a tiny dot so the
   * operator can tell at a glance whether the picker is reactive or
   * snapshot.
   */
  const liveConnected = $derived(chat.liveConnected);

  const visibleSessions = $derived(
    showAll ? sessions : sessions.slice(0, SESSION_LIST_CAP)
  );
  const overflowCount = $derived(Math.max(0, sessions.length - SESSION_LIST_CAP));

  /** Compute and cache the fixed-position style string from the trigger rect. */
  function computeMenuStyle(): void {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const menuWidth = Math.min(380, Math.max(300, window.innerWidth - 24));
    const rightFromViewport = window.innerWidth - rect.right;
    const clampedRight = Math.max(12, rightFromViewport);
    menuStyle = `top:${rect.bottom + 6}px;right:${clampedRight}px;width:${menuWidth}px;`;
  }

  onMount(() => {
    function onDocClick(ev: MouseEvent) {
      if (!open) return;
      const target = ev.target as Node | null;
      if (containerEl && target && !containerEl.contains(target)) open = false;
    }
    function onResize() {
      if (open) computeMenuStyle();
    }
    // NOTE: No document-level Escape handler here. Escape is handled by the
    // sheet's handleSheetKeyDown (with stopPropagation) when inside the mobile
    // sheet, and by the picker's own onKeyDown on the trigger/menu when on
    // desktop. This prevents the double-close race (BLOCKER C).
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('scroll', onResize, { passive: true, capture: true });
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, { capture: true });
    };
  });

  /**
   * Tiny relative-time helper. No date-fns dep — that would be ~30 KB for
   * 4 cases.
   */
  function formatRelative(ts: number): string {
    if (!ts) return '';
    const diffSec = Math.max(0, (Date.now() - ts) / 1000);
    if (diffSec < 60) return 'just now';
    const min = Math.floor(diffSec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day === 1) return 'yesterday';
    if (day < 7) return `${day}d ago`;
    const wk = Math.floor(day / 7);
    if (wk < 5) return `${wk}w ago`;
    const mo = Math.floor(day / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(day / 365)}y ago`;
  }

  async function toggle(): Promise<void> {
    if (!open) {
      computeMenuStyle();
      // Lazy-load the session list on first open if not cached.
      if (active && !endpointState?.sessionsLoaded && !loading) {
        void chat.loadSessions();
      }
    }
    open = !open;
  }

  async function pick(id: string): Promise<void> {
    if (chat.sending) return;
    if (id === activeSessionId) {
      open = false;
      return;
    }
    open = false;
    await chat.openSession(id);
  }

  async function startNew(): Promise<void> {
    if (chat.sending) return;
    open = false;
    await chat.startNewSession();
  }

  async function retry(): Promise<void> {
    await chat.loadSessions();
  }
</script>

<div class="picker" bind:this={containerEl}>
  <button
    type="button"
    class="trigger"
    bind:this={triggerEl}
    onclick={toggle}
    onkeydown={(ev) => { if (ev.key === 'Escape' && open) { ev.stopPropagation(); open = false; } }}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label="Sessions"
    title={triggerLabel}
  >
    <!-- messages-square (Lucide) -->
    <svg
      class="trigger-icon"
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z" />
      <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
    </svg>
    <span
      class="dot"
      class:connected={liveConnected}
      aria-hidden="true"
      title={liveConnected ? 'Live updates connected' : 'Live updates disconnected'}
    ></span>
    <span class="label">{triggerLabel}</span>
    <span class="caret" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <div class="menu" role="menu" tabindex="-1" style={menuStyle} onkeydown={(ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); open = false; triggerEl?.focus(); } }}>
      <div class="menu-header">
        Sessions on {active?.label ?? 'this endpoint'}
      </div>

      {#if chat.sending}
        <div class="notice">Wait for the current reply to finish before switching.</div>
      {/if}

      <button
        type="button"
        class="menu-item new-btn"
        role="menuitem"
        onclick={startNew}
        disabled={chat.sending}
      >
        <span class="check" aria-hidden="true">+</span>
        <span class="menu-item-text">
          <span class="menu-item-label">New session</span>
        </span>
      </button>

      <div class="menu-divider"></div>

      {#if loading}
        <div class="empty">
          <span class="spinner" aria-hidden="true"></span>
          <span>Loading sessions…</span>
        </div>
      {:else if error}
        <div class="error">
          <span>{error}</span>
          <button type="button" class="retry-btn" onclick={retry}>Retry</button>
        </div>
      {:else if sessions.length === 0}
        <div class="empty">No sessions yet. Start the first one.</div>
      {:else}
        <div class="session-list" role="none">
          {#each visibleSessions as s (s.id)}
            <button
              type="button"
              class="menu-item session-item"
              class:active={s.id === activeSessionId}
              role="menuitemradio"
              aria-checked={s.id === activeSessionId}
              onclick={() => pick(s.id)}
              disabled={chat.sending}
            >
              <span class="check" aria-hidden="true">
                {s.id === activeSessionId ? '●' : '○'}
              </span>
              <span class="menu-item-text">
                <span class="menu-item-label">
                  {s.title || 'Untitled'}
                </span>
                <span class="menu-item-meta">{formatRelative(s.updatedAt)}</span>
              </span>
            </button>
          {/each}
        </div>
        {#if !showAll && overflowCount > 0}
          <button type="button" class="show-all" onclick={() => (showAll = true)}>
            Show all ({overflowCount} more)
          </button>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .picker {
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
  .trigger:hover {
    background: var(--color-surface-hover);
  }

  /* Wide view: icon + label + caret. */
  .trigger-icon {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  /**
   * Live-updates indicator. Green when the SSE stream is connected,
   * neutral gray otherwise. Matches the EndpointSwitcher `.dot` pattern
   * (8px circle, success color) for visual consistency.
   */
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-text-tertiary);
    flex-shrink: 0;
    transition: background 120ms ease;
  }
  .dot.connected {
    background: var(--color-success, #16a34a);
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
    cursor: not-allowed;
  }
  .menu-item.active {
    background: var(--color-bg-tertiary);
  }

  .new-btn {
    color: var(--color-primary);
    font-weight: 500;
  }

  .check {
    flex-shrink: 0;
    width: 14px;
    text-align: center;
    color: var(--color-primary);
  }

  .menu-item-text {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex: 1;
    min-width: 0;
  }
  .menu-item-label {
    font-weight: 500;
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu-item-meta {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .menu-divider {
    height: 1px;
    margin: var(--space-2) 0;
    background: var(--color-border);
  }

  .session-list {
    max-height: 60vh;
    overflow-y: auto;
  }

  .empty,
  .error {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .error {
    color: var(--color-danger);
  }
  .error span:first-child {
    flex: 1;
  }
  .retry-btn {
    padding: 2px 8px;
    font-size: var(--text-xs);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--color-danger);
    cursor: pointer;
  }
  .retry-btn:hover {
    background: var(--color-danger);
    color: var(--color-text-inverse);
  }

  .notice {
    margin: 0 var(--space-2) var(--space-2);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    background: var(--color-bg-tertiary);
    border-radius: var(--radius-sm, 6px);
  }

  .show-all {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: 0;
    color: var(--color-primary);
    font: inherit;
    font-size: var(--text-xs);
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-sm, 6px);
  }
  .show-all:hover {
    background: var(--color-bg-tertiary);
  }

  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
