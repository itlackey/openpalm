<script lang="ts">
  import { themeService } from '$lib/theme-state.svelte.js';

  const isDark = $derived(themeService.resolved === 'dark');
  const label = $derived(isDark ? 'Switch to light mode' : 'Switch to dark mode');

  function handleToggle(): void {
    themeService.toggle();
  }
</script>

<button
  type="button"
  class="theme-toggle"
  onclick={handleToggle}
  aria-label={label}
  aria-pressed={isDark}
  title={label}
>
  {#if isDark}
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
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"></path>
    </svg>
  {/if}
</button>

<style>
  .theme-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }

  .theme-toggle:hover {
    color: var(--color-text);
    background: var(--color-surface-hover);
    border-color: var(--color-border-hover);
  }

  .theme-toggle:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .theme-toggle[aria-pressed='true'] {
    color: var(--color-primary);
    background: var(--color-bg-tertiary);
    border-color: var(--color-border);
  }
</style>
