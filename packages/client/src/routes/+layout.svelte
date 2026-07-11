<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import IconChat from '@openpalm/ui-kit/components/icons/IconChat.svelte';
  import IconConnect from '@openpalm/ui-kit/components/icons/IconConnect.svelte';
  import IconThemeSystem from '@openpalm/ui-kit/components/icons/IconThemeSystem.svelte';
  import IconThemeLight from '@openpalm/ui-kit/components/icons/IconThemeLight.svelte';
  import IconThemeDark from '@openpalm/ui-kit/components/icons/IconThemeDark.svelte';
  import IconRefresh from '@openpalm/ui-kit/components/icons/IconRefresh.svelte';
  import IconBell from '@openpalm/ui-kit/components/icons/IconBell.svelte';
  import { getClientBoot } from '$lib/boot.js';
  import { resetAppCache } from '$lib/reset-app-cache.js';
  import { desktopNotifyEnabled, toggleDesktopNotify } from '$lib/desktop-notifications.js';
  import {
    THEME_STORAGE_KEY,
    isThemePreference,
    nextPreference,
    resolvePreference,
    themeColorFor,
    type ThemePreference,
  } from '$lib/theme.js';

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  const path = $derived(page.url.pathname);

  // A2/H4 (review 2026-07-10): link back to the host UI when the runtime
  // config carries one — absent for container-only deployments with no host
  // process to point at. Electron's main process allows window.open to
  // 127.0.0.1, so this opens in a new tab/window rather than navigating away
  // from the SPA.
  let hostUrl = $state<string | undefined>(undefined);

  // B16: manual theme toggle + keeping the boot-time metas in sync when the
  // user flips it mid-session (app.html's own matchMedia listener handles
  // the "OS changed, preference is 'system'" case).
  let themePreference = $state<ThemePreference>('system');

  // F7 (review 2026-07-11): the client's only reachable control for the
  // B12 desktop-notifications feature — before this, nothing in
  // packages/client ever wrote the 'openpalm.desktop.notify' preference, so
  // it could never be anything but off. `toggleDesktopNotify()` (the pure
  // logic) both persists the preference and requests the browser
  // Notification permission when turning it on.
  let desktopNotifyOn = $state(false);

  function handleToggleDesktopNotify(): void {
    desktopNotifyOn = toggleDesktopNotify(desktopNotifyOn);
  }

  function applyTheme(preference: ThemePreference): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const systemPrefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
    const resolved = resolvePreference(preference, systemPrefersDark);
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.style.colorScheme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColorFor(resolved));
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved);
  }

  function toggleTheme(): void {
    themePreference = nextPreference(themePreference);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    } catch {
      // Storage unavailable — the in-session toggle still applies below.
    }
    applyTheme(themePreference);
  }

  // H3 (review 2026-07-10 §H3, client half): the only cache-escape
  // affordance in the client — a stale/dead build has no other recovery
  // path short of clearing browser site data by hand. A confirm() gate
  // (same pattern as the connections page's remove()) since this reloads
  // the page immediately and drops any unsent draft.
  function handleResetAppCache(): void {
    if (!confirm('Reset the app cache and reload? Any unsent message will be lost.')) return;
    void resetAppCache();
  }

  onMount(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      themePreference = isThemePreference(stored) ? stored : 'system';
    } catch {
      themePreference = 'system';
    }

    desktopNotifyOn = desktopNotifyEnabled();

    void (async () => {
      const boot = await getClientBoot();
      hostUrl = boot.hostUrl;
    })();
  });
</script>

<!-- ibrush filter: hand-drawn brush displacement used by all icon components -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <filter id="ibrush" x="-40%" y="-40%" width="180%" height="180%">
      <feTurbulence type="fractalNoise" baseFrequency="0.026 0.032" numOctaves="1" seed="3" result="nA"/>
      <feDisplacementMap in="SourceGraphic" in2="nA" scale="2.4" xChannelSelector="R" yChannelSelector="G" result="dA"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.034 0.028" numOctaves="1" seed="17" result="nB"/>
      <feDisplacementMap in="SourceGraphic" in2="nB" scale="3.0" xChannelSelector="R" yChannelSelector="G" result="dB"/>
      <feMerge result="strokes"><feMergeNode in="dA"/><feMergeNode in="dB"/></feMerge>
      <feTurbulence type="turbulence" baseFrequency="0.7 0.7" numOctaves="2" seed="7" result="g"/>
      <feComponentTransfer in="g" result="gm"><feFuncA type="linear" slope="0.55" intercept="0.52"/></feComponentTransfer>
      <feComposite in="strokes" in2="gm" operator="in"/>
    </filter>
  </defs>
