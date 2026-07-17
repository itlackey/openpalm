<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Drawer from '@openpalm/ui-kit/components/common/Drawer.svelte';
  import IconActivity from '@openpalm/ui-kit/components/icons/IconActivity.svelte';
  import IconAddons from '@openpalm/ui-kit/components/icons/IconAddons.svelte';
  import IconConnect from '@openpalm/ui-kit/components/icons/IconConnect.svelte';
  import IconHome from '@openpalm/ui-kit/components/icons/IconHome.svelte';
  import IconSettings from '@openpalm/ui-kit/components/icons/IconSettings.svelte';
  import IconWaves from '@openpalm/ui-kit/components/icons/IconWaves.svelte';
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
  import { resolveSessionTitle } from '$lib/session-title.js';
  import type { ThemePreference } from '$lib/theme-state.svelte.js';
  import { themeService } from '$lib/theme-state.svelte.js';

  type DrawerName = 'assistant' | 'conversation' | 'activity' | 'settings';

  interface Props {
    drawerOpen?: boolean;
    activityRailOpen?: boolean;
  }
  let {
    drawerOpen = $bindable(false),
    activityRailOpen = $bindable(true),
  }: Props = $props();

  const DRAWER_ID = 'chat-navbar-drawer';
  const ACTIVITY_RAIL_ID = 'conversation-activity-rail';
  let activeDrawer = $state<DrawerName | null>(null);
  let drawerShowing = $state(false);
  let wideActivityLayout = $state(false);

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
  const endpointState = $derived(
    activeAssistant ? (chat.byEndpoint.get(activeAssistant.id) ?? null) : null,
  );
  const activeSession = $derived(
    endpointState?.sessions.find((session) => session.id === activeSessionId) ?? null,
  );
  const activeConversationTitle = $derived(
    activeSession ? resolveSessionTitle(activeSession.title) : 'New conversation',
  );
  const onOpenCode = $derived(conversationModePathname === '/advanced');
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
  const activityUsesRail = $derived(wideActivityLayout && chat.toolLog.length > 0);
  const drawerTitle = $derived(
    activeDrawer === 'assistant'
      ? 'Switch assistant'
      : activeDrawer === 'conversation'
        ? 'Conversations'
        : activeDrawer === 'activity'
          ? 'Activity'
          : 'Settings',
  );

  onMount(() => {
    advancedModeService.init();
    const activityLayout = window.matchMedia('(min-width: 1101px)');
    const updateActivityLayout = (): void => {
      wideActivityLayout = activityLayout.matches;
      if (wideActivityLayout && activeDrawer === 'activity' && drawerShowing) closeDrawer();
    };
    updateActivityLayout();
    activityLayout.addEventListener('change', updateActivityLayout);
    return () => activityLayout.removeEventListener('change', updateActivityLayout);
  });

  function toggleDrawer(name: DrawerName): void {
    if (name === 'activity' && activityUsesRail) {
      activityRailOpen = !activityRailOpen;
      return;
    }
    if (drawerShowing && activeDrawer === name) {
      closeDrawer();
      return;
    }
    if (drawerOpen && !drawerShowing) return;
    activeDrawer = name;
    drawerOpen = true;
    drawerShowing = true;
  }

  function closeDrawer(): void {
    drawerShowing = false;
  }

  function finishDrawerClose(): void {
    drawerOpen = false;
    activeDrawer = null;
  }

  function setTheme(preference: ThemePreference): void {
    themeService.setPreference(preference);
  }
</script>

<Navbar
  brandHref={conversationPath}
  inactive={drawerOpen}
  showUtilities={false}
  conversation
