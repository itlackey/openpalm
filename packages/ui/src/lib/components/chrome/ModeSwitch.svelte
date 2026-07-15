<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import ToggleButton from '@openpalm/ui-kit/components/common/ToggleButton.svelte';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import { buildAdvancedPath, buildChatPath, currentChatSessionId } from '$lib/chat/navigation.js';
  import IconAdvanced from '@openpalm/ui-kit/components/icons/IconAdvanced.svelte';

  // Single "Advanced" toggle for the chat surface: off on /chat, on
  // (selected) on /advanced. Clicking flips between the two. Rendering through
  // ToggleButton keeps it aligned with the other chrome toggles.
  const pathname = $derived(page.url?.pathname ?? '');
  const onAdmin = $derived(pathname === '/host' || pathname.startsWith('/host/'));

  function toggle(): void {
    const enabled = advancedModeService.toggle();
    if (onAdmin) return;
    // Advanced validates its requested session before updating the chat cursor.
    // On the return path that validated cursor is authoritative; blindly reusing
    // the URL query would revive a deleted/session-on-another-endpoint id.
    const sessionId = enabled
      ? page.url.searchParams.get('session') ?? currentChatSessionId()
      : currentChatSessionId();
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
