<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import ToggleButton from '$lib/components/common/ToggleButton.svelte';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import { buildAdvancedPath, buildChatPath, currentChatSessionId } from '$lib/chat/navigation.js';
  import IconAdvanced from '$lib/components/icons/IconAdvanced.svelte';

  // Single "Advanced" toggle for the chat surface: off on /chat, on
  // (selected) on /advanced. Clicking flips between the two. Rendering through
  // ToggleButton keeps it aligned with the other chrome toggles.
  const pathname = $derived(page.url?.pathname ?? '');
  const onAdmin = $derived(pathname === '/admin' || pathname.startsWith('/admin/'));
  const onAdvanced = $derived(pathname === '/advanced' || pathname.startsWith('/advanced/'));

  function toggle(): void {
    const enabled = advancedModeService.toggle();
    if (onAdmin) return;
    const sessionId = page.url.searchParams.get('session') ?? currentChatSessionId();
    void goto(enabled ? buildAdvancedPath(sessionId) : buildChatPath(sessionId));
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
