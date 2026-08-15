<script lang="ts">
  import { page } from '$app/state';
  import { afterNavigate, goto } from '$app/navigation';
  import { resolve as resolvePath } from '$app/paths';
  import { onMount } from 'svelte';
  import ConversationFrame from '$lib/components/chrome/ConversationFrame.svelte';
  import ChatFooter from '$lib/components/chat/ChatFooter.svelte';
  import { buildAdvancedPath, buildChatPath } from '$lib/chat/navigation.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { getTransport } from '$lib/connections/boot.js';
  import { opencodeWebSessionUrl, opencodeWebShellUrl } from '$lib/opencode-web.js';
  import { resolveFrameBase } from './embeddable.js';
  import { onConnectionActivated } from '$lib/connection-events.js';
  import { resolveSessionTitle } from '$lib/session-title.js';
  import { themeService } from '$lib/theme-state.svelte.js';

  // /advanced embeds OpenCode's web UI. The locked default connection frames
  // the static bundle at /opencode-ui/ (built from pinned source with a real
  // base path — $lib/opencode-web.ts), whose API calls ride the same-origin
  // session-gated /oc proxy; a user-added connection naming a framable
  // OpenCode origin frames that origin directly. resolveFrameBase in
  // ./embeddable.ts owns the whole decision. A connection that is neither
  // (credentialed, Guardian, mixed-content) gets a notice pointing at /chat —
  // the full-featured surface for those connections.

  const active = $derived(endpointsService.active);
  const requestedSessionId = $derived(page.url.searchParams.get('session'));
  const requestedAssistantId = $derived(page.url.searchParams.get('assistant'));

  type Mode = 'checking' | 'iframe' | 'unembeddable' | 'dead';
  let mode = $state<Mode>('checking');
  // The resolved frame URL. Empty until resolve().
  let frameUrl = $state('');
  let frameReady = $state(false);
  let frameReadyTimer: number | undefined;
  let reconnecting = $state(false);
  let reloadNonce = $state(0);
  let navigationOpen = $state(false);
  let probeToken = 0; // discard stale async probe results

  const activeSession = $derived(
    active
      ? chat.byEndpoint
          .get(active.id)
          ?.sessions.find((session) => session.id === (requestedSessionId ?? chat.activeSessionId)) ?? null
      : null,
  );
  const activeConversationTitle = $derived(
    activeSession ? resolveSessionTitle(activeSession.title) : 'OpenPalm conversation',
  );

  function isCurrentProbe(token: number, connectionId: string): boolean {
    return token === probeToken && endpointsService.active?.id === connectionId;
  }

  async function resolve(reloadFrame = false): Promise<void> {
    const token = ++probeToken;
    if (frameReadyTimer !== undefined) window.clearTimeout(frameReadyTimer);
    frameReadyTimer = undefined;
    mode = 'checking';
    frameUrl = '';
    frameReady = false;
    const conn = endpointsService.active;
    if (!conn) {
      mode = 'dead';
      return;
    }

    const base = resolveFrameBase(conn, { origin: page.url.origin, protocol: page.url.protocol });
    if (!base) {
      mode = 'unembeddable';
      return;
    }

    // Confirm the assistant answers via the direct transport, then embed —
    // otherwise the frame renders a dead workspace with no way to say why.
    const connectionId = conn.id;
    const sessionId = requestedSessionId;
    const health = await getTransport().probeHealth();
    if (!isCurrentProbe(token, connectionId)) return;
    if (health.status !== 'accessible') {
      mode = 'dead';
      return;
    }

    let url = base;
    if (sessionId && base === opencodeWebShellUrl()) {
      // Session deep link — a client-side route of the bundled app, computed
      // entirely here (the app's server identity is this origin's /oc). Only
      // the local bundle can be deep-linked; a remote OpenCode frames its own
      // default view. Keep the chat store on the same session so ChatNavbar's
      // picker and the loading title name the right thread.
      url = opencodeWebSessionUrl(page.url.origin, sessionId);
      await chat.onEndpointChanged(connectionId);
      if (!isCurrentProbe(token, connectionId)) return;
      await chat.openSession(sessionId);
      if (!isCurrentProbe(token, connectionId)) return;
    }
    frameUrl = url;
    mode = 'iframe';
    if (reloadFrame) reloadNonce++;
  }

  async function resolveRoute(reloadFrame = false): Promise<void> {
    const routeToken = ++probeToken;
    mode = 'checking';
    frameUrl = '';
    // load() shares one in-flight request across concurrent callers (ChatNavbar
    // may already own it), so this awaits the actual settle before matching the
    // route's assistant instead of probing a stale active one.
    await endpointsService.load(reloadFrame);
    if (routeToken !== probeToken) return;

    const requestedAssistant = requestedAssistantId
      ? endpointsService.endpoints.find((connection) => connection.id === requestedAssistantId)
      : null;
    if (requestedAssistantId && !requestedAssistant) {
      mode = 'dead';
      frameUrl = '';
      return;
    }
    if (requestedAssistant && requestedAssistant.id !== endpointsService.activeId) {
      await endpointsService.activate(requestedAssistant.id);
    }
    if (routeToken !== probeToken) return;
    await resolve(reloadFrame);
  }

  async function followActivatedAssistant(assistantId: string): Promise<void> {
    if (assistantId === requestedAssistantId) return;
    const target = buildAdvancedPath(chat.activeSessionId, assistantId);
    if (`${page.url.pathname}${page.url.search}` === target) return;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- canonical assistant/session path built internally
    await goto(target, { replaceState: true });
  }

  async function reconnect(): Promise<void> {
    if (reconnecting) return;
    reconnecting = true;
    try {
      await resolveRoute(true);
    } finally {
      reconnecting = false;
    }
  }

  function markFrameReady(): void {
    if (frameReadyTimer !== undefined) window.clearTimeout(frameReadyTimer);
    // OpenCode hydrates after the iframe load event. Keep the owned loading
    // state visible long enough to avoid presenting its empty canvas as ready.
    frameReadyTimer = window.setTimeout(() => {
      frameReady = true;
      frameReadyTimer = undefined;
    }, 600);
  }

  onMount(() => {
    const stopWatchingConnections = onConnectionActivated(followActivatedAssistant);
    return () => {
      if (frameReadyTimer !== undefined) window.clearTimeout(frameReadyTimer);
      stopWatchingConnections();
    };
  });

  // afterNavigate fires on initial load AND every same-route navigation (e.g.
  // switching to a different session while staying on /advanced). This is the
  // correct SvelteKit hook for "run on every arrival at this route" — no $effect.
  afterNavigate(() => {
    void resolveRoute();
  });
