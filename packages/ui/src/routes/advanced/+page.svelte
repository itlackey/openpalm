<script lang="ts">
  import { page } from '$app/state';
  import { afterNavigate } from '$app/navigation';
  import { onMount } from 'svelte';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import { buildAdvancedIframeUrl } from '$lib/chat/navigation.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';

  // Auth is enforced server-side in hooks.server.ts; this page only renders
  // when the visitor is already an authenticated admin.

  const active = $derived(endpointsService.active);
  const requestedSessionId = $derived(page.url.searchParams.get('session'));

  // The resolved OpenCode web-UI URL. Set by resolve() once we've confirmed the
  // active endpoint is reachable and (if a session was requested) that the
  // session exists there — with its REAL directory. Empty until first resolve.
  let frameUrl = $state('');

  // The embedded OpenCode UI loads cross-origin, so the parent can't observe a
  // 401 / dead-session / session-not-found failure (no error event, opaque
  // contentDocument). Instead we pre-flight through the same-origin proxy (which
  // targets the active endpoint server-side): if reachable, render the frame; if
  // not, show an inline Reconnect affordance instead of a broken frame.
  type Probe = 'checking' | 'ready' | 'dead';
  let probeState = $state<Probe>('checking');
  let reconnecting = $state(false);
  let reloadNonce = $state(0);
  let probeToken = 0; // discard stale async probe results

  async function resolve(): Promise<void> {
    const token = ++probeToken;
    probeState = 'checking';
    const base = active?.url ?? 'http://127.0.0.1:3800';
    try {
      // 1. Reachability: root of the OpenCode web server via the proxy → 200
      //    when reachable, 503 (endpoint_unreachable) / non-OK when dead.
      const root = await fetch('/proxy/assistant/', { headers: { accept: 'text/html' } });
      if (token !== probeToken) return; // a newer resolve superseded this one
      if (!root.ok) { probeState = 'dead'; return; }

      // 2. Resolve the requested session ON THE ACTIVE ENDPOINT. OpenCode scopes
      //    its session list by directory, so deep-linking needs the session's
      //    real `directory`; and a session created on a DIFFERENT endpoint (or
      //    since deleted) 404s here. In both bad cases fall back to the base URL
      //    (OpenCode opens its default view) rather than a "Session not found".
      let url = base;
      if (requestedSessionId) {
        const res = await fetch(
          `/proxy/assistant/session/${encodeURIComponent(requestedSessionId)}`,
          { headers: { accept: 'application/json' } },
        );
        if (token !== probeToken) return;
        if (res.ok) {
          const session = await res.json().catch(() => null);
          if (token !== probeToken) return;
          url = buildAdvancedIframeUrl(base, requestedSessionId, session?.directory);
        }
        // non-ok → leave url = base (no broken deep link)
      }
      frameUrl = url;
      probeState = 'ready';
    } catch {
      if (token !== probeToken) return;
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
      await resolve();
      if (probeState === 'ready') reloadNonce++; // force a fresh iframe load
    } finally {
      reconnecting = false;
    }
  }

  // Lock scroll on mount; restore on destroy. This is a CSS side-effect tied to
  // component lifetime, not navigation, so onMount is correct here.
  onMount(() => {
    document.documentElement.classList.add('chat-locked');
    document.body.classList.add('chat-locked');
    return () => {
      document.documentElement.classList.remove('chat-locked');
      document.body.classList.remove('chat-locked');
    };
  });

  // afterNavigate fires on initial load AND every same-route navigation (e.g.
  // switching to a different session while staying on /advanced). This is the
  // correct SvelteKit hook for "run on every arrival at this route" — no $effect.
  afterNavigate(({ to }) => {
    const sid = to?.url.searchParams.get('session') ?? null;
    if (sid) chat.setActiveSessionId(sid);
    void endpointsService.load().then(() => resolve());
  });
</script>

<svelte:head>
  <title>Advanced Chat — OpenPalm</title>
</svelte:head>

<Navbar />

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
  .advanced-status .btn { margin-top: var(--s-sp-3); }
</style>
