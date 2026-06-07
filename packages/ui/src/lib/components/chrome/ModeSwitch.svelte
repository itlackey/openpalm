<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import ToggleButton from '$lib/components/common/ToggleButton.svelte';

  // Single "Advanced" toggle for the chat surface: off on /chat, on
  // (selected) on /advanced. Clicking flips between the two. Rendering through
  // ToggleButton keeps it aligned with the other chrome toggles.
  const pathname = $derived(page.url?.pathname ?? '');
  const onAdvanced = $derived(pathname === '/advanced' || pathname.startsWith('/advanced/'));

  function toggle(): void {
    void goto(onAdvanced ? '/chat' : '/advanced');
  }
</script>

<ToggleButton
  pressed={onAdvanced}
  onToggle={toggle}
  ariaLabel="Advanced mode"
  title="Advanced mode (embedded OpenCode)"
  icon={advancedIcon}
/>

{#snippet advancedIcon()}
  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><path d="m7 9 3 3-3 3" /><line x1="13" y1="15" x2="17" y2="15" />
  </svg>
{/snippet}
