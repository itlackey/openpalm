<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import IconButton from '$lib/components/common/IconButton.svelte';
  import ModeSwitch from '$lib/components/chrome/ModeSwitch.svelte';
  import ThemeToggle from '$lib/components/common/ThemeToggle.svelte';
  import EndpointSwitcher from '$lib/components/chat/EndpointSwitcher.svelte';
  import SessionPicker from '$lib/components/chat/SessionPicker.svelte';
  import VoiceControl from '$lib/components/chat/VoiceControl.svelte';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import { buildAdvancedPath, buildChatPath, currentChatSessionId } from '$lib/chat/navigation.js';

  // GLOBAL top chrome, mounted on EVERY page. These controls must be present and
  // usable everywhere:
  //   - assistant switcher (EndpointSwitcher)
  //   - session picker (SessionPicker)
  //   - mic + speaker (VoiceControl) — VoiceControl.initVoice() runs here so STT
  //     and TTS work globally; this component LIVING IN THE NAVBAR is what makes
  //     voice global. Do not move it into a page-scoped toolbar.
  // The Chat↔Advanced mode switch appears here (left of the global controls)
  // only on the chat surfaces.
  const pathname = $derived(page.url?.pathname ?? '');
  const onAdmin = $derived(pathname === '/admin' || pathname.startsWith('/admin/'));
  // The Chat↔Advanced mode switch lives in the global navbar so it's always a
  // stable, top-level destination. Only the left-most utility button swaps:
  // settings on most pages, chat on admin.
  const onChatSurface = $derived(
    pathname === '/chat' ||
    pathname.startsWith('/chat/')
  );
  const onAdvancedSurface = $derived(
    pathname === '/advanced' ||
    pathname.startsWith('/advanced/')
  );
  const onConversationSurface = $derived(onChatSurface || onAdvancedSurface);

  const preferredChatHref = $derived.by(() => {
    const sessionId = page.url.searchParams.get('session') ?? currentChatSessionId();
    return advancedModeService.enabled ? buildAdvancedPath(sessionId) : buildChatPath(sessionId);
  });

  onMount(() => {
    advancedModeService.init();
  });
</script>

<header class="navbar">
  <div class="navbar-inner">
    <!-- Brand -->
    <a class="navbar-brand" href={preferredChatHref} aria-label="OpenPalm — go to chat">
      <span class="brand-icon" aria-hidden="true">
        <img src="/logo-128.png" alt="" />
      </span>
      <span class="brand-text">OpenPalm</span>
    </a>



    <!-- Global controls, left→right: chat/settings · assistant · session ·
         advanced · speaker · mic (speaker+mic come from VoiceControl). Present
         on every page, every width. -->
    <div class="navbar-actions">
      {#if onAdmin}
        <IconButton href={preferredChatHref} ariaLabel="Back to chat" title="Chat" icon={chatIcon} />
      {/if}
      <ThemeToggle />
      {#if onConversationSurface}
        <!-- Hidden ≥1024px: the chat side panel hosts these selectors there. -->
        <span class="chat-selectors">
          <EndpointSwitcher />
          <SessionPicker />
        </span>
      {/if}
      <ModeSwitch />
      <VoiceControl />
    </div>
  </div>
</header>

{#snippet chatIcon()}
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
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
  }
  .brand-icon img {
    max-width: 28px;
    display: block;
  }
  .brand-text {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
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
  /* The assistant + session triggers may shrink (truncate label) but never
     disappear — at narrow widths they go icon-only via the rule below. */
  .navbar-actions :global(.switcher),
  .navbar-actions :global(.trigger) {
    min-width: 0;
  }

  /* The assistant + session selectors live in the navbar only below 1024px;
     at wider widths the chat side panel hosts them, so hide the triggers. */
  .chat-selectors {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-2);
  }
  @media (min-width: 1024px) {
    .chat-selectors {
      display: none;
    }
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
