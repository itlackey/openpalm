<script lang="ts">
  import { version } from '$app/environment';
  import { page } from '$app/state';
  import VoiceControl from './VoiceControl.svelte';
  import EndpointSwitcher from './EndpointSwitcher.svelte';
  import SessionPicker from './SessionPicker.svelte';

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
</script>

<nav class="navbar" aria-label="Main navigation">
  <div class="navbar-inner">
    <div class="navbar-brand">
      <span class="brand-icon">
        <img src="/logo-128.png" alt="OpenPalm Logo">
      </span>
      <div>
      <span class="brand-text">OpenPalm</span>
      <span class="version-badge">v{version}</span>
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
      <EndpointSwitcher />
      <SessionPicker />
      <VoiceControl />
    </div>
  </div>
</nav>

<style>
  .navbar {
    position: sticky;
    top: 0;
    z-index: 50;
    background: rgba(255, 255, 255, 0.85);
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
    /* Collapse nav buttons to icon-only to keep the toolbar on one line. */
    .nav-label {
      display: none;
    }
    .nav-btn {
      padding: 0 var(--space-2);
    }
  }

  @media (max-width: 480px) {
    .version-badge {
      display: none;
    }

    .brand-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  /* Narrow Electron sidecar widths — drop the brand text so the action
     icons keep their space. The logo + version badge already collapsed
     above; this hides the wordmark too. */
  @media (max-width: 360px) {
    .brand-text {
      display: none;
    }
    .navbar-inner {
      padding: 0 var(--space-3);
    }
  }
</style>
