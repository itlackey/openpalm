<script lang="ts">
  import { onMount } from 'svelte';
  import Navbar from '$lib/components/Navbar.svelte';
  import AuthGate from '$lib/components/AuthGate.svelte';
  import ChatMessage from '$lib/components/ChatMessage.svelte';
  import ChatInput from '$lib/components/ChatInput.svelte';
  import { voiceState, speakText, stopSpeaking } from '$lib/voice/voice-state.svelte.js';
  import { getAdminToken, clearToken, storeToken, validateToken } from '$lib/auth.js';
  import {
    createChatSession,
    sendChatMessage,
    probeChatBackend,
  } from '$lib/api.js';
  import type { ChatBackend, ChatEntry, ChatMessage as ChatMessageType, ChatDivider } from '$lib/types.js';

  // ── Auth state ───────────────────────────────────────────────────────
  let authLocked = $state(true);
  let authLoading = $state(false);
  let authError = $state('');

  // ── Chat state ───────────────────────────────────────────────────────
  let backend = $state<ChatBackend>('assistant');
  let entries = $state<ChatEntry[]>([]);
  let sending = $state(false);
  let chatError = $state('');

  // ── Session state ────────────────────────────────────────────────────
  // Separate session ID per backend. null = not yet created.
  let assistantSessionId = $state<string | null>(null);
  let adminSessionId = $state<string | null>(null);
  let sessionInitializing = $state(false);

  // ── Scroll anchor ────────────────────────────────────────────────────
  let scrollAnchorEl = $state<HTMLDivElement | undefined>();

  // ── Helpers ──────────────────────────────────────────────────────────

  function setSessionId(b: ChatBackend, id: string | null): void {
    if (b === 'assistant') {
      assistantSessionId = id;
    } else {
      adminSessionId = id;
    }
  }

  async function ensureSession(b: ChatBackend): Promise<string | null> {
    const token = getAdminToken();
    if (!token) return null;
    const existing = b === 'assistant' ? assistantSessionId : adminSessionId;
    if (existing) return existing;

    sessionInitializing = true;
    try {
      const { id } = await createChatSession(token, b);
      setSessionId(b, id);
      return id;
    } catch (e) {
      const err = e as { message?: string };
      chatError = `Failed to start session with ${b}: ${err.message ?? 'unknown error'}`;
      return null;
    } finally {
      sessionInitializing = false;
    }
  }

  async function reconnect(): Promise<void> {
    chatError = '';
    if (backend === 'assistant') assistantSessionId = null;
    else adminSessionId = null;
    await ensureSession(backend);
  }

  async function handleSend(text: string): Promise<void> {
    if (sending) return;
    const token = getAdminToken();
    if (!token) return;

    const sessionId = await ensureSession(backend);
    if (!sessionId) return;

    // Optimistically add user message
    const userEntry: ChatMessageType = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      backend,
      timestamp: Date.now(),
    };
    entries = [...entries, userEntry];
    chatError = '';
    sending = true;
    scrollToBottom();

    try {
      const response = await sendChatMessage(token, backend, sessionId, text);

      // Extract text from parts array
      const replyText = response.parts
        .filter((p) => p.type === 'text' && p.text)
        .map((p) => p.text ?? '')
        .join('');

      const assistantEntry: ChatMessageType = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: replyText || '(no response)',
        backend,
        timestamp: Date.now(),
      };
      entries = [...entries, assistantEntry];

      // TTS: speak if voice is supported and not already speaking
      if (voiceState.ttsSupported && replyText) {
        speakText(replyText);
      }
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 503 || err.status === 502) {
        chatError = `${backend === 'admin' ? 'Admin' : 'Assistant'} is not reachable. Try reconnecting.`;
        // Invalidate session — it may have died
        if (backend === 'assistant') assistantSessionId = null;
        else adminSessionId = null;
      } else {
        chatError = err.message ?? 'Message failed.';
      }
    } finally {
      sending = false;
      scrollToBottom();
    }
  }

  function handleBackendChange(newBackend: ChatBackend): void {
    if (newBackend === backend) return;

    // Insert a divider marking the context switch
    const divider: ChatDivider = {
      id: crypto.randomUUID(),
      type: 'divider',
      label: `Switched to ${newBackend === 'admin' ? 'Admin' : 'Assistant'}`,
      timestamp: Date.now(),
    };
    entries = [...entries, divider];
    backend = newBackend;

    // Pre-create session for the new backend if not already done
    void ensureSession(newBackend);
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
      const result = await validateToken(token);
      if (!result.allowed) {
        clearToken();
        authLocked = true;
        authError = 'Invalid admin token.';
        return false;
      }
      storeToken(token);
      authLocked = false;
      authError = '';
      // Start the initial session immediately on auth
      await ensureSession(backend);
      return true;
    } catch {
      authError = 'Unable to reach admin API.';
      return false;
    } finally {
      authLoading = false;
    }
  }

  function handleLogout(): void {
    stopSpeaking();
    clearToken();
    authLocked = true;
    authError = '';
    entries = [];
    chatError = '';
    assistantSessionId = null;
    adminSessionId = null;
    backend = 'assistant';
  }

  // ── Visibility-change reconnect ───────────────────────────────────────
  // When the tab regains focus, probe the current backend.

  $effect(() => {
    let destroyed = false;

    function handleVisibilityChange(): void {
      if (destroyed || document.visibilityState !== 'visible') return;
      if (authLocked) return;
      const token = getAdminToken();
      if (!token) return;
      void (async () => {
        const reachable = await probeChatBackend(token, backend);
        if (!reachable && !destroyed) {
          chatError = `${backend === 'admin' ? 'Admin' : 'Assistant'} is not reachable. Try reconnecting.`;
          // Clear stale session
          if (backend === 'assistant') assistantSessionId = null;
          else adminSessionId = null;
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
      const token = getAdminToken();
      if (!token) {
        authLocked = true;
        return;
      }
      authLoading = true;
      try {
        const result = await validateToken(token);
        if (!result.allowed) {
          clearToken();
          authLocked = true;
          authError = 'Invalid admin token.';
          return;
        }
        authLocked = false;
        await ensureSession(backend);
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
      {#if entries.length === 0 && !sessionInitializing}
        <div class="empty-state">
          <p>Start a conversation with your {backend === 'admin' ? 'Admin' : 'Assistant'}.</p>
        </div>
      {/if}

      {#if sessionInitializing}
        <div class="session-loading" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <span>Connecting to {backend === 'admin' ? 'Admin' : 'Assistant'}…</span>
        </div>
      {/if}

      {#each entries as entry (entry.id)}
        <ChatMessage {entry} />
      {/each}

      <div bind:this={scrollAnchorEl} aria-hidden="true"></div>
    </section>

    <!-- Error / reconnect banner -->
    {#if chatError}
      <div class="chat-error-banner" role="alert">
        <span>{chatError}</span>
        <button class="reconnect-btn" type="button" onclick={reconnect}>
          Reconnect
        </button>
        <button
          class="dismiss-btn"
          type="button"
          aria-label="Dismiss error"
          onclick={() => { chatError = ''; }}
        >
          &times;
        </button>
      </div>
    {/if}

    <!-- Input area — always at the bottom -->
    <ChatInput
      {backend}
      {sending}
      onSend={handleSend}
      onBackendChange={handleBackendChange}
    />
  </div>
{/if}

<style>
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