</script>

<svelte:head>
  <title>Advanced Chat — OpenPalm</title>
</svelte:head>

<!-- Advanced view keeps the conversation controls: the assistant and
     conversation pickers are how you know WHICH assistant and WHICH thread the
     workspace below is showing, and switching either is as reasonable here as
     it is in chat. Leaving them out also stripped the drawer they open and the
     taller navbar that gives them room. -->
<ConversationFrame bind:drawerOpen={navigationOpen}>
<main class="advanced-layout" inert={navigationOpen}>
  <div class="advanced-workspace">
    {#if mode === 'iframe'}
      <div class="opencode-shell">
        {#key reloadNonce}
          <iframe
            class="opencode-frame"
            style:color-scheme={themeService.resolved}
            src={frameUrl}
            title="OpenCode — Advanced Chat"
            allow="clipboard-read; clipboard-write; microphone"
            onload={markFrameReady}
          ></iframe>
        {/key}
        {#if !frameReady}
          <div class="frame-loading" role="status">
            <span class="loading-mark" aria-hidden="true"></span>
            <strong>Opening OpenCode</strong>
            <span>Restoring {activeConversationTitle} on {active?.label ?? 'your assistant'}…</span>
          </div>
        {/if}
      </div>
    {:else if mode === 'unembeddable'}
      <!-- A connection this page cannot frame: credentialed or Guardian
           (OpenPalm keeps Basic auth out of iframe URLs, so an embedded UI
           could not authenticate), or a remote OpenCode the browser refuses
           (mixed content). /chat is the full-featured surface for these. -->
      <div class="advanced-status" role="status">
        <h2>This assistant can’t be embedded here</h2>
        <p>
          {active?.label ?? 'This connection'} can’t host the OpenCode workspace in a frame.
          Chat works with every connection.
        </p>
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- target is built by typed internal navigation helpers -->
        <a class="btn btn-primary btn-lg" href={buildChatPath(chat.activeSessionId, active?.id)}
          >Continue in Chat</a
        >
      </div>
    {:else}
      <div class="advanced-status" role={mode === 'dead' ? 'alert' : 'status'} aria-live="polite">
        {#if mode === 'checking'}
          <p class="status-line">Connecting to {active?.label ?? 'your assistant'}…</p>
        {:else}
          <h2>Can’t reach {active?.label ?? 'your assistant'}</h2>
          <p>The assistant is unavailable or this conversation expired. Reconnect, or choose a different assistant above.</p>
          <button class="btn btn-primary btn-lg" onclick={reconnect} disabled={reconnecting}>
            {reconnecting ? 'Reconnecting…' : 'Reconnect'}
          </button>
          <a class="btn btn-secondary btn-lg" href={resolvePath('/connections')}>Manage connection</a>
        {/if}
      </div>
    {/if}
  </div>
</main>
{#snippet footer()}
  <ChatFooter thinking={chat.sending} />
{/snippet}
</ConversationFrame>

<style>
  .advanced-layout {
    height: 100%;
    width: 100%;
    background: var(--s-paper);
    display: flex;
    flex-direction: row;
  }

  .advanced-workspace {
    position: relative;
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
  }

  .opencode-frame {
    display: block;
    width: 100%;
    height: 100%;
    flex: 1;
    border: none;
    background: var(--s-paper-deep);
  }
  .opencode-shell {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .frame-loading {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: var(--s-sp-2);
    padding: var(--s-sp-6);
    background: var(--s-paper-deep);
    color: var(--s-ink-2);
    text-align: center;
    font-size: 0.875rem;
  }
  .frame-loading strong {
    color: var(--s-ink);
    font-size: 1rem;
  }
  .loading-mark {
    width: 24px;
    height: 24px;
    border: 2px solid var(--s-line-soft);
    border-right-color: var(--s-seal);
    border-radius: 50%;
    animation: frame-spin 800ms linear infinite;
  }
  @keyframes frame-spin {
    to { transform: rotate(360deg); }
  }

  .advanced-status {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: var(--s-sp-3);
    padding: var(--s-sp-6);
    font-family: var(--s-font-display);
    color: var(--s-ink);
  }
  .advanced-status h2 { margin: 0; font-size: 1.25rem; color: var(--s-ink); font-weight: 400; }
  .advanced-status p { margin: 0; max-width: 26rem; color: var(--s-ink-2); line-height: 1.55; }
  .advanced-status .status-line { color: var(--s-ink-2); }
  .advanced-status .btn { margin-top: var(--s-sp-3); text-decoration: none; }

  @media (prefers-reduced-motion: reduce) {
    .loading-mark { animation: none; }
  }
</style>
