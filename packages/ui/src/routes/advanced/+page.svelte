<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import { buildAdvancedIframeUrl } from '$lib/chat/navigation.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  // Auth is enforced server-side in hooks.server.ts; this page only renders
  // when the visitor is already an authenticated admin.

  // The OpenCode web UI URL = the active endpoint's URL (honours
  // OP_OPENCODE_URL / custom port). Falls back to the host default (3800, the
  // host-mapped port; 4096 is container-internal). Same source the Overview
  // "Open OpenCode UI" action used — we just embed it instead of new-tabbing.
  // Host-machine-only, exactly like that link.
  let openCodeUrl = $derived.by(() => {
    const baseUrl = endpointsService.active?.url ?? 'http://127.0.0.1:3800';
    const sessionId = page.url.searchParams.get('session');
    return buildAdvancedIframeUrl(baseUrl, sessionId);
  });

  // The embedded OpenCode UI fills the viewport below the navbar with its own
  // internal scroll, so suppress the outer document scrollbar while we're here
  // (same treatment as /chat). Cleanup on navigation away.
  onMount(() => {
    document.documentElement.classList.add('chat-locked');
    document.body.classList.add('chat-locked');
    return () => {
      document.documentElement.classList.remove('chat-locked');
      document.body.classList.remove('chat-locked');
    };
  });

  onMount(() => {
    // Resolve the OpenCode endpoint URL for the embedded frame.
    void endpointsService.load();
  });
</script>

<svelte:head>
  <title>Advanced Chat — OpenPalm</title>
</svelte:head>

<Navbar />

<div class="advanced-layout">
  <!-- The Chat↔Advanced switch is in the global navbar; session management
       lives inside OpenCode itself, so the frame fills the whole area. -->
  <iframe
    class="opencode-frame"
    src={openCodeUrl}
    title="OpenCode — Advanced Chat"
    allow="clipboard-read; clipboard-write; microphone"
  ></iframe>
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
</style>
