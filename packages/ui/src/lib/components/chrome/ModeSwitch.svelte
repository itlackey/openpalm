<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import ToggleButton from '@openpalm/ui-kit/components/common/ToggleButton.svelte';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import { buildAdvancedPath, buildChatPath, currentChatSessionId } from '$lib/chat/navigation.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import IconAdvanced from '@openpalm/ui-kit/components/icons/IconAdvanced.svelte';

  // Single "Advanced" toggle for the chat surface: off on /chat, on
  // (selected) on /advanced. Clicking flips between the two. Rendering through
  // ToggleButton keeps it aligned with the other chrome toggles.
  const pathname = $derived(page.url?.pathname ?? '');
  const onAdmin = $derived(pathname === '/host' || pathname.startsWith('/host/'));

  function toggle(): void {
    const enabled = advancedModeService.toggle();
    if (onAdmin) return;
    // Returning from advanced → chat: stale session cache won't auto-refresh
    // because onEndpointChanged() skips loadSessions() when sessionsLoaded=true.
    // Invalidate so the chat panel re-fetches the session list on next load.
    if (!enabled) {
      chat.invalidateSessions(chat.activeEndpointId);
    }
    const sessionId = page.url.searchParams.get('session') ?? currentChatSessionId();
    const target = enabled ? buildAdvancedPath(sessionId) : buildChatPath(sessionId);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- dynamic session path built internally, not a static route id
    void goto(target);
  }
</script>

<ToggleButton
  pressed={advancedModeService.enabled}
  onToggle={toggle}
  ariaLabel="Advanced mode"
  title="Advanced mode (embedded OpenCode)"
  icon={advancedIcon}
/>

{#snippet advancedIcon()}
  <IconAdvanced size={15} />
{/snippet}
