<script lang="ts">
  import type { ThemePreference } from '$lib/theme-state.svelte.js';
  import { afterNavigate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import Drawer from '$lib/components/common/Drawer.svelte';
  import IconButton from '$lib/components/common/IconButton.svelte';
  import { themeService } from '$lib/theme-state.svelte.js';
  import IconSettings from '$lib/components/icons/IconSettings.svelte';

  interface Props {
    showManageAssistant?: boolean;
  }

  let { showManageAssistant = true }: Props = $props();

  let open = $state(false);

  // Always close on navigation (back/forward or programmatic), not just the two
  // in-drawer links — otherwise the drawer can linger open over the next page
  // (the mobile "drawer over content" bug, #473).
  afterNavigate(() => { open = false; });

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
        <a class="settings-link" href={resolve('/admin')} onclick={() => (open = false)}>
          Manage this assistant...
        </a>
      {/if}
      <a class="settings-link" href={resolve('/admin/endpoints')} onclick={() => (open = false)}>
        Manage assistant connections...
      </a>
    </nav>
  </div>
</Drawer>

{#snippet gearIcon()}
  <IconSettings size={18} />
{/snippet}

<style>
  .settings-drawer {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-6);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
  }

  .field-label {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
  }

  .field-select {
    width: 100%;
    min-height: 40px;
    padding: 0 var(--s-sp-3);
    appearance: none;
    background: var(--s-paper-deep);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    color: var(--s-ink-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    cursor: pointer;
  }

  .field-select:focus-visible {
    outline: var(--s-hair) solid var(--s-seal);
    outline-offset: 2px;
  }

  .settings-links {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
  }

  .settings-link {
    display: block;
    padding: var(--s-sp-3) var(--s-sp-4);
    background: var(--s-paper-deep);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    color: var(--s-ink-2);
    text-decoration: none;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    transition: color var(--s-t-quick) var(--s-ease), border-color var(--s-t-quick) var(--s-ease);
  }

  .settings-link:hover {
    color: var(--s-ink);
    border-color: var(--s-line);
  }

  .settings-link:focus-visible {
    outline: var(--s-hair) solid var(--s-seal);
    outline-offset: 2px;
  }
</style>
