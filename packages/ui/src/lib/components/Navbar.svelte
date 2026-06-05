<script lang="ts">
  import { fly, fade } from 'svelte/transition';
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
  // The sheet element itself for focus-trap sentinel logic.
  let sheetEl: HTMLDivElement | undefined = $state();

  // Detect reduced-motion preference for transition parameters.
  // Safe to evaluate immediately on the client; SSR returns false (no animation).
  function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
  }

  // Returns fly params appropriate for the current viewport:
  // - ≤640px → slide up from below (bottom sheet): y must exceed max-height
  //             (min(480px, 80dvh)), so 600 is safely off-screen. opacity:0
  //             so no visible stub at the transition start frame.
  // - >640px  → slide in from the right (drawer): x must exceed width
  //             (min(420px, 100vw)), so 500 is safely off-screen. opacity:0.
  // Reduced-motion: short fade only — no distance, no visible stub.
  function sheetFlyParams() {
    const reduced = prefersReducedMotion();
    const isBottomSheet = typeof window !== 'undefined' && window.innerWidth <= 640;
    if (reduced) return { duration: 80, x: 0, y: 0, opacity: 0 };
    if (isBottomSheet) return { duration: 250, x: 0, y: 600, opacity: 0 };
    return { duration: 250, x: 500, y: 0, opacity: 0 };
  }

  function closeMobileMenu(): void {
    mobileMenuOpen = false;
  }

  function toggleMobileMenu(): void {
    mobileMenuOpen = !mobileMenuOpen;
  }

  // Close sheet and return focus to trigger.
  function closeAndReturn(): void {
    mobileMenuOpen = false;
    hamburgerBtn?.focus();
  }

  // Close sheet on nav link click (also returns focus via navigation).
  function navLinkClick(): void {
    mobileMenuOpen = false;
  }

  // Focus trap: redirect Tab / Shift+Tab that would escape the sheet.
  // Escape handling strategy (popover-API-aware):
  //   - When a popover child (EndpointSwitcher, SessionPicker menu) is open,
  //     the browser fires its own Escape handler to close the popover before
  //     this keydown event fires (popovers are top-layer; their Escape is
  //     processed at the UA level). By the time this handler runs the popover
  //     is already hidden, but we still check for any remaining open popovers
  //     inside the sheet. If one is open, we let the UA handle it and do NOT
  //     also close the sheet — producing the two-step "1st Escape = close
  //     dropdown, 2nd Escape = close sheet" UX.
  //   - stopPropagation() prevents any document-level Escape listeners from
  //     also firing (there are none currently, but this is defensive).
  function handleSheetKeyDown(ev: KeyboardEvent): void {
    if (!sheetEl) return;
    if (ev.key === 'Escape') {
      // If any popover inside the sheet is still open, the browser will close
      // it via its own native handler. Don't also close the sheet this press.
      const openPopover = sheetEl.querySelector(':popover-open');
      if (openPopover) return;
      ev.preventDefault();
      ev.stopPropagation();
      closeAndReturn();
      return;
    }
    if (ev.key !== 'Tab') return;

    const focusable = Array.from(
      sheetEl.querySelectorAll<HTMLElement>(
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

  // Move focus into sheet when it opens.
  $effect(() => {
    if (mobileMenuOpen && closeBtn) {
      // Defer one frame so the DOM is painted before we attempt focus.
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

    <!-- Actions: all controls inline on desktop (>768px); all move into the
         sheet at ≤768px for a consistent single collapse boundary. -->
    <div class="navbar-actions">
      <!-- Desktop only: inline action controls. -->
      <div class="desktop-actions">
        <ThemeToggle />
        <EndpointSwitcher />
        <SessionPicker />
        <VoiceControl />
      </div>

      <!-- Hamburger: appears at ≤768px. -->
      <button
        type="button"
        class="mobile-menu-btn"
        bind:this={hamburgerBtn}
        onclick={toggleMobileMenu}
        aria-label={mobileMenuOpen ? 'Close menu' : 'Open settings menu'}
        aria-expanded={mobileMenuOpen}
        aria-controls="mobile-navbar-drawer"
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
    </div>
  </div>
</header>

{#if mobileMenuOpen}
  <!-- Overlay: tap to close. Fades in via transition:fade. -->
  <div
    class="sheet-overlay mobile-sheet-overlay"
    onclick={closeAndReturn}
    aria-hidden="true"
    transition:fade={{ duration: prefersReducedMotion() ? 80 : 200 }}
  ></div>

  <!-- Controls sheet: bottom sheet on ≤640px, right drawer on ≥641px.
       transition:fly params are computed at mount time to pick the correct
       axis (x for right-drawer, y for bottom-sheet). -->
  <div
    id="mobile-navbar-drawer"
    class="mobile-sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="mobile-navbar-title"
    tabindex="-1"
    bind:this={sheetEl}
    onkeydown={handleSheetKeyDown}
    transition:fly={sheetFlyParams()}
  >
    <header class="sheet-header">
      <h2 class="sheet-title" id="mobile-navbar-title">Settings</h2>
      <button
        type="button"
        class="sheet-close"
        bind:this={closeBtn}
        onclick={closeAndReturn}
        aria-label="Close settings menu"
      >
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18"></path>
          <path d="m6 6 12 12"></path>
        </svg>
      </button>
    </header>

    <div class="sheet-body mobile-sheet-body">
      <!-- Endpoint selector: full-width in sheet. -->
      <section class="mobile-sheet-section">
        <div class="mobile-section-label">Endpoint</div>
        <div class="mobile-control-row">
          <EndpointSwitcher />
        </div>
      </section>

      <!-- Session picker: full-width in sheet. -->
      <section class="mobile-sheet-section">
        <div class="mobile-section-label">Session</div>
        <div class="mobile-control-row mobile-control-row--picker">
          <SessionPicker />
        </div>
      </section>

      <!-- Voice controls. -->
      <section class="mobile-sheet-section">
        <div class="mobile-section-label">Voice</div>
        <div class="mobile-control-row mobile-control-row--voice">
          <VoiceControl />
        </div>
      </section>

      <!-- Theme toggle. -->
      <section class="mobile-sheet-section">
        <div class="mobile-utility-row">
          <div class="mobile-utility-labels">
            <span class="mobile-utility-title">Theme</span>
            <span class="mobile-utility-copy">Switch between light and dark mode.</span>
          </div>
          <ThemeToggle />
        </div>
      </section>
    </div>
  </div>
{/if}

<style>
  /* ── Navbar shell ──────────────────────────────────────────────────── */
  .navbar {
    position: sticky;
    top: 0;
    z-index: 50;
    background: var(--color-navbar-bg);
    border-bottom: 1px solid var(--color-border);
    backdrop-filter: blur(12px);
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
    /* Reserve the exact logo width so the grid doesn't collapse. */
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

  /* rem-only font size: 0.625rem ≈ 10px, smaller than --text-xs (0.75rem). */
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
    /* Let the nav expand to fill available space in the flex row. */
    flex: 1;
    /* On desktop, left-align the tabs (brand is already left). */
    justify-content: flex-start;
    /* Clip height to match the navbar exactly. */
    height: var(--nav-height);
  }

  /*
   * Tab-style nav link: pill look on desktop, underline-active on mobile.
   * The class always uses .nav-tab; responsive CSS changes its appearance.
   */
  .nav-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    /* Pill sits vertically centered, not full navbar height. */
    height: 32px;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    /* Desktop: pill background via border/bg; no border-bottom indicator. */
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    /* Use margin to create visual spacing without affecting grid/flex sizing. */
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

  /* The SVG icon inside a tab. */
  .nav-icon {
    flex-shrink: 0;
  }

  /* ── Action row ────────────────────────────────────────────────────── */
  .navbar-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
    margin-left: auto;
  }

  .desktop-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
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

  /* ── Mobile sheet overlay ──────────────────────────────────────────── */
  /* transition:fade is applied via the Svelte directive; no CSS transition needed. */
  .sheet-overlay.mobile-sheet-overlay {
    z-index: 299;
  }

  /* ── Mobile sheet ──────────────────────────────────────────────────── */
  /*
   * EndpointSwitcher/SessionPicker render their dropdowns with the native
   * Popover API (top layer) + CSS anchor positioning, so they escape any
   * clipping ancestor with zero JS and don't depend on overflow here. The
   * sheet body scrolls vertically.
   */
  .mobile-sheet {
    position: fixed;
    /* Right-side drawer by default (≥641px). */
    inset-block: 0;
    inset-inline-end: 0;
    width: min(420px, 100vw);
    background: var(--color-surface);
    border-inline-start: 1px solid var(--color-border);
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.12);
    display: flex;
    flex-direction: column;
    /* overflow:visible here lets dropdown menus escape the sheet boundaries. */
    overflow: visible;
    z-index: 300;
  }

  .sheet-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .sheet-title {
    flex: 1;
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .sheet-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* 44×44 touch target. */
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    background: none;
    border: none;
    color: var(--color-text-secondary);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .sheet-close:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .sheet-close:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  /* ── Sheet body ────────────────────────────────────────────────────── */
  /* Scoped scroll: only the body scrolls, keeping overflow:visible on the
     outer .mobile-sheet so dropdown menus can escape it. */
  .mobile-sheet-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: visible;
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .mobile-sheet-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) 0;
    border-top: 1px solid var(--color-border);
    /* Allow children (dropdowns) to overflow the section. */
    overflow: visible;
  }

  .mobile-sheet-section:first-child {
    border-top: none;
    padding-top: 0;
  }

  .mobile-section-label {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
  }

  /* Full-width trigger inside the sheet. */
  .mobile-control-row {
    width: 100%;
    /* Allow dropdown menus to overflow out of the row. */
    overflow: visible;
  }

  /*
   * Override trigger sizing so EndpointSwitcher / SessionPicker
   * render as full-width 44px buttons inside the sheet.
   */
  .mobile-control-row :global(.trigger) {
    width: 100%;
    max-width: none;
    height: 44px;
    justify-content: flex-start;
    padding: 0 var(--space-3);
  }

  /* Show the label/dot/caret inside the sheet even at narrow widths. */
  .mobile-control-row :global(.trigger .label),
  .mobile-control-row :global(.trigger .dot),
  .mobile-control-row :global(.trigger .caret),
  .mobile-control-row :global(.trigger .trigger-icon) {
    display: inline-flex;
  }

  /*
   * Dropdown menus from EndpointSwitcher/SessionPicker are now position:fixed
   * with z-index:400 — they escape the sheet's overflow context entirely.
   * No overflow or z-index overrides needed here.
   */

  .mobile-control-row--voice :global(.voice-control) {
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .mobile-utility-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-tertiary);
  }

  .mobile-utility-labels {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .mobile-utility-title {
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
  }

  .mobile-utility-copy {
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }

  /* ── Responsive breakpoints ────────────────────────────────────────── */

  /*
   * Single consistent collapse boundary at ≤768px: ALL controls
   * (Endpoint/Session/Voice/Theme) move into the sheet.
   * This eliminates the asymmetric 641–767px range where only Voice was hidden.
   */
  @media (max-width: 768px) {
    .navbar-inner {
      padding: 0 var(--space-4);
    }

    .version-badge {
      display: none;
    }

    /* All desktop action controls move to the sheet. */
    .desktop-actions {
      display: none;
    }

    /* Hamburger appears. */
    .mobile-menu-btn {
      display: inline-flex;
    }
  }

  /* Mobile (≤640px): grid layout + tab-style nav + bottom sheet. */
  @media (max-width: 640px) {
    .navbar-inner {
      /*
       * Three-zone grid: [logo] [nav tabs] [hamburger].
       * This eliminates the flex margin-left:auto fighting.
       */
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: var(--space-2);
      padding: 0 var(--space-4);
    }

    /* Brand: icon only, centered in its column. */
    .brand-text {
      display: none;
    }

    /* Nav tabs: center within the 1fr middle column. */
    .navbar-nav {
      justify-content: center;
      flex: unset; /* flex:1 is irrelevant inside grid child */
      height: var(--nav-height);
    }

    /*
     * Tab-style at mobile: underline active indicator, no pill background.
     * This costs less horizontal space than pill buttons.
     */
    .nav-tab {
      /* Remove pill styling. */
      background: transparent;
      border: none;
      border-radius: 0;
      margin: 0;
      /* Full navbar height so border-bottom is flush with the bottom edge. */
      height: var(--nav-height);
      padding: 0 var(--space-2);
      padding-bottom: 2px; /* account for 2px active border */
      /* Underline active indicator. */
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

    /* Actions column: just the hamburger. */
    .navbar-actions {
      margin-left: 0; /* grid handles alignment */
    }

    /* Bottom sheet at ≤640px: slide up from the bottom. */
    .mobile-sheet {
      inset-inline: 0;
      inset-block-end: 0;
      inset-block-start: auto;
      inset-inline-end: unset;
      width: 100%;
      max-height: min(480px, 80dvh);
      border-inline-start: none;
      border-top: 1px solid var(--color-border);
      border-radius: 16px 16px 0 0;
      box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.12);
    }
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

  /*
   * Icon-only breakpoint at ≤340px: comfortable margin above the ~320px
   * point where labels start to overflow the tab row.
   */
  @media (max-width: 340px) {
    .nav-label {
      display: none;
    }
  }
</style>
