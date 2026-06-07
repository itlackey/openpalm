<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
  import ChatInput from '$lib/components/chat/ChatInput.svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import EndpointList from '$lib/components/chat/EndpointList.svelte';
  import SessionList from '$lib/components/chat/SessionList.svelte';
  import { stopSpeaking } from '$lib/voice/voice-state.svelte.js';
  import { probeChatBackend } from '$lib/api.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  // Auth is enforced server-side in hooks.server.ts; this page only renders
  // when the visitor is already an authenticated admin.

  // ── Scroll anchor ────────────────────────────────────────────────────
  let scrollAnchorEl = $state<HTMLDivElement | undefined>();

  // ── Loading state for the messages area ───────────────────────────────
  // While the per-endpoint session list is loading we don't know which
  // session to render, so show a skeleton. Same treatment while a chosen
  // session's messages are being fetched.
  const entriesLoading = $derived(chat.entriesLoading);
  const sessionsLoading = $derived(
    chat.byEndpoint.get(chat.activeEndpointId)?.sessionsLoading ?? false
  );

  // ── Helpers ──────────────────────────────────────────────────────────

  async function reconnect(): Promise<void> {
    chat.error = '';
    // Per the multi-endpoint refactor: don't drop session state, re-fetch
    // the list from OpenCode and resume the newest/previous session.
    await chat.loadSessions();
    await chat.onEndpointChanged(endpointsService.activeId);
  }

  async function handleSend(text: string): Promise<void> {
    await chat.send(text);
    scrollToBottom();
  }

  function scrollToBottom(): void {
    // Use microtask to allow DOM update first
    queueMicrotask(() => {
      scrollAnchorEl?.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // ── Body scroll lock (chat-page only) ────────────────────────────────
  // The chat layout is exactly viewport-height with internal scroll on the
  // messages area. Suppress body scroll while we're on this page so we
  // don't get a redundant outer scrollbar. $effect cleanup guarantees the
  // class is removed on navigation away, even if SvelteKit's CSS handling
  // doesn't tear down :global rules reliably for adapter-node builds.
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.add('chat-locked');
    document.body.classList.add('chat-locked');
    return () => {
      document.documentElement.classList.remove('chat-locked');
      document.body.classList.remove('chat-locked');
    };
  });

  // ── Visibility-change reconnect ───────────────────────────────────────
  // When the tab regains focus, probe the current backend. (Uses $effect
  // because we need a DOM event subscription with cleanup — this is a
  // legitimate $effect use case, not a state-sync anti-pattern.)
  $effect(() => {
    let destroyed = false;

    function handleVisibilityChange(): void {
      if (destroyed || document.visibilityState !== 'visible') return;
      void (async () => {
        const reachable = await probeChatBackend();
        if (!reachable && !destroyed) {
          chat.error = 'Assistant is not reachable. Try reconnecting.';
        }
      })();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      destroyed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  // ── Mount ─────────────────────────────────────────────────────────────

  onMount(() => {
    void (async () => {
      try {
        // Load endpoint list + sessions for the active endpoint, restoring
        // the most recent session.
        await endpointsService.load();
        await chat.onEndpointChanged(endpointsService.activeId);
        // Honour the global navbar's "new chat" handshake (?new=1) once the
        // endpoint + sessions are loaded, then drop the param from the URL.
        if (page.url.searchParams.get('new') === '1') {
          await chat.startNewSession();
          await goto('/chat', { replaceState: true });
        }
      } catch {
        chat.error = 'Unable to reach the assistant.';
      }
    })();
  });
</script>

<svelte:head>
  <title>Chat — OpenPalm</title>
</svelte:head>

<Navbar />

<div class="chat-shell">
  <div class="chat-layout">
    <!-- Message history -->
    <section class="messages-area" aria-label="Chat history" aria-live="polite">
      {#if sessionsLoading || entriesLoading}
        <div class="session-loading" aria-live="polite">
          <Spinner />
          <span>Loading messages…</span>
        </div>
      {:else if chat.entries.length === 0}
        <div class="empty-state">
          <p>No messages yet. Send something to begin.</p>
        </div>
      {/if}

      {#each chat.entries as entry (entry.id)}
        <ChatMessage {entry} />
      {/each}

      <div bind:this={scrollAnchorEl} aria-hidden="true"></div>
    </section>

    <!-- Error / reconnect banner -->
    {#if chat.error}
      <div class="chat-error-banner" role="alert">
        <span>{chat.error}</span>
        <button class="reconnect-btn" type="button" onclick={reconnect}>
          Reconnect
        </button>
        <button
          class="dismiss-btn"
          type="button"
          aria-label="Dismiss error"
          onclick={() => { chat.error = ''; }}
        >
          &times;
        </button>
      </div>
    {/if}

    <!-- Input area — always at the bottom. -->
    <ChatInput
      sending={chat.sending}
      onSend={handleSend}
    />
  </div>

  <!-- Right-side panel (≥1024px): assistant chooser + session list. Replaces the
       navbar drawer triggers at this width. -->
  <aside class="chat-side" aria-label="Assistant and sessions">
    <section class="side-section">
      <h2 class="side-heading">Assistant</h2>
      <EndpointList />
    </section>
    <section class="side-section side-sessions">
      <h2 class="side-heading">Sessions</h2>
      <SessionList />
    </section>
  </aside>
</div>

<style>
  /* Body lock is applied via a class added in a $effect (see <script>)
     instead of `:global(body)` here, because Svelte's :global rules don't
     reliably detach on client-side navigation in adapter-node — the
     stylesheet for a page can stay loaded after we leave it, breaking
     scroll on other pages. The class-based approach guarantees cleanup. */

  /* Shell splits the viewport into the chat column and the optional side panel. */
  .chat-shell {
    display: flex;
    height: calc(100dvh - var(--nav-height));
    margin: 0;
  }

  .chat-layout {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  /* Right-side panel — hidden until there's room for it alongside the chat. */
  .chat-side {
    display: none;
  }
  @media (min-width: 1024px) {
    .chat-side {
      display: flex;
      flex-direction: column;
      width: 20rem;
      flex-shrink: 0;
      height: 100%;
      border-left: 1px solid var(--color-border);
      background: var(--color-bg);
      overflow: hidden;
    }
  }

  .side-section {
    padding: var(--space-4) var(--space-3);
    border-bottom: 1px solid var(--color-border);
    min-height: 0;
  }
  /* Sessions section fills the remaining height and scrolls internally. */
  .side-sessions {
    flex: 1;
    display: flex;
    flex-direction: column;
    border-bottom: none;
    overflow-y: auto;
  }

  .side-heading {
    margin: 0 0 var(--space-2);
    padding: 0 var(--space-3);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
  }

  .messages-area {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-5) var(--space-4);
    scroll-behavior: smooth;
    /* Center a contained reading column so turns never fly to the screen edges. */
    align-items: center;
  }

  .messages-area > :global(*) {
    width: 100%;
    max-width: var(--chat-column); /* centered conversation column, shared with the composer */
  }

  .empty-state {
    margin: auto;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: var(--text-base);
    padding: var(--space-8);
  }

  .session-loading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    padding: var(--space-4);
    margin: auto;
  }

  .chat-error-banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: var(--color-danger-bg);
    border-top: 1px solid rgba(250, 82, 82, 0.25);
    font-size: var(--text-sm);
    color: var(--color-danger);
  }

  .chat-error-banner span:first-child {
    flex: 1;
  }

  .reconnect-btn {
    padding: 3px 10px;
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--color-danger);
    cursor: pointer;
    white-space: nowrap;
    transition: all var(--transition-fast);
  }

  .reconnect-btn:hover {
    background: var(--color-danger);
    color: #fff;
  }

  .dismiss-btn {
    width: 24px;
    height: 24px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--color-danger);
    cursor: pointer;
    font-size: var(--text-lg);
    line-height: 1;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }

  .dismiss-btn:hover {
    background: rgba(250, 82, 82, 0.15);
  }

  @media (max-width: 768px) {
    .messages-area {
      padding: var(--space-3) var(--space-4);
    }
  }
</style>
