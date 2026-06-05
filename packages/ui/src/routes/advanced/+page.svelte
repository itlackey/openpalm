<script lang="ts">
  import { onMount } from 'svelte';
  import Navbar from '$lib/components/Navbar.svelte';
  import AuthGate from '$lib/components/AuthGate.svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  // ── Auth state (mirrors /chat + /admin) ───────────────────────────────
  let authLocked = $state(true);
  let authLoading = $state(false);
  let authError = $state('');

  // The OpenCode web UI URL = the active endpoint's URL (honours
  // OP_OPENCODE_URL / custom port). Falls back to the host default (3800, the
  // host-mapped port; 4096 is container-internal). Same source the Overview
  // "Open OpenCode UI" action used — we just embed it instead of new-tabbing.
  // Host-machine-only, exactly like that link.
  let openCodeUrl = $derived(endpointsService.active?.url ?? 'http://127.0.0.1:3800');

  onMount(() => {
    // Probe auth via the session cookie (same as /chat). 401/503 → show the
    // AuthGate; otherwise unlock and resolve the OpenCode endpoint URL.
    void (async () => {
      authLoading = true;
      try {
        const probe = await fetch('/admin/health', { credentials: 'include' });
        if (probe.status === 401 || probe.status === 503) {
          authLocked = true;
          return;
        }
        authLocked = false;
        await endpointsService.load();
      } catch {
        authLocked = true;
        authError = 'Unable to reach admin API.';
      } finally {
        authLoading = false;
      }
    })();
  });

  async function handleAuthSuccess(token: string): Promise<boolean> {
    if (authLoading) return false;
    authLoading = true;
    authError = '';
    try {
      const loginRes = await fetch('/admin/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: token }),
        credentials: 'include'
      });
      if (!loginRes.ok) {
        authLocked = true;
        authError = 'Invalid password.';
        return false;
      }
      authLocked = false;
      authError = '';
      await endpointsService.load();
      return true;
    } catch {
      authLocked = true;
      authError = 'Could not reach the server.';
      return false;
    } finally {
      authLoading = false;
    }
  }
</script>

<svelte:head>
  <title>Advanced Chat — OpenPalm</title>
</svelte:head>

{#if authLocked}
  <AuthGate onSuccess={handleAuthSuccess} loading={authLoading} error={authError} />
{:else}
  <Navbar />

  <div class="advanced-layout">
    <iframe
      class="opencode-frame"
      src={openCodeUrl}
      title="OpenCode — Advanced Chat"
      allow="clipboard-read; clipboard-write; microphone"
    ></iframe>
  </div>
{/if}

<style>
  /* Fill the viewport below the sticky navbar with the embedded OpenCode UI.
     dvh accounts for Android Chrome's dynamic toolbar shrinkage. */
  .advanced-layout {
    height: calc(100dvh - var(--nav-height));
    width: 100%;
    background: var(--color-bg);
  }

  .opencode-frame {
    display: block;
    width: 100%;
    height: 100%;
    border: none;
  }
</style>
