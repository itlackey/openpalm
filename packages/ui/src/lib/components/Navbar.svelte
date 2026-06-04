<script lang="ts">
  import { onMount } from 'svelte';
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

  function closeMobileMenu(): void {
    mobileMenuOpen = false;
  }

  function toggleMobileMenu(): void {
    mobileMenuOpen = !mobileMenuOpen;
  }

  onMount(() => {
    function handleKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape' && mobileMenuOpen) {
        mobileMenuOpen = false;
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  });
</script>

<nav class="navbar" aria-label="Main navigation">
  <div class="navbar-inner">
    <div class="navbar-brand">
      <span class="brand-icon">
        <img src="/logo-128.png" alt="OpenPalm Logo">
      </span>
      <div>
      <span class="brand-text">OpenPalm</span>
      <span class="version-badge">ui v{uiVersion}</span>
      </div>
    </div>

    <div class="navbar-nav" aria-label="Primary navigation">
      {#each NAV_ITEMS as item (item.href)}
        <a
          href={item.href}
          class="nav-btn"
          class:active={isActive(item.href)}
          aria-current={isActive(item.href) ? 'page' : undefined}
          title={item.label}
        >
          {#if item.icon === 'chat'}
            <!-- message-square (Lucide) -->
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          {:else if item.icon === 'advanced'}
            <!-- terminal-square (embedded OpenCode) -->
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="m7 9 3 3-3 3"/><line x1="13" y1="15" x2="17" y2="15"/>
            </svg>
          {:else}
            <!-- sliders (Lucide) -->
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
    </div>

    <div class="navbar-actions">
      <div class="desktop-actions">
        <ThemeToggle />
        <EndpointSwitcher />
        <SessionPicker />
        <VoiceControl />
      </div>

      <button
        type="button"
        class="mobile-menu-btn"
        onclick={toggleMobileMenu}
        aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={mobileMenuOpen}
        aria-controls="mobile-navbar-drawer"
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
        <span class="mobile-menu-label">Menu</span>
      </button>
    </div>
  </div>
</nav>

{#if mobileMenuOpen}
  <div class="sheet-overlay mobile-sheet-overlay" onclick={closeMobileMenu} role="presentation"></div>
  <div
    id="mobile-navbar-drawer"
    class="sheet mobile-sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="mobile-navbar-title"
  >
    <header class="sheet-header">
      <h2 class="sheet-title" id="mobile-navbar-title">OpenPalm Menu</h2>
      <button type="button" class="sheet-close" onclick={closeMobileMenu} aria-label="Close menu">×</button>
    </header>

    <div class="sheet-body mobile-sheet-body">
      <section class="mobile-sheet-section">
        <div class="mobile-section-label">Navigate</div>
        <div class="mobile-nav-list">
          {#each NAV_ITEMS.filter((item) => item.href !== '/chat') as item (item.href)}
            <a
              href={item.href}
              class="mobile-nav-link"
              class:active={isActive(item.href)}
              aria-current={isActive(item.href) ? 'page' : undefined}
              onclick={closeMobileMenu}
            >
              {item.label}
            </a>
          {/each}
        </div>
      </section>

      <section class="mobile-sheet-section">
        <div class="mobile-section-label">Conversation</div>
        <div class="mobile-control-row">
          <SessionPicker />
        </div>
        <div class="mobile-control-row">
          <EndpointSwitcher />
        </div>
      </section>

      <section class="mobile-sheet-section">
        <div class="mobile-section-label">Controls</div>
        <div class="mobile-utility-row">
          <div class="mobile-utility-labels">
            <span class="mobile-utility-title">Theme</span>
            <span class="mobile-utility-copy">Switch between light and dark mode.</span>
          </div>
          <ThemeToggle />
        </div>
        <div class="mobile-control-row mobile-control-row--voice">
          <VoiceControl />
        </div>
      </section>
    </div>
  </div>
{/if}

<style>
  .navbar {
    position: sticky;
    top: 0;
    z-index: 50;
    background: var(--color-navbar-bg);
    border-bottom: 1px solid var(--color-border);
    backdrop-filter: blur(12px);
  }

  .navbar-inner {
    /* Full viewport width — the toolbar spans edge to edge. */
    width: 100%;
    padding: 0 var(--space-6);
    height: var(--nav-height);
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  /* Brand pinned left; the primary nav sits next to it; actions pushed right. */
  .navbar-brand {
    margin-right: var(--space-2);
  }
  .navbar-actions {
    margin-left: auto;
  }

  .navbar-brand {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }

  .brand-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    img{
      max-width: 34px;
    }
  }

  .brand-text {
    font-size: var(--text-lg);
    font-weight: var(--font-bold);
    color: var(--color-text);
    letter-spacing: -0.01em;
  }

  .navbar-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .version-badge {
    font-size: calc(var(--text-xs) - 2.5pt);
    font-weight: var(--font-medium);
    font-family: var(--font-mono);
    color: var(--color-text-tertiary);
    background: var(--color-bg-tertiary);
    padding: 2px 8px;
    border-radius: var(--radius-full);
    letter-spacing: 0.02em;
  }

  /* Primary nav group (Chat / Advanced / Admin). */
  .navbar-nav {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .desktop-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .mobile-menu-btn {
    display: none;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    height: 32px;
    padding: 0 var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }

  .mobile-menu-btn:hover {
    color: var(--color-text);
    background: var(--color-surface-hover);
    border-color: var(--color-border-hover);
  }

  .mobile-menu-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .mobile-sheet-overlay {
    z-index: 299;
  }

  .mobile-sheet {
    z-index: 300;
    width: min(420px, 100vw);
  }

  .mobile-sheet-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .mobile-sheet-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .mobile-section-label {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
  }

  .mobile-nav-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .mobile-nav-link {
    display: flex;
    align-items: center;
    min-height: 40px;
    padding: 0 var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    background: var(--color-surface);
    text-decoration: none;
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
  }

  .mobile-nav-link.active {
    color: var(--color-primary);
    border-color: var(--color-border);
    background: var(--color-bg-tertiary);
  }

  .mobile-control-row {
    width: 100%;
  }

  .mobile-control-row :global(.trigger) {
    width: 100%;
    max-width: none;
    justify-content: flex-start;
  }

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
    background: var(--color-surface);
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

  /* Pill nav button — icon + label, active state highlighted. */
  .nav-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: 32px;
    padding: 0 var(--space-3);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    cursor: pointer;
    transition: all var(--transition-fast);
    text-decoration: none;
    white-space: nowrap;
  }

  .nav-btn:hover {
    color: var(--color-text);
    background: var(--color-surface-hover);
  }

  .nav-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .nav-btn.active {
    color: var(--color-primary);
    background: var(--color-bg-tertiary);
    border-color: var(--color-border);
  }

  @media (max-width: 768px) {
    .navbar-inner {
      padding: 0 var(--space-4);
    }
  }

  @media (max-width: 600px) {
    .navbar-inner {
      gap: var(--space-2);
    }

    .navbar-actions {
      gap: var(--space-1);
    }

    .desktop-actions {
      display: none;
    }

    .mobile-menu-btn {
      display: inline-flex;
    }

    .nav-label {
      display: inline;
    }

    .navbar-nav {
      margin-left: auto;
      margin-right: var(--space-1);
    }

    .navbar-nav :global(a:not([href='/chat'])) {
      display: none;
    }
  }

  @media (max-width: 480px) {
    .version-badge {
      display: none;
    }

    .brand-text {
      display: none;
    }
  }

  /* Narrow Electron sidecar widths — drop the brand text so the action
   icons keep their space. The logo + version badge already collapsed
   above; this hides the wordmark too. */
  @media (max-width: 360px) {
    .navbar-actions {
      gap: 4px;
    }

    .mobile-menu-label {
      display: none;
    }

    .mobile-menu-btn {
      width: 32px;
      padding: 0;
      gap: 0;
    }

    .navbar-inner {
      padding: 0 var(--space-3);
    }
  }
</style>
