<script lang="ts">
  import { page } from '$app/state';
  import { afterNavigate, goto } from '$app/navigation';
  import { resolve as resolvePath } from '$app/paths';
  import { onMount } from 'svelte';
  import ConversationFrame from '$lib/components/chrome/ConversationFrame.svelte';
  import ChatFooter from '$lib/components/chat/ChatFooter.svelte';
  import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
  import ChatInput from '$lib/components/chat/ChatInput.svelte';
  import PermissionCard from '$lib/components/chat/PermissionCard.svelte';
  import QuestionCard from '$lib/components/chat/QuestionCard.svelte';
  import { buildAdvancedIframeUrl, buildAdvancedPath } from '$lib/chat/navigation.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { getTransport } from '$lib/connections/boot.js';
  import { isEmbeddableOpencodeUi, isWorkspaceReachable, resolveWorkspaceUrl } from './embeddable.js';
  import { getRuntimeContext } from '$lib/runtime-context.svelte.js';
  import { onConnectionActivated } from '$lib/connection-events.js';
  import { resolveSessionTitle } from '$lib/session-title.js';
  import { themeService } from '$lib/theme-state.svelte.js';

  // Phase 3b ("One UI, delete the split"): the browser owns connections and
  // talks to OpenCode DIRECTLY — there is no host proxy to probe. Which
  // OpenCode web UI this page frames (or whether it can frame one at all) is
  // decided in ./embeddable.ts; the two cases that reach the native chat
  // surface instead are a credentialed / Guardian connection, and an app-origin
  // connection with no reachable workspace advertisement.

  const runtimeContext = getRuntimeContext();
  const active = $derived(endpointsService.active);
  /**
   * The workspace listener's origin — OpenCode's own web UI at an origin root,
   * behind this app's session, with OpenCode's credential attached server-side
   * (server/workspace-listener.ts). The locked default connection is this app's
   * `/oc` API proxy, which cannot be framed (embeddable.ts), so this is what
   * the frame points at instead.
   *
   * One address serves both uses on this page — the iframe and the new-tab
   * escape hatch below it — because nothing about it is client-dependent: the
   * browser holds no OpenCode credential either way, only the OpenPalm session
   * cookie it already has.
   */
  const workspaceUrl = $derived(
    resolveWorkspaceUrl(
      runtimeContext.opencodeWorkspace,
      { hostname: page.url.hostname, protocol: page.url.protocol },
      active,
    ),
  );
  const requestedSessionId = $derived(page.url.searchParams.get('session'));
  const requestedAssistantId = $derived(page.url.searchParams.get('assistant'));

  type Mode = 'checking' | 'iframe' | 'native' | 'dead';
  let mode = $state<Mode>('checking');
  // The resolved OpenCode web-UI URL for the iframe. Empty until resolve().
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

  /** See embeddable.ts for the three rules this decision encodes. */
  function isEmbeddable(conn: { baseUrl: string; hasPassword: boolean }): boolean {
    return isEmbeddableOpencodeUi(conn, {
      origin: page.url.origin,
      protocol: page.url.protocol,
    });
  }

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

    // Where OpenCode's own web UI lives for this connection: the connection
    // itself when it names an OpenCode origin, otherwise this install's
    // advertised workspace. Null when there is neither.
    //
    // The workspace address is composed from the page, so it is a well-formed
    // guess rather than a promise — whether the port is actually forwarded
    // through whatever fronts this app is a fact only the browser can measure.
    // Measuring it here costs one round trip and is what keeps a deployment
    // that has not opened that port on the native chat surface instead of
    // staring at a blank frame.
    const workspaceOnly = !isEmbeddable(conn);
    const base = workspaceOnly ? workspaceUrl : conn.baseUrl;
    const usable = base !== null && (!workspaceOnly || (await isWorkspaceReachable(base)));
    if (!isCurrentProbe(token, conn.id)) return;
    if (!usable) {
      mode = 'native';
      // The chat store now talks to the active connection via the direct
      // transport; make sure this connection's sessions are loaded.
      await chat.onEndpointChanged(conn.id);
      if (requestedSessionId) {
        await chat.openSession(requestedSessionId);
      }
      return;
    }

    // Confirm the assistant answers via the direct transport, then embed. The
    // probe goes to the CONNECTION, not to `base`: both name the same OpenCode,
    // and the connection is the one path this browser is allowed to call.
    const connectionId = conn.id;
    const sessionId = requestedSessionId;
    const health = await getTransport().probeHealth();
    if (!isCurrentProbe(token, connectionId)) return;
    if (health.status !== 'accessible') {
      mode = 'dead';
      return;
    }

    let url = base;
    if (sessionId) {
      // Resolve the requested session on THIS connection for its real directory
      // (OpenCode scopes its session list by directory). A missing/foreign
      // session falls back to the base URL rather than a broken deep link.
      try {
        const res = await getTransport().request('GET', `/session/${encodeURIComponent(sessionId)}`);
        if (!isCurrentProbe(token, connectionId)) return;
        const session: unknown = await res.json().catch(() => null);
        const directory =
          session && typeof session === 'object' && 'directory' in session &&
          typeof session.directory === 'string' && session.directory.length > 0
            ? session.directory
            : null;
        if (directory) {
          url = buildAdvancedIframeUrl(base, sessionId, directory);
          await chat.onEndpointChanged(connectionId);
          if (!isCurrentProbe(token, connectionId)) return;
          await chat.openSession(sessionId);
        }
      } catch {
        // non-ok / unreachable → leave url = base (no broken deep link)
      }
    }
    if (!isCurrentProbe(token, connectionId)) return;
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

  // ── Native chat surface wiring (credentialed fallback) ───────────────────
  let permissionActionInFlight = $state<'once' | 'always' | 'reject' | null>(null);

  async function handleSend(text: string): Promise<void> {
    await chat.send(text);
  }

  async function handlePermissionReply(reply: 'once' | 'always' | 'reject'): Promise<void> {
    permissionActionInFlight = reply;
    try {
      await chat.answerPermission(reply);
    } finally {
      permissionActionInFlight = null;
    }
  }

  // Lock scroll on mount; restore on destroy. This is a CSS side-effect tied to
  // component lifetime, not navigation, so onMount is correct here.
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
    {:else if mode === 'native'}
      <!-- No OpenCode web UI this browser can reach: the connection is
           credentialed (OpenPalm keeps Basic auth out of iframe URLs, so the
           embedded UI could not authenticate), or it is this app's own /oc API
           pass-through and the workspace port is either unadvertised or not
           forwarded to this browser. No new-tab link here: the same address
           the frame would use is the one that just failed. -->
      <div class="native-shell">
        <section class="native-chat" aria-label="Chat with {active?.label ?? 'your assistant'}">
          <div class="native-scroll">
            <p class="native-notice" role="note">
              The OpenCode workspace can’t be embedded for this assistant — this conversation
              runs on OpenPalm’s own surface.
            </p>
            {#if chat.entriesLoading}
              <p class="native-status" role="status">Loading conversation…</p>
            {:else if chat.entries.length === 0}
              <p class="native-status" role="status">
                Start chatting with {active?.label ?? 'your assistant'} below.
              </p>
            {/if}
            {#each chat.entries as entry (entry.id)}
              <ChatMessage {entry} />
            {/each}
            {#if chat.pendingAssistantText}
              <div class="native-pending">{chat.pendingAssistantText}</div>
            {/if}
            {#if chat.pendingPermission}
              <PermissionCard
                permission={chat.pendingPermission}
                actionInFlight={permissionActionInFlight}
                onReply={handlePermissionReply}
              />
            {/if}
            {#if chat.pendingQuestion}
              <QuestionCard
                question={chat.pendingQuestion}
                onOption={(answer) => void chat.answerQuestion(answer)}
                onSelect={(index, label) => chat.setQuestionAnswer(index, label)}
                onDraft={(index, value) => chat.setQuestionAnswer(index, value)}
                onSubmit={() => void chat.answerQuestion()}
                onReject={() => void chat.rejectQuestion()}
              />
            {/if}
          </div>
          {#if chat.error}
            <div class="alert error" role="alert">{chat.error}</div>
          {/if}
          <ChatInput
            sending={chat.sending}
            questionPending={chat.pendingQuestion?.status === 'pending'}
            onSend={handleSend}
            onStop={() => void chat.stopTurn()}
          />
        </section>
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
          {#if workspaceUrl}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- OpenCode's own origin, composed from the server's published-port advertisement -->
            <a class="workspace-link" href={workspaceUrl} target="_blank" rel="noopener noreferrer"
              >Open the OpenCode workspace in a new tab</a
            >
          {/if}
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

  /* min-width: 0 on both: a flex item's default min-width is its MIN-CONTENT
     width, so one unbreakable run of text in a message would otherwise push
     this column past the viewport (same rule as ConversationFrame's content). */
  .native-shell {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
  }
  .native-chat {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .native-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
    padding: var(--s-sp-4);
    max-width: 52rem;
    width: 100%;
    margin: 0 auto;
  }
  .native-status {
    color: var(--s-ink-2);
    text-align: center;
    margin: var(--s-sp-6) 0;
  }
  /* The composer sits directly under the scrolling thread here (the chat page
     nests it inside ChatFooter, which supplies this separation). Without a
     rule the last line of a message reads as part of the input. */
  .native-chat :global(.s-composer) {
    border-top: var(--s-hair) solid var(--s-line);
    padding: var(--s-sp-3) var(--s-sp-4);
  }
  .native-notice {
    margin: 0 0 var(--s-sp-2);
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    line-height: 1.5;
    text-align: center;
    overflow-wrap: anywhere;
  }
  .workspace-link {
    color: var(--s-ink-2);
    text-decoration: underline;
    text-underline-offset: 0.15em;
    overflow-wrap: anywhere;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
  }
  .native-pending {
    white-space: pre-wrap;
    color: var(--s-ink-2);
  }

  .alert.error {
    margin: 0 auto var(--s-sp-2);
    max-width: 52rem;
    width: 100%;
    padding: var(--s-sp-3);
    border-radius: 2px;
    background: color-mix(in srgb, var(--s-seal) 8%, transparent);
    color: var(--s-seal);
    border: 1px solid color-mix(in srgb, var(--s-seal) 25%, transparent);
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

  @media (max-width: 900px) {
    .native-shell { flex-direction: column; }
  }

  @media (prefers-reduced-motion: reduce) {
    .loading-mark { animation: none; }
  }
</style>
