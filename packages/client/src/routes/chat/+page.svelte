<script lang="ts">
  // /chat — the client chat surface (P5b item 3, #555), adapted from
  // packages/ui routes/chat onto the direct per-connection transport
  // (plan §6.11: no proxy, no host APIs). Thin slice: session list/create
  // + message send against the active connection; live SSE event wiring
  // and message history follow with chat parity.
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import IconAdd from '@openpalm/ui-kit/components/icons/IconAdd.svelte';
  import ChatInput from '$lib/components/chat/ChatInput.svelte';
  import ChatTurn from '$lib/components/chat/ChatTurn.svelte';
  import { getClientBoot } from '$lib/boot.js';
  import {
    createTransport,
    type SessionSummary,
    type Transport,
  } from '$lib/transport/index.js';
  import type { ConnectionEntry } from '$lib/connections/index.js';

  type Turn = { role: 'user' | 'assistant'; text: string };

  let connection = $state<ConnectionEntry | null>(null);
  let transport: Transport | null = null;
  let sessions = $state<SessionSummary[]>([]);
  let sessionId = $state<string | null>(null);
  let turns = $state<Turn[]>([]);
  let sending = $state(false);
  let error = $state('');
  let showHistoryNote = $state(false);
  let threadEl = $state<HTMLElement | undefined>();

  onMount(async () => {
    const { store, secrets } = await getClientBoot();
    const active = (await store.getActive()) ?? (await store.list())[0] ?? null;
    if (!active) {
      await goto('/connections/new', { replaceState: true });
      return;
    }
    connection = active;
    transport = createTransport({
      baseUrl: active.url,
      auth: await secrets.resolveAuth(active),
    });
    await refreshSessions();
  });

  async function refreshSessions(): Promise<void> {
    if (!transport) return;
    try {
      sessions = await transport.listSessions();
      error = '';
    } catch (e) {
      error = friendly(e, 'Could not load sessions from the connection.');
    }
  }

  function selectSession(id: string): void {
    if (id === sessionId) return;
    sessionId = id;
    turns = [];
    // Message history isn't ported yet (thin slice) — say so instead of
    // silently presenting an old session as empty.
    showHistoryNote = true;
  }

  function newSession(): void {
    sessionId = null;
    turns = [];
    showHistoryNote = false;
  }

  function sessionLabel(session: SessionSummary): string {
    return session.title || 'Untitled';
  }

  function assistantText(response: unknown): string {
    const parts = (response as { parts?: Array<{ type?: string; text?: string }> } | null)?.parts;
    if (!Array.isArray(parts)) return '';
    return parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n\n')
      .trim();
  }

  function friendly(e: unknown, fallback: string): string {
    const status = (e as { status?: number } | null)?.status;
    if (status === 401 || status === 403) {
      return 'The connection rejected the stored credentials. Check them under Connections.';
    }
    return e instanceof Error && e.message ? `${fallback} (${e.message})` : fallback;
  }

  async function scrollToEnd(): Promise<void> {
    await tick();
    threadEl?.scrollTo({ top: threadEl.scrollHeight });
  }

  async function send(text: string): Promise<void> {
    if (!transport || sending) return;
    sending = true;
    error = '';
    turns = [...turns, { role: 'user', text }];
    void scrollToEnd();
    try {
      if (!sessionId) {
        sessionId = (await transport.createSession()).id;
        void refreshSessions();
      }
      const response = await transport.sendMessage(sessionId, text);
      const reply = assistantText(response);
      turns = [...turns, { role: 'assistant', text: reply || '(The assistant sent no text.)' }];
      void refreshSessions();
    } catch (e) {
      error = friendly(e, 'Sending the message failed.');
    } finally {
      sending = false;
      void scrollToEnd();
    }
  }
</script>

<svelte:head>
  <title>Chat — OpenPalm</title>
</svelte:head>

<div class="chat">
  <aside class="sessions" aria-label="Sessions">
    <div class="sessions-head">
      <span class="sessions-title">Sessions</span>
      <button type="button" class="new-chat" onclick={newSession} aria-label="New chat">
        <IconAdd size={14} />
      </button>
    </div>
    <ul>
      {#each sessions as session (session.id)}
        <li>
          <button
            type="button"
            class="session"
            class:current={session.id === sessionId}
            onclick={() => selectSession(session.id)}
          >
            {sessionLabel(session)}
          </button>
        </li>
      {:else}
        <li class="empty">No sessions yet.</li>
      {/each}
    </ul>
    {#if connection}
      <a class="connection-note" href="/connections" title={connection.url}>
        via {connection.label}
      </a>
    {/if}
  </aside>

  <section class="thread-pane">
    <div class="thread" bind:this={threadEl}>
      {#if showHistoryNote}
        <div class="s-note">Earlier messages in this session are not shown yet.</div>
      {/if}
      {#each turns as turn, index (index)}
        <ChatTurn role={turn.role} text={turn.text} />
      {/each}
      {#if sending}
        <div class="s-note" aria-live="polite">Thinking…</div>
      {/if}
      {#if error}
        <div class="alert" role="alert">{error}</div>
      {/if}
    </div>
    <div class="composer-row">
      <ChatInput {sending} onSend={send} />
    </div>
  </section>
</div>

<style>
  .chat {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .sessions {
    width: 15rem;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: var(--s-hair) solid var(--s-line);
    padding: var(--s-sp-4) var(--s-sp-3);
    gap: var(--s-sp-3);
  }

  @media (max-width: 44rem) {
    .sessions {
      display: none;
    }
  }

  .sessions-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .sessions-title {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .new-chat {
    appearance: none;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: none;
    color: var(--s-ink-3);
    cursor: pointer;
    padding: 4px 6px;
    display: inline-flex;
  }

  .new-chat:hover {
    color: var(--s-ink);
    border-color: var(--s-seal);
  }

  .sessions ul {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .session {
    width: 100%;
    text-align: left;
    appearance: none;
    background: none;
    border: 0;
    border-left: 2px solid transparent;
    color: var(--s-ink-2);
    font: inherit;
    font-size: var(--s-type-deed);
    padding: 0.35rem 0.5rem;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session:hover {
    color: var(--s-ink);
  }

  .session.current {
    color: var(--s-ink);
    border-left-color: var(--s-seal);
  }

  .empty {
    color: var(--s-ink-3);
    font-size: var(--s-type-deed);
    padding: 0.35rem 0.5rem;
  }

  .connection-note {
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .connection-note:hover {
    color: var(--s-ink);
  }

  .thread-pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .thread {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-5);
    padding: var(--s-sp-5) clamp(1rem, 6vw, 4rem);
  }

  .s-note {
    display: flex;
    justify-content: center;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .alert {
    padding: var(--s-sp-3);
    border-radius: 2px;
    color: var(--s-error);
    border: 1px solid color-mix(in srgb, var(--s-error) 25%, transparent);
    background: color-mix(in srgb, var(--s-error) 8%, transparent);
  }

  .composer-row {
    display: flex;
    justify-content: center;
    padding: var(--s-sp-3) var(--s-sp-4) var(--s-sp-5);
  }
</style>
