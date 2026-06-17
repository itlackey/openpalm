<script lang="ts">
  import type { ThemePreference } from '$lib/theme-state.svelte.js';
  import { themeService } from '$lib/theme-state.svelte.js';
  import IconButton from '$lib/components/common/IconButton.svelte';

  // Cycles: system → light → dark → system
  const CYCLE: ThemePreference[] = ['system', 'light', 'dark'];

  function cycle(): void {
    const current = themeService.preference;
    const idx = CYCLE.indexOf(current);
    const next = CYCLE[(idx + 1) % CYCLE.length];
    themeService.setPreference(next);
  }

  const label = $derived(
    themeService.preference === 'system'
      ? 'Theme: system (click for light)'
      : themeService.preference === 'light'
        ? 'Theme: light (click for dark)'
        : 'Theme: dark (click for system)'
  );
</script>

<IconButton
  icon={currentIcon}
  ariaLabel={label}
  title={label}
  onclick={cycle}
/>

{#snippet currentIcon()}
  {#if themeService.preference === 'system'}
    <!-- Monitor / system icon -->
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  {:else if themeService.preference === 'light'}
    <!-- Sun icon -->
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
  {:else}
    <!-- Moon icon -->
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"></path>
    </svg>
  {/if}
{/snippet}
