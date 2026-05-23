<script lang="ts">
  import { onMount } from 'svelte';
  import Navbar from '$lib/components/Navbar.svelte';
  import AuthGate from '$lib/components/AuthGate.svelte';
  import ChatMessage from '$lib/components/ChatMessage.svelte';
  import ChatInput from '$lib/components/ChatInput.svelte';
  import { stopSpeaking } from '$lib/voice/voice-state.svelte.js';
  import { probeChatBackend } from '$lib/api.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';

  // ── Auth state ───────────────────────────────────────────────────────
  let authLocked = $state(true);
  let authLoading = $state(false);
  let authError = $state('');

  // ── Scroll anchor ────────────────────────────────────────────────────
  let scrollAnchorEl = $state<HTMLDivElement | undefined>();

  // ── Helpers ──────────────────────────────────────────────────────────

  async function reconnect(): Promise<void> {
    chat.error = '';
    chat.dropCurrentSession();
    await chat.ensureSession();
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

  // ── Auth handlers ─────────────────────────────────────────────────────

  async function handleAuthSuccess(token: string): Promise<boolean> {
    if (authLoading) return false;
    authLoading = true;
    authError = '';
    try {
      const loginRes = await fetch('/admin/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
        credentials: 'include'
      });
      if (!loginRes.ok) {
        authLocked = true;
        authError = 'Invalid password.';
        return false;
      }
      authLocked = false;
      authError = '';
      // Start the initial session immediately on auth
      await chat.ensureSession();
      return true;
    } catch {
      authError = 'Unable to reach admin API.';
      return false;
    } finally {
      authLoading = false;
    }
  }

  async function handleLogout(): Promise<void> {
    stopSpeaking();
    try {
      await fetch('/admin/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // best-effort
    }
    authLocked = true;
    authError = '';
    chat.reset();
  }

  // ── Visibility-change reconnect ───────────────────────────────────────
  // When the tab regains focus, probe the current backend. (Uses $effect
  // because we need a DOM event subscription with cleanup — this is a
  // legitimate $effect use case, not a state-sync anti-pattern.)
  $effect(() => {
    let destroyed = false;

    function handleVisibilityChange(): void {
      if (destroyed || document.visibilityState !== 'visible') return;
      if (authLocked) return;
      void (async () => {
        const reachable = await probeChatBackend();
        if (!reachable && !destroyed) {
          chat.error = 'Assistant is not reachable. Try reconnecting.';
          chat.dropCurrentSession();
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
      authLoading = true;
      try {
        // Probe auth state via cookie
        const probe = await fetch('/admin/health', { credentials: 'include' });
        if (probe.status === 401 || probe.status === 503) {
          authLocked = true;
          authLoading = false;
          return;
        }
        authLocked = false;
        await chat.ensureSession();
      } catch {
        authLocked = true;
        authError = 'Unable to reach admin API.';
      } finally {
        authLoading = false;
      }
    })();
  });
</script>

<svelte:head>
  <title>Chat — OpenPalm</title>
</svelte:head>

{#if authLocked}
  <AuthGate onSuccess={handleAuthSuccess} loading={authLoading} error={authError} />
{:else}
  <Navbar onLogout={handleLogout} navLink={{ href: '/admin', label: 'Admin' }} />

  <div class="chat-layout">
    <!-- Message history -->
    <section class="messages-area" aria-label="Chat history" aria-live="polite">
      {#if chat.entries.length === 0 && !chat.sessionInitializing}
        <div class="empty-state">
          <p>Start a conversation with your assistant.</p>
        </div>
      {/if}

      {#if chat.sessionInitializing}
        <div class="session-loading" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <span>Connecting to assistant…</span>
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
{/if}

<style>
  /* Chat is the one page that wants exactly viewport-height: the navbar
     fills nav-height, the chat-layout fills the rest, and the messages-
     area scrolls internally. Suppress body scroll so we don't end up with
     two scrollbars (page + messages). Scoped to the chat page via :global,
     so other admin pages keep their normal flow. */
  :global(html),
  :global(body) {
    overflow: hidden;
    height: 100dvh;
  }

  .chat-layout {
    display: flex;
    flex-direction: column;
    height: calc(100dvh - var(--nav-height));
    max-width: var(--max-width);
    margin: 0 auto;
  }

  .messages-area {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-6);
    scroll-behavior: smooth;
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

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
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
