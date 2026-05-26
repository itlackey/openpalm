<script lang="ts">
  import { version } from '$app/environment';
  import VoiceControl from './VoiceControl.svelte';
  import EndpointSwitcher from './EndpointSwitcher.svelte';
  import SessionPicker from './SessionPicker.svelte';

  interface Props {
    navLink?: { href: string; label: string };
  }

  let { navLink }: Props = $props();

  // Match navLink.href to an icon. Anything else falls back to the
  // back-arrow so adding a new contextual destination doesn't crash.
  const navIcon = $derived(navLink?.href === '/chat' ? 'chat' : navLink?.href === '/admin' ? 'admin' : 'back');
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
    <div class="navbar-actions">
      {#if navLink}
        <a
          href={navLink.href}
          class="icon-btn"
          aria-label={navLink.label}
          title={navLink.label}
        >
          {#if navIcon === 'chat'}
            <!-- message-square (Lucide) -->
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          {:else if navIcon === 'admin'}
            <!-- sliders (Lucide) -->
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
              <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
              <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
              <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/>
              <line x1="17" y1="16" x2="23" y2="16"/>
            </svg>
          {:else}
            <!-- arrow-left (Lucide) -->
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
            </svg>
          {/if}
        </a>
      {/if}
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
    max-width: var(--max-width);
    margin: 0 auto;
    padding: 0 var(--space-6);
    height: var(--nav-height);
    display: flex;
    align-items: center;
    justify-content: space-between;
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

  /* Icon button — matches .voice-btn shape so nav icons read as a family. */
  .icon-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
    text-decoration: none;
    flex-shrink: 0;
  }

  .icon-btn:hover {
    color: var(--color-text);
    border-color: var(--color-border-hover);
    background: var(--color-surface-hover);
  }

  .icon-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  @media (max-width: 768px) {
    .navbar-inner {
      padding: 0 var(--space-4);
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
