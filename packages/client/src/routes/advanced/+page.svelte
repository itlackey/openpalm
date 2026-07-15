<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { getClientBoot } from '$lib/boot.js';
  import {
    buildChatPath,
    resolveAdvancedFrameUrl,
    resolveAdvancedTarget,
    type AdvancedTarget,
  } from '$lib/advanced-mode.js';
  import { createTransport } from '$lib/transport/index.js';
  import type { ConnectionEntry } from '$lib/connections/index.js';

  type PageState = 'checking' | 'ready' | 'unavailable' | 'unreachable';

  let connection = $state<ConnectionEntry | null>(null);
  let target = $state<AdvancedTarget | null>(null);
  let pageState = $state<PageState>('checking');
  let frameUrl = $state('');
  let retrying = $state(false);
  let loadToken = 0;

  const requestedSessionId = $derived(page.url.searchParams.get('session'));
  const chatHref = $derived(buildChatPath(requestedSessionId));

  async function loadAdvanced(): Promise<void> {
    const token = ++loadToken;
    pageState = 'checking';
    const { store } = await getClientBoot();
    const active = await store.getActive();
    if (token !== loadToken) return;
    if (!active) {
      await goto('/connections/new', { replaceState: true });
      return;
    }

    connection = active;
    target = resolveAdvancedTarget(active);
    if (!target.available) {
      pageState = 'unavailable';
      return;
    }

    const health = await createTransport({ baseUrl: target.baseUrl }).probeHealth();
    if (token !== loadToken) return;
    if (health.state !== 'accessible') {
      pageState = 'unreachable';
      return;
    }

    frameUrl = await resolveAdvancedFrameUrl(target.baseUrl, requestedSessionId);
    if (token !== loadToken) return;
    pageState = 'ready';
  }

  async function retry(): Promise<void> {
    if (retrying) return;
    retrying = true;
    try {
      await loadAdvanced();
    } finally {
      retrying = false;
    }
  }

  onMount(() => {
    void loadAdvanced();
    return () => {
      loadToken++;
    };
  });
</script>

<svelte:head>
  <title>Advanced Chat — OpenPalm</title>
</svelte:head>

<main class="advanced-page">
  <header class="advanced-header">
    <div>
      <h1>Advanced</h1>
      {#if connection}<p>{connection.label}</p>{/if}
    </div>
    <a class="btn btn-secondary" href={chatHref}>Back to chat</a>
  </header>

  {#if pageState === 'ready'}
    <iframe
      class="opencode-frame"
      src={frameUrl}
      title="OpenCode — Advanced Chat"
      allow="clipboard-read; clipboard-write"
    ></iframe>
  {:else}
    <section
      class="advanced-status"
      role={pageState === 'unavailable' || pageState === 'unreachable' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {#if pageState === 'checking'}
        <p>Checking {connection?.label ?? 'the active connection'}…</p>
      {:else if pageState === 'unavailable'}
        <h2>Advanced mode unavailable</h2>
        <p>{target && !target.available ? target.message : 'This connection does not support Advanced mode.'}</p>
        <a class="btn btn-primary" href={chatHref}>Continue in Chat</a>
      {:else}
        <h2>Can’t reach {connection?.label ?? 'the active connection'}</h2>
        <p>The raw OpenCode server did not answer. Chat will reconnect automatically when you return.</p>
        <div class="status-actions">
          <button class="btn btn-primary" type="button" onclick={retry} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
          <a class="btn btn-secondary" href={chatHref}>Back to chat</a>
        </div>
      {/if}
    </section>
  {/if}
</main>

<style>
  .advanced-page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .advanced-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-4);
    padding: var(--s-sp-3) var(--s-sp-5);
    border-bottom: var(--s-hair) solid var(--s-line);
  }

  .advanced-header h1,
  .advanced-header p {
    margin: 0;
  }

  .advanced-header p {
    color: var(--s-ink-3);
    font-size: var(--s-type-deed);
  }

  .opencode-frame {
    display: block;
    width: 100%;
    flex: 1;
    min-height: 30rem;
    border: 0;
  }

  .advanced-status {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--s-sp-3);
    padding: var(--s-sp-6);
    text-align: center;
  }

  .advanced-status h2,
  .advanced-status p {
    margin: 0;
  }

  .advanced-status p {
    max-width: 34rem;
    color: var(--s-ink-2);
  }

  .status-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--s-sp-2);
  }

  @media (max-width: 32rem) {
    .advanced-header {
      align-items: flex-start;
      padding-inline: var(--s-sp-3);
    }

    .advanced-status {
      padding: var(--s-sp-4);
    }
  }
</style>
