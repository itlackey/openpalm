<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Drawer from '@openpalm/ui-kit/components/common/Drawer.svelte';
  import IconActivity from '@openpalm/ui-kit/components/icons/IconActivity.svelte';
  import IconSettings from '@openpalm/ui-kit/components/icons/IconSettings.svelte';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import ModeSwitch from '$lib/components/chrome/ModeSwitch.svelte';
  import EndpointList from '$lib/components/chat/EndpointList.svelte';
  import EndpointSwitcher from '$lib/components/chat/EndpointSwitcher.svelte';
  import SessionList from '$lib/components/chat/SessionList.svelte';
  import SessionPicker from '$lib/components/chat/SessionPicker.svelte';
  import ToolLog from '$lib/components/chat/ToolLog.svelte';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { buildConversationPath, buildReturnToPath } from '$lib/chat/navigation.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { hasCapability } from '$lib/runtime-context.svelte.js';
  import type { ThemePreference } from '$lib/theme-state.svelte.js';
  import { themeService } from '$lib/theme-state.svelte.js';

  type DrawerName = 'assistant' | 'conversation' | 'activity' | 'settings';

  interface Props {
    drawerOpen?: boolean;
  }
  let { drawerOpen = $bindable(false) }: Props = $props();

  const DRAWER_ID = 'chat-navbar-drawer';
  let activeDrawer = $state<DrawerName | null>(null);

  const pathname = $derived(page.url?.pathname ?? '');
  const activeAssistant = $derived(endpointsService.active);
  const conversationModePathname = $derived(
    pathname === '/advanced' || pathname.startsWith('/advanced/')
      ? '/advanced'
      : pathname === '/chat' || pathname.startsWith('/chat/')
        ? '/chat'
        : advancedModeService.enabled
          ? '/advanced'
          : '/chat',
  );
  const activeSessionId = $derived(page.url.searchParams.get('session') ?? chat.activeSessionId);
  const conversationPath = $derived(
    buildConversationPath(conversationModePathname, activeSessionId, activeAssistant?.id),
  );
  const connectionsHref = $derived(
    buildReturnToPath(resolve('/connections'), conversationPath),
  );
  const deviceVoiceHref = $derived(
    buildReturnToPath(resolve('/settings/voice'), conversationPath),
  );
  const hostHref = $derived(buildReturnToPath(resolve('/host'), conversationPath));
  const hostVoiceHref = $derived(
    buildReturnToPath(`${resolve('/host')}?tab=addons&addon=voice`, conversationPath),
  );
  const showHostSettings = $derived(hasCapability('host:stack:read'));
  const drawerTitle = $derived(
    activeDrawer === 'assistant'
      ? 'Assistant'
      : activeDrawer === 'conversation'
        ? 'Conversation'
        : activeDrawer === 'activity'
          ? 'Activity'
          : 'Settings',
  );

  onMount(() => {
    advancedModeService.init();
  });

  function toggleDrawer(name: DrawerName): void {
    if (drawerOpen && activeDrawer === name) {
      closeDrawer();
      return;
    }
    activeDrawer = name;
    drawerOpen = true;
  }

  function closeDrawer(): void {
    drawerOpen = false;
  }

  function setTheme(event: Event): void {
    const preference = (event.currentTarget as HTMLSelectElement).value;
    if (preference === 'light' || preference === 'dark' || preference === 'system') {
      themeService.setPreference(preference as ThemePreference);
    }
  }
</script>

<Navbar brandHref={conversationPath} inactive={drawerOpen} showUtilities={false}>
  <EndpointSwitcher
    open={drawerOpen && activeDrawer === 'assistant'}
    controls={DRAWER_ID}
    onToggle={() => toggleDrawer('assistant')}
  />
  <SessionPicker
    open={drawerOpen && activeDrawer === 'conversation'}
    controls={DRAWER_ID}
    onToggle={() => toggleDrawer('conversation')}
  />
  <button
    type="button"
    class="drawer-trigger"
    class:active={drawerOpen && activeDrawer === 'activity'}
    aria-label="Activity"
    title="Activity"
    aria-haspopup="dialog"
    aria-expanded={drawerOpen && activeDrawer === 'activity'}
    aria-controls={DRAWER_ID}
    onclick={() => toggleDrawer('activity')}
  >
    <IconActivity size={18} />
    <span class="trigger-label">Activity</span>
  </button>
  <ModeSwitch />
  <button
    type="button"
    class="drawer-trigger"
    class:active={drawerOpen && activeDrawer === 'settings'}
    aria-label="Settings"
    title="Settings"
    aria-haspopup="dialog"
    aria-expanded={drawerOpen && activeDrawer === 'settings'}
    aria-controls={DRAWER_ID}
    onclick={() => toggleDrawer('settings')}
  >
    <IconSettings size={18} />
    <span class="trigger-label">Settings</span>
  </button>
