/**
 * Chat page state — plain (rune-free) controller so it unit-tests with
 * bun:test without mounting a Svelte component (packages/client has no
 * vitest-browser-svelte harness). `routes/chat/+page.svelte` is a thin view:
 * it creates one controller per active connection, subscribes to it, and
 * copies `getState()` into local `$state` on every notification.
 *
 * Ports/adapts the relevant slice of `packages/ui/src/lib/chat/
 * chat-state.svelte.ts` for the client's direct-transport, single-connection
 * shape — no voice, no tool log, no permission/question asks (those are
 * separate findings, B1/B9/B4, not owned by this lane).
 *
 * review 2026-07-10 findings this closes the UI half of:
 *   - B2 [HIGH] live SSE streaming: `subscribeEvents()` is opened once in
 *     init() and stays open across session switches; `extractTextDelta`/
 *     `isTurnEnd` (both session-scoped) drive `pendingText` while a turn is
 *     in flight, instead of a 150s blocking "Thinking…" wait.
 *   - B3 [HIGH] stop/cancel: `stop()` fires `transport.abortTurn()` AND a
 *     caller-owned `AbortController` passed into `sendMessage()`; whichever
 *     path notices first finalizes the turn from `pendingText` so the UI
 *     never gets stuck waiting on the aborted fetch.
 *   - B5 [HIGH] session history: `selectSession()` loads real history via
 *     `transport.getSessionMessages()` (no more "not shown yet" disclaimer);
 *     `reconnect()` only refreshes the session list — it never touches
 *     `entries`, so the live transcript survives a reconnect.
 *   - B8(c) failed-send retry: a failed `send()` drops the optimistic user
 *     entry, records `lastFailedText`, and `retryFailedSend()` resends it
 *     (mirrors `git show 455d8728:packages/ui/src/lib/chat/
 *     chat-state.svelte.ts` `send()`'s catch block).
 */
import {
  extractTextDelta,
  isTurnEnd,
  type FlattenedEntry,
  type RawEvent,
  type SessionSummary,
  type Transport,
} from '../transport/index.js';

export type ChatEntry =
  | { id: string; kind: 'message'; role: 'user' | 'assistant'; text: string; timestamp: number }
  | { id: string; kind: 'note'; text: string; timestamp: number };

export type ChatControllerState = {
  sessions: SessionSummary[];
  sessionId: string | null;
  entries: ChatEntry[];
  /** A turn is in flight — gates submission only, never drafting (B8b). */
  sending: boolean;
  /** Incremental assistant text streamed in via SSE for the in-flight turn. */
  pendingText: string;
  /** Whether the SSE event stream is currently connected. */
  connected: boolean;
  error: string;
  /** Text of the last send() that failed — non-empty enables the retry action. */
  lastFailedText: string;
};

export type ChatController = {
  getState(): ChatControllerState;
  /** Returns an unsubscribe function. Called after every state change. */
  subscribe(listener: () => void): () => void;
  init(): Promise<void>;
  destroy(): void;
  refreshSessions(): Promise<void>;
  selectSession(id: string): Promise<void>;
  newSession(): void;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  retryFailedSend(): Promise<void>;
  reconnect(): Promise<void>;
  /**
   * Set the error banner directly (review 2026-07-10 §B16 — the
   * visibilitychange reachability probe has no send/session-load path of
   * its own to hang an error on). Notifies subscribers, unlike mutating the
   * `getState()` snapshot directly.
   */
  setError(message: string): void;
};

function randomId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function assistantTextFromResponse(response: unknown): string {
  const parts = (response as { parts?: Array<{ type?: string; text?: string }> } | null)?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n')
    .trim();
}

function friendlyMessage(e: unknown, fallback: string): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 401 || status === 403) {
    return 'The connection rejected the stored credentials. Check them under Connections.';
  }
  return e instanceof Error && e.message ? `${fallback} (${e.message})` : fallback;
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function entryFromFlattened(entry: FlattenedEntry): ChatEntry | null {
  // FlattenedToolGroup is the only member with a `type` field at all (always
  // 'tool-group'); FlattenedMessage has none. B9 (tool visibility) is a
  // separate finding — tool-only groups render nothing here.
  if ('type' in entry) return null;
  return { id: entry.id, kind: 'message', role: entry.role, text: entry.text, timestamp: entry.timestamp };
}

