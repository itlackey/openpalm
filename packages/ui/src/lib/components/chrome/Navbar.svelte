<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import IconButton from '$lib/components/common/IconButton.svelte';
  import ThemeToggle from '$lib/components/common/ThemeToggle.svelte';
  import { hasCapability, runtimeContext } from '$lib/runtime-context.svelte.js';
  import IconChat from '$lib/components/icons/IconChat.svelte';
  import IconLogo from '$lib/components/icons/IconLogo.svelte';
  import IconSettings from '$lib/components/icons/IconSettings.svelte';

  // Top chrome SHELL: brand, the chat↔host utility button, and the theme
  // toggle. Deliberately free of chat components and chat stores (plan
  // ui-runtime-modes-plan.md Phase 3 step 4, #555) so the admin surface can
  // mount it without dragging chat modules into the host bundle. Conversation
  // surfaces mount ChatNavbar.svelte, which composes this shell with the
  // global chat controls (assistant switcher, session picker, voice).
  //
  // Navigation is capability-driven (plan §8.6): destinations come from
  // runtimeContext.routes and visibility from hasCapability() — never the
  // legacy admin feature flag.
  interface Props {
    /** Brand destination; defaults to the mode's chat route. */
    brandHref?: string;
    /** Surface-specific controls rendered after the theme toggle. */
    children?: Snippet;
  }

  let { brandHref, children }: Props = $props();

  const chatRoute = $derived(runtimeContext.routes.chat ?? '/chat');
  const hostRoute = $derived(runtimeContext.routes.host);
  const pathname = $derived(page.url?.pathname ?? '');
  const onHostSurface = $derived(
    hostRoute !== undefined && (pathname === hostRoute || pathname.startsWith(`${hostRoute}/`))
  );
  const resolvedBrandHref = $derived(brandHref ?? chatRoute);
</script>

<header class="navbar">
  <div class="navbar-inner">
    <!-- Brand -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- destination comes from runtimeContext.routes / a session-aware path, not a static route id -->
    <a class="navbar-brand" href={resolvedBrandHref} aria-label="OpenPalm — go to chat">
      <span class="brand-icon" aria-hidden="true">
        <IconLogo size={28} />
      </span>
      <span class="brand-text">OpenPalm</span>
    </a>

    <!-- Utility cluster, left→right: chat/host button · theme · surface
         controls (from children). -->
    <div class="navbar-actions">
      {#if onHostSurface}
        <IconButton href={resolvedBrandHref} ariaLabel="Back to chat" title="Chat" icon={chatIcon} />
      {:else if hostRoute !== undefined && hasCapability('host:stack:read')}
        <IconButton href={hostRoute} ariaLabel="Manage assistant" title="Admin" icon={settingsIcon} />
      {/if}
      <ThemeToggle />
      {@render children?.()}
    </div>
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

  .navbar-inner {
    width: 100%;
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
    gap: var(--s-sp-2);
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
  /* The assistant + session triggers (rendered by ChatNavbar's children) may
     shrink (truncate label) but never disappear — at narrow widths they go
     icon-only via the rule below. */
  .navbar-actions :global(.switcher),
  .navbar-actions :global(.trigger) {
    min-width: 0;
  }

  /* ── Responsive: shed labels, keep every control visible. ── */
  @media (max-width: 900px) {
    /* Assistant + session collapse to icon + status dot + caret (their own
       drawers stay) — visible at every width, just compact. */
    .navbar-actions :global(.trigger .label) {
      display: none;
    }
  }

  @media (max-width: 480px) {
    .brand-text {
      display: none;
    }
    .navbar-inner {
      padding: 0 var(--s-sp-3);
      gap: var(--s-sp-2);
    }
    /* Drop only the caret at narrow widths so the cluster fits a 320px viewport;
       keep the status dot — it visually distinguishes the two picker triggers
       from the plain utility icon buttons (settings/mic). */
    .navbar-actions :global(.trigger .caret) {
      display: none;
    }
  }

  /* Narrow phones: the controls are now 40px tall; tighten the icon-only
     switcher padding + gutters so the cluster still fits within 320px. */
  @media (max-width: 400px) {
    .navbar-inner {
      padding: 0 var(--s-sp-2);
      gap: var(--s-sp-1);
    }
    .navbar-actions {
      gap: var(--s-sp-1);
    }
    .navbar-actions :global(.trigger) {
      padding-left: var(--s-sp-2);
      padding-right: var(--s-sp-2);
    }
  }
</style>
