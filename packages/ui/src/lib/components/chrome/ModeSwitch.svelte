<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { buildAdvancedPath, buildChatPath, currentChatSessionId } from '$lib/chat/navigation.js';

  // Route-aware chat-surface switch. Treat /advanced as selected even when it
  // was opened directly and no stored preference has been initialized.
  const pathname = $derived(page.url?.pathname ?? '');
  const onAdmin = $derived(pathname === '/host' || pathname.startsWith('/host/'));
  const onOpenCode = $derived(pathname === '/advanced' || pathname.startsWith('/advanced/'));
  const openCodeSelected = $derived(onOpenCode || advancedModeService.enabled);

  function switchMode(enabled: boolean): void {
    if (enabled === openCodeSelected) return;
    advancedModeService.setEnabled(enabled);
    if (onAdmin) return;
    // Advanced validates its requested session before updating the chat cursor.
    // On the return path that validated cursor is authoritative; blindly reusing
    // the URL query would revive a deleted/session-on-another-endpoint id.
    const sessionId = enabled
      ? page.url.searchParams.get('session') ?? currentChatSessionId()
      : currentChatSessionId();
    const assistantId = page.url.searchParams.get('assistant') ?? chat.activeEndpointId;
    const target = enabled
      ? buildAdvancedPath(sessionId, assistantId)
      : buildChatPath(sessionId, assistantId);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- dynamic session path built internally, not a static route id
    void goto(target);
  }
</script>

<div class="mode-switch" role="group" aria-label="Interface mode">
  <button
    type="button"
    class:active={!openCodeSelected}
    aria-pressed={!openCodeSelected}
    aria-label="Simple mode"
    onclick={() => switchMode(false)}
  >Simple</button>
  <button
    type="button"
    class:active={openCodeSelected}
    aria-pressed={openCodeSelected}
    aria-label="OpenCode mode"
    onclick={() => switchMode(true)}
  >OpenCode</button>
</div>

<style>
  .mode-switch {
    box-sizing: border-box;
    display: inline-grid;
    grid-template-columns: 1fr 1fr;
    min-width: 168px;
    height: 48px;
    padding: 2px;
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 8px;
    background: var(--s-paper-deep);
  }
  button {
    min-width: 76px;
    min-height: 44px;
    padding: 0 var(--s-sp-2);
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
  }
  button:hover {
    color: var(--s-ink);
    background: color-mix(in srgb, var(--s-ink) 6%, transparent);
  }
  button.active {
    background: var(--s-paper);
    color: var(--s-ink);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--s-ink) 15%, transparent);
    font-weight: 700;
  }
  button:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 1px;
  }

  @media (max-width: 400px) {
    .mode-switch {
      min-width: 140px;
    }
    button {
      min-width: 62px;
      padding: 0 var(--s-sp-1);
    }
  }
</style>