>
  <div class="chat-nav">
    <div class="context-nav">
      <EndpointSwitcher
        open={drawerShowing && activeDrawer === 'assistant'}
        controls={DRAWER_ID}
        onToggle={() => toggleDrawer('assistant')}
      />
      <SessionPicker
        open={drawerShowing && activeDrawer === 'conversation'}
        controls={DRAWER_ID}
        onToggle={() => toggleDrawer('conversation')}
      />
    </div>
    <div class="primary-nav">
      <ModeSwitch />
      <button
        type="button"
        class="drawer-trigger activity-trigger"
        class:active={activityUsesRail ? activityRailOpen : drawerShowing && activeDrawer === 'activity'}
        aria-label={`Activity for ${activeConversationTitle}`}
        title={`Activity for ${activeConversationTitle}`}
        aria-haspopup={activityUsesRail ? undefined : 'dialog'}
        aria-expanded={activityUsesRail
          ? activityRailOpen
          : drawerShowing && activeDrawer === 'activity'}
        aria-controls={activityUsesRail ? ACTIVITY_RAIL_ID : DRAWER_ID}
        onclick={() => toggleDrawer('activity')}
      >
        <IconActivity size={18} />
        <span>Activity</span>
      </button>
      <button
        type="button"
        class="drawer-trigger settings-trigger"
        class:active={drawerShowing && activeDrawer === 'settings'}
        aria-label="Open settings"
        title="Settings"
        aria-haspopup="dialog"
        aria-expanded={drawerShowing && activeDrawer === 'settings'}
        aria-controls={DRAWER_ID}
        onclick={() => toggleDrawer('settings')}
      >
        <IconSettings size={18} />
        <span>Settings</span>
      </button>
    </div>
  </div>
</Navbar>

<Drawer
  id={DRAWER_ID}
  open={drawerShowing}
  title={drawerTitle}
  onClose={closeDrawer}
  onClosed={finishDrawerClose}
  deferFocusRestore
  width="27rem"
