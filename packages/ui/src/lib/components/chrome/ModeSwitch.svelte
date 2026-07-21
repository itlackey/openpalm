<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import ToggleButton from '@openpalm/ui-kit/components/common/ToggleButton.svelte';
  import IconChat from '@openpalm/ui-kit/components/icons/IconChat.svelte';
  import IconTerminal from '@openpalm/ui-kit/components/icons/IconTerminal.svelte';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { buildAdvancedPath, buildChatPath, currentChatSessionId } from '$lib/chat/navigation.js';

  // Route-aware chat-surface switch. Treat /advanced as selected even when it
  // was opened directly and no stored preference has been initialized.
  const pathname = $derived(page.url?.pathname ?? '');
  const onAdmin = $derived(pathname === '/host' || pathname.startsWith('/host/'));
  const onOpenCode = $derived(pathname === '/advanced' || pathname.startsWith('/advanced/'));
  const openCodeSelected = $derived(onOpenCode || advancedModeService.enabled);

  function navigateTo(target: string): void {
    if (typeof document !== 'undefined' && 'startViewTransition' in document) {
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- target is built by typed internal navigation helpers
      document.startViewTransition(() => goto(target));
      return;
    }
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- target is built by typed internal navigation helpers
    void goto(target);
  }

  function switchMode(enabled: boolean): void {
    // Always persist the preference — `openCodeSelected` ORs in the current
    // route, so on a directly-opened /advanced page (stored pref still
    // 'simple') clicking OpenCode looks like a no-op and never saved the
    // choice. Navigation, not persistence, is what's conditional below.
    advancedModeService.setEnabled(enabled);
    if (onAdmin) return;
    // Already on the surface for this mode → nothing to navigate.
    if (onOpenCode === enabled) return;
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
    navigateTo(target);
  }
</script>

<div class="mode-switch" role="group" aria-label="Interface mode">
  <ToggleButton
    pressed={!openCodeSelected}
    onToggle={() => switchMode(false)}
    icon={simpleIcon}
    ariaLabel="Simple mode"
    title="Simple mode"
  />
  <ToggleButton
    pressed={openCodeSelected}
    onToggle={() => switchMode(true)}
    icon={openCodeIcon}
    ariaLabel="OpenCode mode"
    title="OpenCode mode"
  />
</div>

{#snippet simpleIcon()}
  <IconChat size={18} />
{/snippet}

{#snippet openCodeIcon()}
  <IconTerminal size={18} />
{/snippet}

<style>
  .mode-switch {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-1);
  }
</style>