</Navbar>

<Drawer
  id={DRAWER_ID}
  open={drawerOpen}
  title={drawerTitle}
  onClose={closeDrawer}
  width="26rem"
>
  {#if activeDrawer === 'assistant'}
    <EndpointList onChosen={closeDrawer} />
  {:else if activeDrawer === 'conversation'}
    <SessionList onChosen={closeDrawer} />
  {:else if activeDrawer === 'activity'}
    {#if chat.toolLog.length > 0}
      <ToolLog items={chat.toolLog} />
    {:else}
      <p class="empty-state">No activity for this conversation yet.</p>
    {/if}
  {:else if activeDrawer === 'settings'}
    <div class="settings-groups">
      <section class="settings-group" aria-labelledby="device-settings-heading">
        <h4 id="device-settings-heading">Device</h4>
        <nav aria-label="Device settings">
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve()d destination with encoded conversation return context -->
          <a href={connectionsHref} onclick={closeDrawer}>Assistant connections</a>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve()d destination with encoded conversation return context -->
          <a href={deviceVoiceHref} onclick={closeDrawer}>Voice on this device</a>
        </nav>
      </section>

      {#if showHostSettings}
        <section class="settings-group" aria-labelledby="host-settings-heading">
          <h4 id="host-settings-heading">Host</h4>
          <nav aria-label="Host settings">
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve()d destination with encoded conversation return context -->
            <a href={hostHref} onclick={closeDrawer}>Host dashboard</a>
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve()d destination with encoded conversation return context -->
            <a href={hostVoiceHref} onclick={closeDrawer}>Voice service on this host</a>
          </nav>
        </section>
      {/if}

      <section class="settings-group" aria-labelledby="appearance-settings-heading">
        <h4 id="appearance-settings-heading">Appearance</h4>
        <label for="chat-navbar-theme">Theme</label>
        <select
          id="chat-navbar-theme"
          aria-label="Theme"
          value={themeService.preference}
          onchange={setTheme}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </section>
    </div>
  {/if}
</Drawer>

<style>
  .drawer-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-sp-2);
    min-width: 44px;
    height: 44px;
    padding: 0 var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: none;
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    cursor: pointer;
  }
  .drawer-trigger:hover,
  .drawer-trigger.active {
    color: var(--s-seal);
    border-color: var(--s-seal);
  }
  .drawer-trigger:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 2px;
  }
  .empty-state {
    margin: 0;
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
  }
  .settings-groups,
  .settings-group,
  .settings-group nav {
    display: flex;
    flex-direction: column;
  }
  .settings-groups {
    gap: var(--s-sp-6);
  }
  .settings-group {
    gap: var(--s-sp-2);
  }
  .settings-group h4 {
    margin: 0;
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    font-weight: 400;
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
  }
  .settings-group nav {
    gap: 0;
  }
  .settings-group a {
    display: flex;
    align-items: center;
    min-height: 44px;
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    color: var(--s-ink-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    text-decoration: none;
  }
  .settings-group a:hover {
    color: var(--s-seal);
  }
  .settings-group a:focus-visible,
  .settings-group select:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 2px;
  }
  .settings-group label {
    color: var(--s-ink-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
  }
  .settings-group select {
    min-height: 44px;
    padding: 0 var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper-deep);
    color: var(--s-ink-2);
    font: inherit;
  }

  @media (max-width: 720px) {
    .drawer-trigger {
      width: 44px;
      padding: 0;
      border-color: transparent;
    }
    .trigger-label {
      display: none;
    }
  }
</style>
