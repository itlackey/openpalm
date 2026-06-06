<script lang="ts">
  import { page } from '$app/state';
  import ThemeToggle from './ThemeToggle.svelte';
  import EndpointSwitcher from './EndpointSwitcher.svelte';
  import SessionPicker from './SessionPicker.svelte';
  import VoiceControl from './VoiceControl.svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  // GLOBAL top chrome, mounted on EVERY page. These controls must be present and
  // usable everywhere:
  //   - assistant switcher (EndpointSwitcher)
  //   - session picker (SessionPicker)
  //   - mic + speaker (VoiceControl) — VoiceControl.initVoice() runs here so STT
  //     and TTS work globally; this component LIVING IN THE NAVBAR is what makes
  //     voice global. Do not move it into a page-scoped toolbar.
  // The Chat↔Advanced mode switch is page-contextual and lives in the chat
  // content (ChatToolbar / advanced bar), not here, so these four always fit.
  const pathname = $derived(page.url?.pathname ?? '');
  const onAdmin = $derived(pathname === '/admin' || pathname.startsWith('/admin/'));

  // The Settings gear administers the LOCAL stack, so it only appears when the
  // selected assistant is local (loopback). Hidden for a remote assistant —
  // you don't administer a remote machine from here. Defaults to shown until an
  // endpoint resolves.
  const isLocalAssistant = $derived.by(() => {
    const url = endpointsService.active?.url ?? '';
    if (!url) return true;
    try {
      const host = new URL(url).hostname;
      return (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === 'host.docker.internal'
      );
    } catch {
      return true;
    }
  });
</script>

<header class="navbar">
  <div class="navbar-inner">
    <!-- Brand -->
    <a class="navbar-brand" href="/chat" aria-label="OpenPalm — go to chat">
      <span class="brand-icon" aria-hidden="true">
        <img src="/logo-128.png" alt="" />
      </span>
      <span class="brand-text">OpenPalm</span>
    </a>

    <!-- Global controls, left→right: settings · assistant · session · theme ·
         speaker · mic (speaker+mic come from VoiceControl). Settings shows only
         for a local assistant. Present on every page, every width. -->
    <div class="navbar-actions">
      {#if isLocalAssistant}
        <a
          href="/admin"
          class="gear-btn"
          class:active={onAdmin}
          aria-label="Settings & administration"
          aria-current={onAdmin ? 'page' : undefined}
          title="Manage this machine"
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </a>
      {/if}
      <EndpointSwitcher />
      <SessionPicker />
      <ThemeToggle />
      <VoiceControl />
    </div>
  </div>
</header>

<style>
  .navbar {
    position: sticky;
    top: 0;
    z-index: 50;
    background: var(--color-navbar-bg);
    border-bottom: 1px solid var(--color-border);
  }
  .navbar::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    backdrop-filter: blur(12px);
    pointer-events: none;
  }

  .navbar-inner {
    width: 100%;
    padding: 0 var(--space-4);
    height: var(--nav-height);
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  /* ── Brand ── */
  .navbar-brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
    text-decoration: none;
    border-radius: var(--radius-sm);
  }
  .navbar-brand:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
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

  /* ── Actions: the global control cluster, right-aligned. ── */
  .navbar-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
    min-width: 0;
  }
  /* The assistant + session triggers may shrink (truncate label) but never
     disappear — at narrow widths they go icon-only via the rule below. */
  .navbar-actions :global(.switcher),
  .navbar-actions :global(.trigger) {
    min-width: 0;
  }

  /* Icon-only square button, matching the theme + voice controls. */
  .gear-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    text-decoration: none;
    flex-shrink: 0;
    transition: color var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast);
  }
  .gear-btn:hover {
    color: var(--color-text);
    background: var(--color-surface-hover);
  }
  .gear-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .gear-btn.active {
    color: var(--color-text);
    background: var(--color-surface);
    border-color: var(--color-border);
    font-weight: var(--font-semibold);
  }
  .gear-btn svg {
    flex-shrink: 0;
  }

  /* ── Responsive: shed labels, keep every control visible. ── */
  @media (max-width: 900px) {
    /* Assistant + session collapse to icon + status dot + caret (their own
       dropdowns stay) — visible at every width, just compact. */
    .navbar-actions :global(.trigger .label) {
      display: none;
    }
  }

  @media (max-width: 480px) {
    .brand-text {
      display: none;
    }
    .navbar-inner {
      padding: 0 var(--space-3);
      gap: var(--space-2);
    }
  }
</style>
