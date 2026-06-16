<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import { buildAdvancedIframeUrl } from '$lib/chat/navigation.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  // Auth is enforced server-side in hooks.server.ts; this page only renders
  // when the visitor is already an authenticated admin.

  const active = $derived(endpointsService.active);

  // The OpenCode web UI URL = the active endpoint's URL (honours
  // OP_OPENCODE_URL / custom port). Falls back to the host default (3800, the
  // host-mapped port; 4096 is container-internal).
  const openCodeUrl = $derived.by(() => {
    const baseUrl = active?.url ?? 'http://127.0.0.1:3800';
    const sessionId = page.url.searchParams.get('session');
    return buildAdvancedIframeUrl(baseUrl, sessionId);
  });

  // The embedded OpenCode UI loads cross-origin, so the parent can't observe a
  // 401 / dead-session failure (no error event, opaque contentDocument). Instead
  // we pre-flight probe the active endpoint through the same-origin proxy (which
  // targets the same active endpoint server-side). If it's reachable, render the
  // frame; if not, show an inline Reconnect affordance instead of a broken frame.
  type Probe = 'checking' | 'ready' | 'dead';
  let probeState = $state<Probe>('checking');
  let reconnecting = $state(false);
  let reloadNonce = $state(0);
  let probeToken = 0; // discard stale async probe results

  async function probe(): Promise<void> {
    const token = ++probeToken;
    probeState = 'checking';
    try {
      // Root of the OpenCode web server via the proxy → 200 when reachable,
      // 503 (endpoint_unreachable) / non-OK when the session is dead.
      const res = await fetch('/proxy/assistant/', { headers: { accept: 'text/html' } });
      if (token !== probeToken) return; // a newer probe superseded this one
      probeState = res.ok ? 'ready' : 'dead';
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
      await probe();
      if (probeState === 'ready') reloadNonce++; // force a fresh iframe load
    } finally {
      reconnecting = false;
    }
  }

  // Re-probe whenever the active endpoint changes (initial mount + switching
  // assistants in the navbar). Genuine side-effect on a dependency, not state sync.
  $effect(() => {
    if (active?.id) void probe();
  });

  onMount(() => {
    document.documentElement.classList.add('chat-locked');
    document.body.classList.add('chat-locked');
    void endpointsService.load();
    return () => {
      document.documentElement.classList.remove('chat-locked');
      document.body.classList.remove('chat-locked');
    };
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
        src={openCodeUrl}
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
    background: var(--color-bg);
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
    gap: var(--space-3);
    padding: var(--space-6);
  }
  .advanced-status h2 { margin: 0; font-size: 1.25rem; color: var(--color-text); }
  .advanced-status p { margin: 0; max-width: 26rem; color: var(--color-text-secondary); line-height: 1.55; }
  .advanced-status .status-line { color: var(--color-text-secondary); }
  .advanced-status .btn { margin-top: var(--space-3); }
</style>