>
  {#if activeDrawer === 'assistant'}
    <div class="assistant-panel">
      <div class="context-card">
        <span class="context-label">Current conversation</span>
        <strong>{activeConversationTitle}</strong>
        <span>Switching assistants restores that assistant’s conversation history.</span>
      </div>
      <EndpointList onChosen={closeDrawer} />
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve()d destination with encoded conversation return context -->
      <a class="panel-route" href={connectionsHref} onclick={closeDrawer}>
        <span class="route-icon"><IconConnect size={20} /></span>
        <span><strong>Manage assistant connections</strong><small>Connections are stored in this browser on this device.</small></span>
        <span aria-hidden="true">→</span>
      </a>
    </div>
  {:else if activeDrawer === 'conversation'}
    <SessionList onChosen={closeDrawer} />
  {:else if activeDrawer === 'activity'}
    <div class="activity-panel">
      <div class="context-card">
        <span class="context-label">Current conversation</span>
        <strong>{activeConversationTitle}</strong>
        <span>{activeAssistant?.label ?? 'No assistant selected'}</span>
      </div>
      {#if onOpenCode}
        <p class="scope-note">
          This follows the OpenPalm conversation selected above. Navigation inside OpenCode is independent.
        </p>
      {/if}
      {#if chat.toolLog.length > 0}
        <ToolLog items={chat.toolLog} showHeading={false} />
      {:else}
        <div class="empty-state">
          <span class="empty-icon"><IconActivity size={24} /></span>
          <strong>No activity yet</strong>
          <span>Tool and task activity for this conversation will appear here.</span>
        </div>
      {/if}
    </div>
  {:else if activeDrawer === 'settings'}
    <div class="settings-panel">
      <div class="settings-intro">
        <span class="settings-kicker">OpenPalm settings</span>
        <p>Device preferences stay in this browser. Host controls manage services running on your OpenPalm host.</p>
      </div>

      <section class="settings-scope" aria-labelledby="device-settings-heading">
        <div class="scope-heading">
          <div>
            <h4 id="device-settings-heading">This device</h4>
            <p>Browser-owned preferences and connections</p>
          </div>
          <span class="scope-badge">Local</span>
        </div>
        <nav class="settings-cards" aria-label="Device settings">
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve()d destination with encoded conversation return context -->
          <a class="settings-card" href={connectionsHref} onclick={closeDrawer}>
            <span class="settings-icon"><IconConnect size={20} /></span>
            <span class="settings-copy"><strong>Assistant connections</strong><small>Add, test, edit, or remove assistants saved in this browser.</small></span>
            <span class="card-arrow" aria-hidden="true">→</span>
          </a>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve()d destination with encoded conversation return context -->
          <a class="settings-card" href={deviceVoiceHref} onclick={closeDrawer}>
            <span class="settings-icon"><IconWaves size={20} /></span>
            <span class="settings-copy"><strong>Voice input &amp; playback</strong><small>Choose speech input, language, and spoken response behavior.</small></span>
            <span class="card-arrow" aria-hidden="true">→</span>
          </a>
        </nav>
        <div class="appearance-card">
          <div class="appearance-copy">
            <strong>Appearance</strong>
            <small>Use your system theme or choose one for this device.</small>
          </div>
          <div class="theme-options" role="group" aria-label="Appearance">
            {#each ['system', 'light', 'dark'] as preference}
              <button
                type="button"
                class:active={themeService.preference === preference}
                aria-pressed={themeService.preference === preference}
                onclick={() => setTheme(preference as ThemePreference)}
              >{preference[0].toUpperCase() + preference.slice(1)}</button>
            {/each}
          </div>
        </div>
      </section>

      <section class="settings-scope" aria-labelledby="host-settings-heading">
        <div class="scope-heading">
          <div>
            <h4 id="host-settings-heading">This host</h4>
            <p>{activeAssistant?.label ?? 'OpenPalm service administration'}</p>
          </div>
          <span class="scope-badge host">Host</span>
        </div>
        {#if showHostSettings}
          <nav class="settings-cards" aria-label="Host settings">
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve()d destination with encoded conversation return context -->
            <a class="settings-card" href={hostHref} onclick={closeDrawer}>
              <span class="settings-icon"><IconHome size={20} /></span>
              <span class="settings-copy"><strong>Open host dashboard</strong><small>Inspect status, updates, add-ons, and host configuration.</small></span>
              <span class="card-arrow" aria-hidden="true">→</span>
            </a>
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve()d destination with encoded conversation return context -->
            <a class="settings-card" href={hostVoiceHref} onclick={closeDrawer}>
              <span class="settings-icon"><IconAddons size={20} /></span>
              <span class="settings-copy"><strong>Manage host Voice</strong><small>Open the exact Voice add-on service and configuration.</small></span>
              <span class="card-arrow" aria-hidden="true">→</span>
            </a>
          </nav>
        {:else}
          <div class="host-unavailable" aria-disabled="true">
            <strong>Host administration unavailable</strong>
            <span>OpenPalm host controls are not available from this app.</span>
          </div>
        {/if}
      </section>

      <p class="return-note">All destinations return to {activeConversationTitle} on {activeAssistant?.label ?? 'your assistant'}.</p>
    </div>
  {/if}
</Drawer>

<style>
  .chat-nav,
  .context-nav,
  .primary-nav {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    min-width: 0;
  }
  .chat-nav {
    width: 100%;
  }
  .primary-nav {
    margin-left: auto;
  }
  .drawer-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-sp-2);
    min-width: 44px;
    height: 44px;
    padding: 0 var(--s-sp-3);
    border: var(--s-hair) solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--s-ink-2);
    font-family: var(--s-font-display);
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
  }
  .drawer-trigger:hover {
    background: var(--s-paper-deep);
    color: var(--s-ink);
  }
  .drawer-trigger.active {
    border-color: var(--s-seal);
    background: var(--s-paper-deep);
    color: var(--s-ink);
  }
  .drawer-trigger:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 2px;
  }
  .assistant-panel,
  .activity-panel,
  .settings-panel,
  .settings-scope,
  .settings-cards {
    display: flex;
    flex-direction: column;
  }
  .assistant-panel,
  .activity-panel,
  .settings-panel {
    gap: var(--s-sp-5);
  }
  .context-card {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
    padding: var(--s-sp-4);
    border-radius: 10px;
    background: var(--s-paper-deep);
    color: var(--s-ink-2);
    font-size: 0.8125rem;
    line-height: 1.45;
  }
  .context-card strong {
    color: var(--s-ink);
    font-size: 1rem;
  }
  .context-label,
  .settings-kicker {
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: 0.75rem;
  }
  .panel-route,
  .settings-card {
    box-sizing: border-box;
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) 20px;
    align-items: center;
    gap: var(--s-sp-3);
    min-height: 72px;
    padding: var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 10px;
    color: var(--s-ink);
    text-decoration: none;
  }
  .panel-route:hover,
  .settings-card:hover {
    border-color: var(--s-ink-3);
    background: var(--s-paper-deep);
  }
  .panel-route:focus-visible,
  .settings-card:focus-visible,
  .theme-options button:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 2px;
  }
  .panel-route > span:nth-child(2),
  .settings-copy,
  .appearance-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }
  .panel-route strong,
  .settings-copy strong,
  .appearance-copy strong {
    font-size: 0.9375rem;
  }
  .panel-route small,
  .settings-copy small,
  .appearance-copy small {
    color: var(--s-ink-2);
    font-size: 0.75rem;
    line-height: 1.45;
  }
  .route-icon,
  .settings-icon,
  .empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 8px;
    background: var(--s-paper-deep);
    color: var(--s-ink-2);
  }
  .scope-note,
  .return-note {
    margin: 0;
    color: var(--s-ink-2);
    font-size: 0.8125rem;
    line-height: 1.55;
  }
  .scope-note {
    padding: var(--s-sp-3);
    border-left: 3px solid var(--s-warning);
    background: color-mix(in srgb, var(--s-warning) 8%, transparent);
  }
  .empty-state,
  .host-unavailable {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-sp-2);
    padding: var(--s-sp-5);
    border: var(--s-hair) dashed var(--s-line-soft);
    border-radius: 10px;
    color: var(--s-ink-2);
    font-size: 0.875rem;
  }
  .empty-state strong,
  .host-unavailable strong {
    color: var(--s-ink);
    font-size: 1rem;
  }
  .settings-intro {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
    padding-bottom: var(--s-sp-4);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }
  .settings-intro p {
    margin: 0;
    color: var(--s-ink-2);
    font-size: 0.875rem;
    line-height: 1.55;
  }
  .settings-scope {
    gap: var(--s-sp-3);
  }
  .scope-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-sp-3);
  }
  .scope-heading h4 {
    margin: 0;
    color: var(--s-ink);
    font-family: var(--s-font-header);
    font-size: 1.125rem;
    font-weight: 600;
  }
  .scope-heading p {
    margin: 1px 0 0;
    color: var(--s-ink-3);
    font-size: 0.75rem;
  }
  .scope-badge {
    padding: 2px var(--s-sp-2);
    border-radius: 99px;
    background: color-mix(in srgb, var(--s-moss) 14%, transparent);
    color: var(--s-moss);
    font-family: var(--s-font-mono);
    font-size: 0.75rem;
    font-weight: 700;
  }
  .scope-badge.host {
    background: var(--s-paper-deep);
    color: var(--s-ink-2);
  }
  .settings-cards {
    gap: var(--s-sp-2);
  }
  .card-arrow {
    color: var(--s-ink-3);
    font-size: 1rem;
  }
  .appearance-card {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
    padding: var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 10px;
  }
  .theme-options {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--s-sp-1);
    padding: var(--s-sp-1);
    border-radius: 8px;
    background: var(--s-paper-deep);
  }
  .theme-options button {
    min-height: 44px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--s-ink-2);
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .theme-options button:hover {
    color: var(--s-ink);
  }
  .theme-options button.active {
    background: var(--s-paper);
    color: var(--s-ink);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--s-ink) 15%, transparent);
    font-weight: 700;
  }
  .return-note {
    padding-top: var(--s-sp-4);
    border-top: var(--s-hair) solid var(--s-line-soft);
  }

  @media (max-width: 999px) {
    .chat-nav {
      height: 112px;
      flex-direction: column;
      gap: 0;
    }
    .primary-nav {
      order: 1;
      width: 100%;
      height: 56px;
      padding-left: 52px;
      justify-content: flex-end;
      gap: var(--s-sp-1);
    }
    .context-nav {
      order: 2;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      width: 100%;
      height: 56px;
      gap: 0;
    }
  }

  @media (max-width: 480px) {
    .primary-nav {
      gap: 0;
    }
    .drawer-trigger {
      padding: 0 var(--s-sp-2);
    }
    .settings-trigger {
      width: 44px;
      padding: 0;
    }
    .settings-trigger span {
      display: none;
    }
  }

  @media (max-width: 479px) {
    .chat-nav {
      height: 144px;
    }
    .context-nav {
      display: flex;
      height: 88px;
      flex-direction: column;
    }
  }

</style>