export function createChatController(transport: Transport): ChatController {
  const state: ChatControllerState = {
    sessions: [],
    sessionId: null,
    entries: [],
    sending: false,
    pendingText: '',
    connected: false,
    error: '',
    lastFailedText: '',
  };

  const listeners = new Set<() => void>();
  function notify(): void {
    for (const listener of listeners) listener();
  }

  let unsubscribeEvents: (() => void) | null = null;
  /** The session id + abort controller for the turn currently in flight, if any. */
  let activeTurn: { sessionId: string; abort: AbortController } | null = null;

  function finalizeTurn(sessionId: string, replyTextOverride?: string): void {
    // Guards the SSE-isTurnEnd-vs-sendMessage-resolving race (whichever
    // notices first finalizes; the other is a no-op).
    if (!state.sending || !activeTurn || activeTurn.sessionId !== sessionId) return;
    const raw = replyTextOverride ?? state.pendingText;
    const text = raw.trim() || '(The assistant sent no text.)';
    state.entries = [...state.entries, { id: randomId(), kind: 'message', role: 'assistant', text, timestamp: Date.now() }];
    state.sending = false;
    state.pendingText = '';
    activeTurn = null;
    notify();
  }

  function handleEvent(event: RawEvent): void {
    if (!state.sending || !activeTurn) return;
    const sessionId = activeTurn.sessionId;
    const delta = extractTextDelta(event, sessionId);
    if (delta) {
      state.pendingText += delta;
      notify();
    }
    if (isTurnEnd(event, sessionId)) {
      finalizeTurn(sessionId);
    }
  }

  async function refreshSessions(): Promise<void> {
    try {
      state.sessions = await transport.listSessions();
      state.error = '';
    } catch (e) {
      state.error = friendlyMessage(e, 'Could not load sessions from the connection.');
    }
    notify();
  }

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || state.sending) return;
    state.lastFailedText = '';

    let sessionId = state.sessionId;
    if (!sessionId) {
      try {
        sessionId = (await transport.createSession()).id;
      } catch (e) {
        state.error = friendlyMessage(e, 'Could not start a session.');
        notify();
        return;
      }
      state.sessionId = sessionId;
    }

    const userEntry: ChatEntry = { id: randomId(), kind: 'message', role: 'user', text: trimmed, timestamp: Date.now() };
    state.entries = [...state.entries, userEntry];
    state.sending = true;
    state.pendingText = '';
    state.error = '';
    const abort = new AbortController();
    activeTurn = { sessionId, abort };
    notify();

    try {
      const response = await transport.sendMessage(sessionId, trimmed, { signal: abort.signal });
      finalizeTurn(sessionId, assistantTextFromResponse(response));
      void refreshSessions();
    } catch (e) {
      if (isAbortError(e)) return; // stop() already finalized (or will, via the aborted signal path).
      state.entries = state.entries.filter((entry) => entry.id !== userEntry.id);
      state.lastFailedText = trimmed;
      state.sending = false;
      state.pendingText = '';
      activeTurn = null;
      state.error = friendlyMessage(e, 'Sending the message failed.');
      notify();
    }
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async init() {
      unsubscribeEvents = transport.subscribeEvents({
        onEvent: handleEvent,
        onConnect: () => {
          state.connected = true;
          notify();
        },
        onDisconnect: () => {
          state.connected = false;
          notify();
        },
      });
      await refreshSessions();
    },

    destroy() {
      unsubscribeEvents?.();
      unsubscribeEvents = null;
    },

    refreshSessions,

    async selectSession(id: string): Promise<void> {
      if (id === state.sessionId) return;
      state.sessionId = id;
      state.entries = [];
      state.error = '';
      notify();
      try {
        const flattened = await transport.getSessionMessages(id);
        state.entries = flattened.map(entryFromFlattened).filter((e): e is ChatEntry => e !== null);
      } catch (e) {
        state.error = friendlyMessage(e, 'Could not load this session’s history.');
      }
      notify();
    },

    newSession() {
      state.sessionId = null;
      state.entries = [];
      state.error = '';
      notify();
    },

    send,

    async stop(): Promise<void> {
      if (!state.sending || !activeTurn) return;
      const { sessionId, abort } = activeTurn;
      abort.abort();
      try {
        await transport.abortTurn(sessionId);
      } catch {
        // Best-effort — the turn finishes locally below regardless.
      }
      if (state.pendingText) {
        finalizeTurn(sessionId, state.pendingText);
      } else {
        state.sending = false;
        state.pendingText = '';
        activeTurn = null;
        state.entries = [...state.entries, { id: randomId(), kind: 'note', text: 'Stopped.', timestamp: Date.now() }];
        notify();
      }
    },

    async retryFailedSend(): Promise<void> {
      const text = state.lastFailedText;
      if (!text) return;
      state.lastFailedText = '';
      state.error = '';
      await send(text);
    },

    async reconnect(): Promise<void> {
      // Deliberately does NOT touch `entries` — a reconnect must not discard
      // the live transcript (review 2026-07-10 §B5).
      state.error = '';
      await refreshSessions();
    },

    setError(message: string): void {
      state.error = message;
      notify();
    },
  };
}
