<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Drawer from '$lib/components/common/Drawer.svelte';
  import IconConnect from '$lib/components/icons/IconConnect.svelte';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import SurfaceToolbar from '$lib/components/chrome/SurfaceToolbar.svelte';
  import EndpointList from '$lib/components/chat/EndpointList.svelte';
  import EndpointSwitcher from '$lib/components/chat/EndpointSwitcher.svelte';
  import SessionList from '$lib/components/chat/SessionList.svelte';
  import SessionPicker from '$lib/components/chat/SessionPicker.svelte';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { buildConversationPath, buildReturnToPath } from '$lib/chat/navigation.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { getRuntimeContext, hasCapability } from '$lib/runtime-context.svelte.js';
  import { resolveSessionTitle } from '$lib/session-title.js';

  type DrawerName = 'assistant' | 'conversation';

  interface Props {
    drawerOpen?: boolean;
    showConversationControls?: boolean;
  }
  let {
    drawerOpen = $bindable(false),
    showConversationControls = true,
  }: Props = $props();

  const DRAWER_ID = 'chat-navbar-drawer';
  const runtimeContext = getRuntimeContext();
  let activeDrawer = $state<DrawerName | null>(null);
  let drawerShowing = $state(false);

  const pathname = $derived(page.url?.pathname ?? '');
  const activeAssistant = $derived(endpointsService.active);
  const conversationModePathname = $derived(
    pathname === '/advanced' || pathname.startsWith('/advanced/')
      ? '/advanced'
      : pathname === '/chat' || pathname.startsWith('/chat/')
        ? '/chat'
        : advancedModeService.enabled
          ? '/advanced'
          : '/chat'
  );
  const activeSessionId = $derived(page.url.searchParams.get('session') ?? chat.activeSessionId);
  const endpointState = $derived(
    activeAssistant ? (chat.byEndpoint.get(activeAssistant.id) ?? null) : null
  );
  const activeSession = $derived(
    endpointState?.sessions.find((session) => session.id === activeSessionId) ?? null
  );
  const activeConversationTitle = $derived(
    activeSession ? resolveSessionTitle(activeSession.title) : 'New conversation'
  );
  const conversationPath = $derived(
    buildConversationPath(conversationModePathname, activeSessionId, activeAssistant?.id)
  );
  const settingsHref = $derived(buildReturnToPath(resolve('/connections'), conversationPath));
  const hostHref = $derived(
    runtimeContext.routes.host !== undefined && hasCapability(runtimeContext, 'host:stack:read')
      ? buildReturnToPath(runtimeContext.routes.host, conversationPath)
      : null
  );
  const drawerTitle = $derived(activeDrawer === 'assistant' ? 'Switch assistant' : 'Conversations');

  function toggleDrawer(name: DrawerName): void {
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

  // Close the drawer on any navigation — including a same-route session/assistant
  // change, which does not remount this component — so a modal drawer never
  // lingers open with the background inert over the navigated-to page (#473).
  afterNavigate(() => {
    if (drawerOpen || drawerShowing) {
      drawerShowing = false;
      drawerOpen = false;
      activeDrawer = null;
    }
  });
</script>

<Navbar
  brandHref={conversationPath}
  inactive={drawerOpen}
  showUtilities={false}
  conversation={showConversationControls}
>
  <div class="chat-nav" class:context-hidden={!showConversationControls}>
    {#if showConversationControls}
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
    {/if}
    <SurfaceToolbar
      {settingsHref}
      {hostHref}
      compact={!showConversationControls}
      modeSessionId={chat.activeSessionId}
      modeAssistantId={chat.activeEndpointId}
    />
  </div>
</Navbar>

{#if showConversationControls}
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
        <a class="panel-route" href={settingsHref} onclick={closeDrawer}>
          <span class="route-icon"><IconConnect size={20} /></span>
          <span
            ><strong>Manage assistant connections</strong><small
              >Connections are stored in this browser on this device.</small
            ></span
          >
          <span aria-hidden="true">→</span>
        </a>
      </div>
    {:else if activeDrawer === 'conversation'}
      <SessionList onChosen={closeDrawer} />
    {/if}
  </Drawer>
{/if}

<style>
  .chat-nav,
  .context-nav {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    min-width: 0;
  }
  .chat-nav {
    width: 100%;
    transition: height 220ms var(--s-ease);
  }
  /* The pickers live here and are the only shrinkable things in the row — the
     toolbar's icon buttons all set flex-shrink:0 — so this wrapper has to be
     allowed to give ground, or the pressure has nowhere to go. */
  .context-nav {
    flex: 1 1 auto;
    overflow: hidden;
  }
  .assistant-panel {
    display: flex;
    flex-direction: column;
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
  .context-label {
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: 0.75rem;
  }
  .panel-route {
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
  .panel-route:hover {
    border-color: var(--s-ink-3);
    background: var(--s-paper-deep);
  }
  .panel-route:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 2px;
  }
  .panel-route > span:nth-child(2) {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }
  .panel-route strong {
    font-size: 0.9375rem;
  }
  .panel-route small {
    color: var(--s-ink-2);
    font-size: 0.75rem;
    line-height: 1.45;
  }
  .route-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 8px;
    background: var(--s-paper-deep);
    color: var(--s-ink-2);
  }
  @media (max-width: 999px) {
    .chat-nav {
      height: 112px;
      flex-direction: column;
      gap: 0;
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

  @media (max-width: 999px) {
    .chat-nav.context-hidden {
      height: 52px;
      flex-direction: row;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-nav {
      transition: none;
    }
  }
</style>
