<script lang="ts">
  import { themeService } from '$lib/theme-state.svelte.js';
  import ToggleButton from '$lib/components/common/ToggleButton.svelte';

  const isDark = $derived(themeService.resolved === 'dark');
  const label = $derived(isDark ? 'Switch to light mode' : 'Switch to dark mode');
</script>

<ToggleButton
  pressed={isDark}
  onToggle={() => themeService.toggle()}
  ariaLabel={label}
  title={label}
  icon={moon}
  selectedIcon={sun}
/>

{#snippet moon()}
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"></path>
  </svg>
{/snippet}

{#snippet sun()}
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="4"></circle>
    <path d="M12 2v2"></path>
    <path d="M12 20v2"></path>
    <path d="m4.93 4.93 1.41 1.41"></path>
    <path d="m17.66 17.66 1.41 1.41"></path>
    <path d="M2 12h2"></path>
    <path d="M20 12h2"></path>
    <path d="m6.34 17.66-1.41 1.41"></path>
    <path d="m19.07 4.93-1.41 1.41"></path>
  </svg>
{/snippet}
