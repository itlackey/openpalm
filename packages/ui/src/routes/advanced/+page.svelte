<script lang="ts">
  import { page } from '$app/state';
  import { afterNavigate } from '$app/navigation';
  import { resolve as resolvePath } from '$app/paths';
  import { onMount } from 'svelte';
  import ChatNavbar from '$lib/components/chrome/ChatNavbar.svelte';
  import { buildAdvancedIframeUrl } from '$lib/chat/navigation.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { onConnectionActivated } from '$lib/connection-events.js';

  // Auth is enforced server-side in hooks.server.ts; this page only renders
  // when the visitor is already an authenticated admin.

  const active = $derived(endpointsService.active);
  const requestedSessionId = $derived(page.url.searchParams.get('session'));

  // The resolved OpenCode web-UI URL. Set by resolve() once we've confirmed the
  // active endpoint is reachable and (if a session was requested) that the
  // session exists there — with its REAL directory. Empty until first resolve.
  let frameUrl = $state('');

  // The embedded OpenCode UI loads directly from the endpoint. A same-origin
  // proxy probe may use server-held credentials, but an iframe cannot, so only
  // raw unauthenticated OpenCode targets are eligible for embedding.
  type Probe =
    | 'checking'
    | 'ready'
    | 'dead'
    | 'credentialed'
    | 'mixed-content'
    | 'invalid';
  let probeState = $state<Probe>('checking');
  let reconnecting = $state(false);
  let reloadNonce = $state(0);
  let probeToken = 0; // discard stale async probe results

  function classifyUrl(raw: string): 'safe' | 'credentialed' | 'mixed-content' | 'invalid' {
    try {
      const url = new URL(raw);
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        return 'invalid';
      }
      if (url.username.length > 0 || url.password.length > 0) return 'credentialed';
      const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
      if (page.url.protocol === 'https:' && url.protocol === 'http:' && !loopback) {
        return 'mixed-content';
      }
      return 'safe';
    } catch {
      return 'invalid';
    }
  }

  function isCurrentProbe(token: number, endpointId: string): boolean {
    return token === probeToken && endpointsService.active?.id === endpointId;
  }

  async function resolve(reloadFrame = false): Promise<void> {
    const token = ++probeToken;
    probeState = 'checking';
    frameUrl = '';
    const endpoint = endpointsService.active;
    if (!endpoint) {
      probeState = 'dead';
      return;
    }
    const urlKind = classifyUrl(endpoint.url);
    if (endpoint.hasPassword || urlKind === 'credentialed') {
      probeState = 'credentialed';
      return;
    }
    if (urlKind === 'mixed-content') {
      probeState = 'mixed-content';
      return;
    }
    if (urlKind === 'invalid') {
      probeState = 'invalid';
      return;
    }
    const endpointId = endpoint.id;
    const base = endpoint.url;
    const sessionId = requestedSessionId;
    try {
      // 1. Reachability: root of the OpenCode web server via the proxy → 200
      //    when reachable, 503 (endpoint_unreachable) / non-OK when dead.
      const root = await fetch('/proxy/assistant/', { headers: { accept: 'text/html' } });
      if (!isCurrentProbe(token, endpointId)) return;
      if (!root.ok) { probeState = 'dead'; return; }

      // 2. Resolve the requested session ON THE ACTIVE ENDPOINT. OpenCode scopes
      //    its session list by directory, so deep-linking needs the session's
      //    real `directory`; and a session created on a DIFFERENT endpoint (or
      //    since deleted) 404s here. In both bad cases fall back to the base URL
      //    (OpenCode opens its default view) rather than a "Session not found".
      let url = base;
      if (sessionId) {
        const res = await fetch(
          `/proxy/assistant/session/${encodeURIComponent(sessionId)}`,
          { headers: { accept: 'application/json' } },
        );
        if (!isCurrentProbe(token, endpointId)) return;
        if (res.ok) {
          const session: unknown = await res.json().catch(() => null);
          if (!isCurrentProbe(token, endpointId)) return;
          const directory =
            session &&
            typeof session === 'object' &&
            'directory' in session &&
            typeof session.directory === 'string' &&
            session.directory.length > 0
              ? session.directory
              : null;
          if (directory) {
            url = buildAdvancedIframeUrl(base, sessionId, directory);
            chat.alignActiveEndpoint(endpointId);
            chat.setActiveSessionId(sessionId, endpointId);
          }
        }
        // non-ok → leave url = base (no broken deep link)
      }
      if (!isCurrentProbe(token, endpointId)) return;
      frameUrl = url;
      probeState = 'ready';
      if (reloadFrame) reloadNonce++;
    } catch {
      if (!isCurrentProbe(token, endpointId)) return;
      probeState = 'dead';
    }
  }

  async function reconnect(): Promise<void> {
    if (reconnecting) return;
    reconnecting = true;
    try {
      // Re-read the endpoint list first — a restarted admin OpenCode advertises a
      // new ephemeral URL in its runtime file, so the cached frame URL may be stale.
      await endpointsService.load(true);
      await resolve(true);
    } finally {
      reconnecting = false;
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
  {#if probeState === 'ready'}
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
  {:else}
    <div class="advanced-status" role={probeState === 'dead' ? 'alert' : 'status'} aria-live="polite">
      {#if probeState === 'checking'}
        <p class="status-line">Connecting to {active?.label ?? 'your assistant'}…</p>
      {:else if probeState === 'credentialed'}
        <h2>Advanced UI unavailable for this secured connection</h2>
        <p>
          This OpenCode connection requires credentials. OpenPalm keeps them out of iframe URLs and
          browser content; use Chat here or manage the connection through a trusted external route.
        </p>
        <a class="btn btn-secondary btn-lg" href={resolvePath('/connections')}>Manage connection</a>
      {:else if probeState === 'mixed-content'}
        <h2>Advanced UI unavailable over this connection</h2>
        <p>
          This page is running over HTTPS, so the browser will block an embedded plain-HTTP remote
          OpenCode server as mixed content. Configure HTTPS for that connection or continue in Chat.
        </p>
        <a class="btn btn-secondary btn-lg" href={resolvePath('/connections')}>Manage connection</a>
      {:else if probeState === 'invalid'}
        <h2>Advanced UI unavailable for this endpoint</h2>
        <p>
          Advanced mode requires a plain HTTP(S) endpoint URL without user information, a query,
          or a fragment. Update this connection before embedding its OpenCode interface.
        </p>
        <a class="btn btn-secondary btn-lg" href={resolvePath('/connections')}>Manage connection</a>
      {:else}
        <h2>Can’t reach {active?.label ?? 'your assistant'}</h2>
        <p>The connection looks dead or its session expired. Reconnect to try again, or pick a different assistant from the switcher above.</p>
        <button class="btn btn-primary btn-lg" onclick={reconnect} disabled={reconnecting}>
          {reconnecting ? 'Reconnecting…' : 'Reconnect'}
        </button>
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
