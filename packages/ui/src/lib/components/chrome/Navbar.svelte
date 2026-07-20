<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import IconButton from '@openpalm/ui-kit/components/common/IconButton.svelte';
  import ThemeToggle from '@openpalm/ui-kit/components/common/ThemeToggle.svelte';
  import { hasCapability, runtimeContext } from '$lib/runtime-context.svelte.js';
  import IconChat from '@openpalm/ui-kit/components/icons/IconChat.svelte';
  import IconLogo from '@openpalm/ui-kit/components/icons/IconLogo.svelte';
  import IconSettings from '@openpalm/ui-kit/components/icons/IconSettings.svelte';

  // Top chrome SHELL: brand, the chat↔host utility button, and the theme
  // toggle. Deliberately free of chat components and chat stores (#555) so the admin surface can
  // mount it without dragging chat modules into the host bundle. Conversation
  // surfaces mount ChatNavbar.svelte, which composes this shell with the
  // global chat controls (assistant switcher, session picker, voice).
  //
  // Navigation is capability-driven: destinations come from
  // runtimeContext.routes and visibility from hasCapability() — never the
  // legacy admin feature flag.
  interface Props {
    /** Brand destination; defaults to the mode's chat route. */
    brandHref?: string;
    /** Whether to show the built-in host/chat and theme utilities. */
    showUtilities?: boolean;
    /** Remove the navbar from interaction while a sibling dialog owns focus. */
    inactive?: boolean;
    /** Use the taller responsive frame shared by Simple and OpenCode. */
    conversation?: boolean;
    /** Surface-specific controls rendered after the theme toggle. */
    children?: Snippet;
  }

  let {
    brandHref,
    showUtilities = true,
    inactive = false,
    conversation = false,
    children,
  }: Props = $props();

  const chatRoute = $derived(runtimeContext.routes.chat ?? '/chat');
  const hostRoute = $derived(runtimeContext.routes.host);
  const pathname = $derived(page.url?.pathname ?? '');
  const onHostSurface = $derived(
    hostRoute !== undefined && (pathname === hostRoute || pathname.startsWith(`${hostRoute}/`))
  );
  const resolvedBrandHref = $derived(brandHref ?? chatRoute);
</script>

<header class="navbar" class:conversation inert={inactive}>
  <div class="navbar-inner">
    <!-- Brand -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- destination comes from runtimeContext.routes / a session-aware path, not a static route id -->
    <a class="navbar-brand" href={resolvedBrandHref} aria-label="OpenPalm - go to chat">
      <span class="brand-icon" aria-hidden="true">
        <IconLogo size={28} />
      </span>
      <span class="brand-text">OpenPalm</span>
    </a>

    <!-- Utility cluster, left→right: chat/host button · theme · surface
         controls (from children). -->
    {#if showUtilities || children}
      <div class="navbar-actions">
        {#if showUtilities}
          {#if onHostSurface}
            <IconButton href={resolvedBrandHref} ariaLabel="Back to chat" title="Chat" icon={chatIcon} />
          {:else if hostRoute !== undefined && hasCapability('host:stack:read')}
            <IconButton href={hostRoute} ariaLabel="Manage assistant" title="Admin" icon={settingsIcon} />
          {/if}
          <ThemeToggle />
        {/if}
        {@render children?.()}
      </div>
    {/if}
  </div>
</header>

{#snippet chatIcon()}
  <IconChat size={18} />
{/snippet}

{#snippet settingsIcon()}
  <IconSettings size={18} />
{/snippet}

<style>
  .navbar {
    position: sticky;
    top: 0;
    z-index: 50;
    background: var(--s-paper);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    height: 52px;
  }

  .navbar.conversation,
  .navbar.conversation .navbar-inner {
    height: 64px;
  }

  .navbar-inner {
    width: 100%;
    box-sizing: border-box;
    padding: 0 var(--s-sp-5);
    height: 52px;
    display: flex;
    align-items: center;
    gap: var(--s-sp-3);
  }

  /* ── Brand ── */
  .navbar-brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-sp-2);
    min-width: 44px;
    min-height: 44px;
    flex-shrink: 0;
    text-decoration: none;
  }
  .navbar-brand:focus-visible {
    outline: var(--s-hair) solid var(--s-seal);
    outline-offset: 2px;
  }
  .brand-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    color: var(--s-ink);
  }
  .brand-icon :global(svg) {
    display: block;
  }
  .brand-text {
    font-family: var(--s-font-header);
    color: var(--s-ink-3);
    white-space: nowrap;
  }

  /* ── Actions: the global control cluster, right-aligned. ── */
  .navbar-actions {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    margin-left: auto;
    min-width: 0;
  }
  @media (max-width: 720px) {
    .brand-text {
      display: none;
    }
    .navbar-inner {
      padding: 0 var(--s-sp-2);
      gap: 0;
    }
  }

  @media (max-width: 999px) {
    .navbar.conversation {
      height: 112px;
    }
    .navbar.conversation .navbar-inner {
      position: relative;
      height: 112px;
      padding: 0;
      align-items: flex-start;
    }
    .navbar.conversation .navbar-brand {
      position: absolute;
      top: 6px;
      left: var(--s-sp-2);
      z-index: 1;
    }
    .navbar.conversation .navbar-actions {
      width: 100%;
      height: 112px;
      margin-left: 0;
      display: block;
    }
  }

  @media (min-width: 721px) and (max-width: 999px) {
    .navbar.conversation .brand-text {
      display: inline;
    }
  }

  @media (max-width: 479px) {
    .navbar.conversation,
    .navbar.conversation .navbar-inner,
    .navbar.conversation .navbar-actions {
      height: 144px;
    }
  }

  @media (max-width: 480px) {
    .navbar:not(.conversation) .navbar-inner {
      padding: 0 var(--s-sp-1);
    }
    .navbar-actions {
      gap: 0;
    }
  }
</style>