</svg>

<div class="shell">
  <header class="topbar">
    <a class="brand" href="/chat">OpenPalm</a>
    <nav aria-label="Primary">
      <a href="/chat" class="nav-link" class:current={path.startsWith('/chat')} aria-current={path.startsWith('/chat') ? 'page' : undefined}>
        <IconChat size={14} />
        <span>Chat</span>
      </a>
      <a href="/connections" class="nav-link" class:current={path.startsWith('/connections')} aria-current={path.startsWith('/connections') ? 'page' : undefined}>
        <IconConnect size={14} />
        <span>Connections</span>
      </a>
      {#if hostUrl}
        <!-- A2/H4: the client SPA's only route back to setup/admin/voice. -->
        <a class="nav-link host-link" href={hostUrl} target="_blank" rel="noopener noreferrer">
          <span>Manage assistant</span>
        </a>
      {/if}
      <button
        type="button"
        class="theme-toggle"
        onclick={toggleTheme}
        aria-label={`Theme: ${themePreference} (click to change)`}
        title={`Theme: ${themePreference}`}
      >
        {#if themePreference === 'system'}
          <IconThemeSystem size={14} />
        {:else if themePreference === 'light'}
          <IconThemeLight size={14} />
        {:else}
          <IconThemeDark size={14} />
        {/if}
      </button>
      <!-- H3: the only cache-escape affordance in the client — recovers a
           stale/dead precached build with no route back to setup otherwise. -->
      <button
        type="button"
        class="theme-toggle reset-cache-btn"
        onclick={handleResetAppCache}
        aria-label="Reset app cache and reload"
        title="Reset app cache and reload"
      >
        <IconRefresh size={14} />
      </button>
      <!-- F7: the client's only reachable control for desktop notifications
           on turn completion/error — off by default (content-free even when
           on; see desktop-notifications.ts). -->
      <button
        type="button"
        class="theme-toggle notify-toggle"
        class:active={desktopNotifyOn}
        onclick={handleToggleDesktopNotify}
        aria-pressed={desktopNotifyOn}
        aria-label={desktopNotifyOn ? 'Desktop notifications: on (click to turn off)' : 'Desktop notifications: off (click to turn on)'}
        title={desktopNotifyOn ? 'Desktop notifications: on' : 'Desktop notifications: off'}
      >
        <IconBell size={14} />
      </button>
    </nav>
  </header>

  <div class="content">
    {@render children?.()}
  </div>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-4);
    padding: var(--s-sp-3) var(--s-sp-5);
    border-bottom: var(--s-hair) solid var(--s-line);
  }

  .brand {
    font-family: var(--s-font-header);
    font-size: 1.05rem;
    color: var(--s-ink);
    text-decoration: none;
  }

  nav {
    display: flex;
    gap: var(--s-sp-2);
  }

  .nav-link {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.7rem;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    text-decoration: none;
    border-bottom: 2px solid transparent;
  }

  .nav-link:hover {
    color: var(--s-ink);
  }

  .nav-link.current {
    color: var(--s-ink);
    border-bottom-color: var(--s-seal);
  }

  .host-link {
    border-left: var(--s-hair) solid var(--s-line);
    padding-left: var(--s-sp-3);
    margin-left: var(--s-sp-1);
  }

  .theme-toggle {
    appearance: none;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: none;
    color: var(--s-ink-3);
    cursor: pointer;
    padding: 0.35rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .theme-toggle:hover {
    color: var(--s-ink);
    border-color: var(--s-seal);
  }

  .notify-toggle.active {
    color: var(--s-seal);
    border-color: var(--s-seal);
  }

  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
</style>
