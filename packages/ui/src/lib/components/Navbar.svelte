<script lang="ts">
  import { page } from '$app/state';
  import { version as uiVersion } from '../../../package.json';
  import VoiceControl from './VoiceControl.svelte';
  import EndpointSwitcher from './EndpointSwitcher.svelte';
  import SessionPicker from './SessionPicker.svelte';
  import ThemeToggle from './ThemeToggle.svelte';

  // The three primary destinations, always reachable from the top toolbar:
  // regular Chat, the embedded OpenCode "Advanced" chat, and Admin.
  const NAV_ITEMS = [
    { href: '/chat', label: 'Chat', icon: 'chat' },
    { href: '/advanced', label: 'Advanced', icon: 'advanced' },
    { href: '/admin', label: 'Admin', icon: 'admin' },
  ] as const;

  const pathname = $derived(page.url?.pathname ?? '');
  // A destination is active for its exact path or any sub-route (e.g.
  // /admin/endpoints highlights Admin).
  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(href + '/');
  }

  let mobileMenuOpen = $state(false);
  // Track the hamburger button element so we can return focus to it on close.
  let hamburgerBtn: HTMLButtonElement | undefined = $state();
  // Track the close button for focus-on-open.
  let closeBtn: HTMLButtonElement | undefined = $state();
  // The drawer element itself for focus-trap sentinel logic.
  let drawerEl: HTMLDivElement | undefined = $state();

  function closeMobileMenu(): void {
    mobileMenuOpen = false;
  }

  function toggleMobileMenu(): void {
    mobileMenuOpen = !mobileMenuOpen;
  }

  // Close drawer and return focus to trigger.
  function closeAndReturn(): void {
    mobileMenuOpen = false;
    hamburgerBtn?.focus();
  }

  // Close drawer on nav link click (also returns focus via navigation).
  function navLinkClick(): void {
    mobileMenuOpen = false;
  }

  // Focus trap: redirect Tab / Shift+Tab that would escape the drawer.
  // Escape handling strategy (popover-API-aware):
  //   - When a popover child (EndpointSwitcher, SessionPicker menu) is open,
  //     the browser fires its own Escape handler to close the popover before
  //     this keydown event fires (popovers are top-layer; their Escape is
  //     processed at the UA level). By the time this handler runs the popover
  //     is already hidden, but we still check for any remaining open popovers
  //     inside the drawer. If one is open, we let the UA handle it and do NOT
  //     also close the drawer — producing the two-step "1st Escape = close
  //     dropdown, 2nd Escape = close drawer" UX.
  function handleDrawerKeyDown(ev: KeyboardEvent): void {
    if (!drawerEl) return;
    if (ev.key === 'Escape') {
      const openPopover = drawerEl.querySelector(':popover-open');
      if (openPopover) return;
      ev.preventDefault();
      ev.stopPropagation();
      closeAndReturn();
      return;
    }
    if (ev.key !== 'Tab') return;

    const focusable = Array.from(
      drawerEl.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.hasAttribute('disabled'));

    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (ev.shiftKey) {
      if (document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  }

  // Move focus into drawer when it opens (mobile only — the element is always
  // in the DOM, so we gate on mobileMenuOpen state).
  $effect(() => {
    if (mobileMenuOpen && closeBtn) {
      const id = requestAnimationFrame(() => {
        closeBtn?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  });
</script>

<header class="navbar">
  <div class="navbar-inner">
    <!-- Brand: logo + name + version. Name/version collapse on narrow widths. -->
    <div class="navbar-brand">
      <span class="brand-icon" aria-hidden="true">
        <img src="/logo-128.png" alt="OpenPalm Logo">
      </span>
      <span class="brand-text">OpenPalm</span>
      <span class="version-badge">ui v{uiVersion}</span>
    </div>

    <!-- Primary destination tabs: always visible at all widths. -->
    <nav class="navbar-nav" aria-label="Primary navigation">
      {#each NAV_ITEMS as item (item.href)}
        <a
          href={item.href}
          class="nav-tab"
          class:active={isActive(item.href)}
          aria-current={isActive(item.href) ? 'page' : undefined}
          onclick={mobileMenuOpen ? navLinkClick : undefined}
        >
          {#if item.icon === 'chat'}
            <!-- message-square (Lucide) -->
            <svg class="nav-icon" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          {:else if item.icon === 'advanced'}
            <!-- terminal-square -->
            <svg class="nav-icon" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="m7 9 3 3-3 3"/><line x1="13" y1="15" x2="17" y2="15"/>
            </svg>
          {:else}
            <!-- sliders -->
            <svg class="nav-icon" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
              <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
              <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
              <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/>
              <line x1="17" y1="16" x2="23" y2="16"/>
            </svg>
          {/if}
          <span class="nav-label">{item.label}</span>
        </a>
      {/each}
    </nav>

    <!-- Actions: single container, always in the DOM.
         On desktop (>768px): inline flex row in the navbar.
         On mobile (≤768px): off-canvas drawer, slides in when .open.
         The drawer header (title + close btn) is always present but hidden
         via CSS at desktop widths. -->
    <div
      id="navbar-drawer"
      class="navbar-actions"
      class:open={mobileMenuOpen}
      role={mobileMenuOpen ? 'dialog' : undefined}
      aria-modal={mobileMenuOpen ? 'true' : undefined}
      aria-labelledby={mobileMenuOpen ? 'navbar-drawer-title' : undefined}
      bind:this={drawerEl}
      onkeydown={mobileMenuOpen ? handleDrawerKeyDown : undefined}
    >
      <!-- Drawer header: only meaningful (and focused) at mobile widths. -->
      <div class="drawer-header">
        <h2 class="drawer-title" id="navbar-drawer-title">Settings</h2>
        <button
          type="button"
          class="drawer-close"
          bind:this={closeBtn}
          onclick={closeAndReturn}
          aria-label="Close settings menu"
          tabindex={mobileMenuOpen ? 0 : -1}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M18 6 6 18"></path>
            <path d="m6 6 12 12"></path>
          </svg>
        </button>
      </div>

      <!-- Drawer body: sections on mobile, plain row on desktop. -->
      <div class="drawer-body">
        <!-- Endpoint selector -->
        <div class="drawer-section">
          <div class="section-label">Endpoint</div>
          <div class="control-row">
            <EndpointSwitcher />
          </div>
        </div>

        <!-- Session picker -->
        <div class="drawer-section">
          <div class="section-label">Session</div>
          <div class="control-row control-row--picker">
            <SessionPicker />
          </div>
        </div>

        <!-- Voice controls -->
        <div class="drawer-section">
          <div class="section-label">Voice</div>
          <div class="control-row control-row--voice">
            <VoiceControl />
          </div>
        </div>

        <!-- Theme toggle -->
        <div class="drawer-section">
          <div class="utility-row">
            <div class="utility-labels">
              <span class="utility-title">Theme</span>
              <span class="utility-copy">Switch between light and dark mode.</span>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </div>

    <!-- Hamburger: appears at ≤768px. -->
    <button
      type="button"
      class="mobile-menu-btn"
      bind:this={hamburgerBtn}
      onclick={toggleMobileMenu}
      aria-label={mobileMenuOpen ? 'Close menu' : 'Open settings menu'}
      aria-expanded={mobileMenuOpen}
      aria-controls="navbar-drawer"
      aria-haspopup="dialog"
    >
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        {#if mobileMenuOpen}
          <path d="M18 6 6 18"></path>
          <path d="m6 6 12 12"></path>
        {:else}
          <path d="M3 6h18"></path>
          <path d="M3 12h18"></path>
          <path d="M3 18h18"></path>
        {/if}
      </svg>
    </button>

    <!-- Overlay: lives INSIDE .navbar-inner so it shares the drawer's stacking
         context. With z-index 299 (overlay) < 300 (drawer) the drawer sits
         above the backdrop and its controls stay clickable; both sit above the
         page content (the navbar establishes the z:50 context). Rendering it
         outside the navbar would put it in the root context, painting OVER the
         navbar-confined drawer and swallowing its clicks. Tap to close. -->
    {#if mobileMenuOpen}
      <div
        class="drawer-overlay"
        onclick={closeAndReturn}
        aria-hidden="true"
      ></div>
    {/if}
  </div>
</header>

<style>
  /* ── Navbar shell ──────────────────────────────────────────────────── */
  .navbar {
    position: sticky;
    top: 0;
    z-index: 50;
    background: var(--color-navbar-bg);
    border-bottom: 1px solid var(--color-border);
    /*
     * The blur lives on ::before, NOT on .navbar. backdrop-filter on .navbar
     * itself would make it a containing block for the position:fixed mobile
     * drawer (.navbar-actions) — the drawer would then anchor to the 56px-tall
     * navbar instead of the viewport. Moving the filter to a pseudo-element
     * keeps the blur while leaving the drawer viewport-fixed.
     */
  }
  .navbar::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    backdrop-filter: blur(12px);
    pointer-events: none;
  }

  /*
   * Three-zone grid at ≤640px (logo | nav-tabs | hamburger) — eliminates the
   * flex-fight that caused the two margin-left:auto conflict.
   * Desktop keeps flexbox because it works fine there.
   */
  .navbar-inner {
    width: 100%;
    padding: 0 var(--space-6);
    height: var(--nav-height);
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  /* ── Brand ─────────────────────────────────────────────────────────── */
  .navbar-brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
    min-width: 34px;
  }

  .brand-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    flex-shrink: 0;
  }

  .brand-icon img {
    max-width: 34px;
    display: block;
  }

  .brand-text {
    font-size: var(--text-lg);
    font-weight: var(--font-bold);
    color: var(--color-text);
    letter-spacing: -0.01em;
    white-space: nowrap;
  }

  .version-badge {
    font-size: 0.625rem;
    font-weight: var(--font-medium);
    font-family: var(--font-mono);
    color: var(--color-text-tertiary);
    background: var(--color-bg-tertiary);
    padding: 2px 8px;
    border-radius: var(--radius-full);
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  /* ── Primary nav tabs ──────────────────────────────────────────────── */
  .navbar-nav {
    display: flex;
    align-items: stretch;
    gap: 0;
    flex: 1;
    justify-content: flex-start;
    height: var(--nav-height);
  }

  .nav-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    height: 32px;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    margin: auto var(--space-1);
    background: transparent;
    transition: color var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast);
  }

  .nav-tab:hover {
    color: var(--color-text);
    background: var(--color-surface-hover);
  }

  .nav-tab:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .nav-tab.active {
    color: var(--color-primary);
    background: var(--color-bg-tertiary);
    border-color: var(--color-border);
  }

  .nav-icon {
    flex-shrink: 0;
  }

  /* ── Actions / Drawer ──────────────────────────────────────────────── */
  /*
   * Desktop (>768px): plain inline flex row pushed to the right.
   * The drawer-header is hidden; the drawer-body is a flat flex row.
   */
  .navbar-actions {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    margin-left: auto;
  }

  .drawer-header {
    /* Hidden on desktop — only shown inside the mobile drawer. */
    display: none;
  }

  .drawer-body {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* On desktop the section structure is invisible — each .drawer-section is
     just a flex item containing the control. Labels + utility chrome are
     hidden via CSS. */
  .drawer-section {
    display: contents;
  }

  .section-label,
  .utility-labels {
    display: none;
  }

  .utility-row {
    display: contents;
  }

  /* ── Hamburger ─────────────────────────────────────────────────────── */
  .mobile-menu-btn {
    /* Hidden by default; visible at ≤768px. */
    display: none;
    align-items: center;
    justify-content: center;
    /* Minimum 44×44 touch target per WCAG 2.5.5. */
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
    flex-shrink: 0;
  }

  .mobile-menu-btn:hover {
    color: var(--color-text);
    background: var(--color-surface-hover);
    border-color: var(--color-border-hover);
  }

  .mobile-menu-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  /* ── Drawer overlay ────────────────────────────────────────────────── */
  .drawer-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 299;
  }

  /* ── Responsive breakpoints ────────────────────────────────────────── */

  @media (max-width: 768px) {
    .navbar-inner {
      padding: 0 var(--space-4);
    }

    .version-badge {
      display: none;
    }

    /* Hamburger appears. */
    .mobile-menu-btn {
      display: inline-flex;
    }

    /*
     * Mobile drawer: ONE geometry for all mobile widths — a bottom sheet that
     * slides up from the bottom. Always in the DOM; translateY moves it
     * off-screen and `.open` slides it in via a CSS transition. Using physical
     * top/bottom (not the inset-block shorthand) keeps the anchor unambiguous.
     */
    .navbar-actions {
      margin-left: 0;
      position: fixed;
      inset-inline: 0;      /* left:0; right:0 */
      top: auto;
      bottom: 0;
      width: 100%;
      height: auto;
      max-height: min(480px, 80dvh);
      background: var(--color-surface);
      border-top: 1px solid var(--color-border);
      border-radius: 16px 16px 0 0;
      box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.12);
      display: flex;
      flex-direction: column;
      overflow: visible;
      z-index: 300;
      /* Slide off-screen below by default. */
      transform: translateY(100%);
      transition: transform 250ms ease;
    }

    .navbar-actions.open {
      transform: translateY(0);
    }

    @media (prefers-reduced-motion: reduce) {
      .navbar-actions {
        transition: none;
      }
    }

    /* Drawer header visible on mobile. */
    .drawer-header {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-4) var(--space-5);
      border-bottom: 1px solid var(--color-border);
      flex-shrink: 0;
    }

    .drawer-title {
      flex: 1;
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
      color: var(--color-text);
    }

    .drawer-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
      min-height: 44px;
      padding: 0;
      background: none;
      border: none;
      color: var(--color-text-secondary);
      border-radius: var(--radius-sm);
      cursor: pointer;
    }

    .drawer-close:hover {
      background: var(--color-bg-secondary);
      color: var(--color-text);
    }

    .drawer-close:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }

    /* Drawer body scrolls vertically; overflow:visible on the outer container
       lets popover menus escape clipping. */
    .drawer-body {
      flex: 1;
      overflow-y: auto;
      overflow-x: visible;
      padding: var(--space-4) var(--space-5);
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    /* Each section is a labelled block. */
    .drawer-section {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-4) 0;
      border-top: 1px solid var(--color-border);
      overflow: visible;
    }

    .drawer-section:first-child {
      border-top: none;
      padding-top: 0;
    }

    .section-label {
      display: block;
      font-size: var(--text-xs);
      font-weight: var(--font-semibold);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--color-text-secondary);
    }

    /* Full-width trigger inside the drawer. */
    .control-row {
      width: 100%;
      overflow: visible;
    }

    .control-row :global(.trigger) {
      width: 100%;
      max-width: none;
      height: 44px;
      justify-content: flex-start;
      padding: 0 var(--space-3);
    }

    /* Show label/dot/caret inside the drawer. */
    .control-row :global(.trigger .label),
    .control-row :global(.trigger .dot),
    .control-row :global(.trigger .caret),
    .control-row :global(.trigger .trigger-icon) {
      display: inline-flex;
    }

    .control-row--voice :global(.voice-control) {
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    /* Theme utility row. */
    .utility-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-bg-tertiary);
    }

    .utility-labels {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      min-width: 0;
    }

    .utility-title {
      color: var(--color-text);
      font-size: var(--text-sm);
      font-weight: var(--font-medium);
    }

    .utility-copy {
      color: var(--color-text-secondary);
      font-size: var(--text-xs);
    }
  }

  /* Mobile (≤640px): grid layout + tab-style nav + bottom sheet. */
  @media (max-width: 640px) {
    .navbar-inner {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: var(--space-2);
      padding: 0 var(--space-4);
    }

    .brand-text {
      display: none;
    }

    .navbar-nav {
      justify-content: center;
      flex: unset;
      height: var(--nav-height);
    }

    .nav-tab {
      background: transparent;
      border: none;
      border-radius: 0;
      margin: 0;
      height: var(--nav-height);
      padding: 0 var(--space-2);
      padding-bottom: 2px;
      border-bottom: 2px solid transparent;
      font-size: var(--text-sm);
      color: var(--color-text-secondary);
      transition: color var(--transition-fast), border-color var(--transition-fast);
    }

    .nav-tab:hover {
      background: transparent;
      color: var(--color-text);
    }

    .nav-tab.active {
      background: transparent;
      border-color: var(--color-primary);
      color: var(--color-primary);
    }

    /* Hamburger is the last grid column; no margin-left needed. */
    .mobile-menu-btn {
      margin-left: 0;
    }
    /* Drawer geometry is the single bottom-sheet defined in the ≤768px block;
       no separate override needed here. */
  }

  /* Narrow phones (≤400px): abbreviate labels to icon+short-label. */
  @media (max-width: 400px) {
    .nav-tab {
      padding: 0 var(--space-1);
      font-size: var(--text-xs);
    }

    .navbar-inner {
      padding: 0 var(--space-3);
    }
  }

  /* Icon-only breakpoint at ≤340px. */
  @media (max-width: 340px) {
    .nav-label {
      display: none;
    }
  }
</style>
