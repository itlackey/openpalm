<script lang="ts">
  import type { ThemePreference } from '$lib/theme-state.svelte.js';
  import Drawer from '$lib/components/common/Drawer.svelte';
  import IconButton from '$lib/components/common/IconButton.svelte';
  import { themeService } from '$lib/theme-state.svelte.js';

  interface Props {
    showManageAssistant?: boolean;
  }

  let { showManageAssistant = true }: Props = $props();

  let open = $state(false);

  function setTheme(event: Event): void {
    const next = (event.currentTarget as HTMLSelectElement).value;
    if (next === 'light' || next === 'dark' || next === 'system') {
      themeService.setPreference(next as ThemePreference);
    }
  }
</script>

<IconButton
  icon={gearIcon}
  ariaLabel="Settings"
  title="Settings"
  selected={open}
  ariaPressed={open}
  onclick={() => (open = true)}
/>

<Drawer open={open} title="Settings" onClose={() => (open = false)} width="24rem">
  <div class="settings-drawer">
    <label class="field" for="theme-preference">
      <span class="field-label">Theme</span>
      <select
        id="theme-preference"
        class="field-select"
        value={themeService.preference}
        onchange={setTheme}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>

    <nav class="settings-links" aria-label="Settings links">
      {#if showManageAssistant}
        <a class="settings-link" href="/admin" onclick={() => (open = false)}>
          Manage this assistant...
        </a>
      {/if}
      <a class="settings-link" href="/admin/endpoints" onclick={() => (open = false)}>
        Manage assistant connections...
      </a>
    </nav>
  </div>
</Drawer>

{#snippet gearIcon()}
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
{/snippet}

<style>
  .settings-drawer {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .field-label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text);
  }

  .field-select {
    width: 100%;
    min-height: 40px;
    padding: 0 var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font: inherit;
  }

  .field-select:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .settings-links {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .settings-link {
    display: block;
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    text-decoration: none;
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
  }

  .settings-link:hover {
    background: var(--color-surface-hover);
    border-color: var(--color-border-hover);
  }

  .settings-link:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
</style>
