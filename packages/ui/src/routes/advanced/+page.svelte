<script lang="ts">
  import { page } from '$app/state';
  import { afterNavigate } from '$app/navigation';
  import { resolve as resolvePath } from '$app/paths';
  import { onMount } from 'svelte';
  import ChatNavbar from '$lib/components/chrome/ChatNavbar.svelte';
  import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
  import ChatInput from '$lib/components/chat/ChatInput.svelte';
  import PermissionCard from '$lib/components/chat/PermissionCard.svelte';
  import QuestionCard from '$lib/components/chat/QuestionCard.svelte';
  import { buildAdvancedIframeUrl } from '$lib/chat/navigation.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { getTransport } from '$lib/connections/boot.js';
  import { isLoopbackHost } from '$lib/connections/url-policy.js';
  import { onConnectionActivated } from '$lib/connection-events.js';

  // Phase 3b ("One UI, delete the split"): the browser owns connections and
  // talks to OpenCode DIRECTLY — there is no host proxy to probe. Embeddability
  // is classified from the active connection's URL + credentials:
  //   - an unauthenticated OpenCode web UI (loopback / same-scheme, no creds)
  //     embeds in an iframe pointed straight at connection.baseUrl;
  //   - a credentialed / Guardian connection can't carry Basic auth into an
  //     iframe, so we render the native chat surface (the existing chat
  //     components against the direct transport) instead of a dead-end.

  const active = $derived(endpointsService.active);
  const requestedSessionId = $derived(page.url.searchParams.get('session'));

  type Mode = 'checking' | 'iframe' | 'native' | 'dead';
  let mode = $state<Mode>('checking');
  // The resolved OpenCode web-UI URL for the iframe. Empty until resolve().
  let frameUrl = $state('');
  let reconnecting = $state(false);
  let reloadNonce = $state(0);
  let probeToken = 0; // discard stale async probe results

  /**
   * Can this connection's OpenCode web UI ride in an iframe? Only when it needs
   * no credentials (none attached, no URL userinfo) AND the browser won't block
   * it as mixed content (loopback, or same http(s) scheme as this app).
   */
  function isEmbeddable(conn: { baseUrl: string; hasPassword: boolean }): boolean {
    if (conn.hasPassword) return false;
    try {
      const url = new URL(conn.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      if (url.username || url.password) return false;
      if (isLoopbackHost(url.hostname)) return true;
      // Mixed content: an https app can't embed a plain-http remote target.
      if (page.url.protocol === 'https:' && url.protocol === 'http:') return false;
      return true;
    } catch {
      return false;
    }
  }

  function isCurrentProbe(token: number, connectionId: string): boolean {
    return token === probeToken && endpointsService.active?.id === connectionId;
  }

  async function resolve(reloadFrame = false): Promise<void> {
    const token = ++probeToken;
    mode = 'checking';
    frameUrl = '';
    const conn = endpointsService.active;
    if (!conn) {
      mode = 'dead';
      return;
    }

    // Credentialed / Guardian / mixed-content connection → native chat surface.
    if (!isEmbeddable(conn)) {
      mode = 'native';
      // The chat store now talks to the active connection via the direct
      // transport; make sure this connection's sessions are loaded.
      await chat.onEndpointChanged(conn.id);
      if (requestedSessionId) {
        void chat.openSession(requestedSessionId);
      }
      return;
    }

    // Embeddable: confirm reachability via the direct transport, then embed.
    const connectionId = conn.id;
    const base = conn.baseUrl;
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
          chat.alignActiveEndpoint(connectionId);
          chat.setActiveSessionId(sessionId, connectionId);
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

  async function reconnect(): Promise<void> {
    if (reconnecting) return;
    reconnecting = true;
    try {
      await endpointsService.load(true);
      await resolve(true);
    } finally {
      reconnecting = false;
    }
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
    document.documentElement.classList.add('chat-locked');
    document.body.classList.add('chat-locked');
    const stopWatchingConnections = onConnectionActivated(() => resolve());
    return () => {
      stopWatchingConnections();
      document.documentElement.classList.remove('chat-locked');
      document.body.classList.remove('chat-locked');
    };
  });

  // afterNavigate fires on initial load AND every same-route navigation (e.g.
  // switching to a different session while staying on /advanced). This is the
  // correct SvelteKit hook for "run on every arrival at this route" — no $effect.
  afterNavigate(() => {
    void endpointsService.load().then(() => resolve());
  });
</script>

<svelte:head>
  <title>Advanced Chat — OpenPalm</title>
</svelte:head>

<ChatNavbar />

<div class="advanced-layout">
  {#if mode === 'iframe'}
    <!-- The Chat↔Advanced switch is in the global navbar; session management
         lives inside OpenCode itself, so the frame fills the whole area.
         {#key} forces a fresh load after a reconnect even if the URL is unchanged. -->
    {#key reloadNonce}
      <iframe
        class="opencode-frame"
        src={frameUrl}
        title="OpenCode — Advanced Chat"
        allow="clipboard-read; clipboard-write; microphone"
      ></iframe>
    {/key}
  {:else if mode === 'native'}
    <!-- Credentialed / Guardian connection: OpenPalm keeps Basic auth out of
         iframe URLs, so the embedded OpenCode UI can't authenticate. Render the
         native chat surface (direct transport) instead of a dead-end. -->
    <section class="native-chat" aria-label="Chat with {active?.label ?? 'your assistant'}">
      <div class="native-scroll">
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
  {:else}
    <div class="advanced-status" role={mode === 'dead' ? 'alert' : 'status'} aria-live="polite">
      {#if mode === 'checking'}
        <p class="status-line">Connecting to {active?.label ?? 'your assistant'}…</p>
      {:else}
        <h2>Can’t reach {active?.label ?? 'your assistant'}</h2>
        <p>The connection looks dead or its session expired. Reconnect to try again, or pick a different assistant from the switcher above.</p>
        <button class="btn btn-primary btn-lg" onclick={reconnect} disabled={reconnecting}>
          {reconnecting ? 'Reconnecting…' : 'Reconnect'}
        </button>
        <a class="btn btn-secondary btn-lg" href={resolvePath('/connections')}>Manage connection</a>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Fill the viewport below the sticky navbar with the embedded OpenCode UI.
     dvh accounts for Android Chrome's dynamic toolbar shrinkage. */
  .advanced-layout {
    height: calc(100dvh - var(--nav-height));
    width: 100%;
    background: var(--s-paper);
    display: flex;
    flex-direction: column;
  }

  .opencode-frame {
    display: block;
    width: 100%;
    flex: 1;
    border: none;
  }

  .native-chat {
    flex: 1;
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
</style>
