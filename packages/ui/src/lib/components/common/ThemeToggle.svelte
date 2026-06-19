<script lang="ts">
  import type { ThemePreference } from '$lib/theme-state.svelte.js';
  import { themeService } from '$lib/theme-state.svelte.js';
  import IconButton from '$lib/components/common/IconButton.svelte';
  import IconThemeSystem from '$lib/components/icons/IconThemeSystem.svelte';
  import IconThemeLight from '$lib/components/icons/IconThemeLight.svelte';
  import IconThemeDark from '$lib/components/icons/IconThemeDark.svelte';

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
    <IconThemeSystem size={16} />
  {:else if themeService.preference === 'light'}
    <IconThemeLight size={16} />
  {:else}
    <IconThemeDark size={16} />
  {/if}
{/snippet}
