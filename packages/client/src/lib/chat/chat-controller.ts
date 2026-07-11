/**
 * Chat page state — plain (rune-free) controller so it unit-tests with
 * bun:test without mounting a Svelte component (packages/client has no
 * vitest-browser-svelte harness). `routes/chat/+page.svelte` is a thin view:
 * it creates one controller per active connection, subscribes to it, and
 * copies `getState()` into local `$state` on every notification.
 *
 * Ports/adapts the relevant slice of `packages/ui/src/lib/chat/
 * chat-state.svelte.ts` for the client's direct-transport, single-connection
 * shape — no voice (that stays host-chat-only, plan §12.2 decision (b)).
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
 *   - B4 [HIGH] permission/question asks: `extractPermissionAsk`/
 *     `extractQuestionAsk` (ported onto the transport alongside
 *     extractTextDelta/isTurnEnd) populate `pendingPermission`/
 *     `pendingQuestion`; `answerPermission()`/`setQuestionAnswer()`/
 *     `answerQuestion()`/`rejectQuestion()` reply via
 *     transport.replyPermission()/replyQuestion()/rejectQuestion() — without
 *     this a permission-gated tool call or a structured question wedged the
 *     turn for 150s with no reply path.
 *   - B9 [MEDIUM] live tool visibility: `extractToolUpdate` populates
 *     `pendingToolStates` (upserted by tool callID, mirrors
 *     `_upsertPendingToolState` in `git show 455d8728:packages/ui/src/lib/
 *     chat/chat-state.svelte.ts`) so long tool-running turns are no longer an
 *     opaque wait; captured tool states are attached to the finalized
 *     assistant entry.
 *   - B12 [MEDIUM] desktop notifications: an injectable `ChatNotifier`
 *     (default: $lib/desktop-notifications.js) is called on turn completion
 *     (`finalizeTurn`, same call site as 455d8728's `finalizeTurn()`) and on
 *     send failure (`send()`'s catch block) — without this a long-running
 *     turn that completes while the app is backgrounded produced no signal
 *     at all.
 */
import {
  notifyAssistantError,
  notifyAssistantReply,
} from '../desktop-notifications.js';
import {
  extractPermissionAsk,
  extractQuestionAsk,
  extractTextDelta,
  extractToolUpdate,
  isTurnEnd,
  type FlattenedEntry,
  type PermissionAsk,
  type QuestionAsk,
  type RawEvent,
  type SessionSummary,
  type ToolStateSnapshot,
  type Transport,
} from '../transport/index.js';

/** Dependency-injected notification sink (§B12) — defaults to the real
 *  desktop-notifications module; tests supply a fake instead of mocking it. */
export type ChatNotifier = {
  notifyReply(text: string): void;
  notifyError(): void;
};

const defaultNotifier: ChatNotifier = {
  notifyReply: notifyAssistantReply,
  notifyError: notifyAssistantError,
};

export type ChatEntry =
  | {
      id: string;
      kind: 'message';
      role: 'user' | 'assistant';
      text: string;
      timestamp: number;
      toolStates?: ToolStateSnapshot[];
    }
  | { id: string; kind: 'note'; text: string; timestamp: number };

/** A pending tool-permission ask, with the reply status layered on top (§B4). */
export type PendingPermissionState = PermissionAsk & {
  status: 'pending' | 'submitting' | 'resolved' | 'error';
  decision: '' | 'once' | 'always' | 'reject';
  message: string;
};

/** A pending structured question, with per-question draft answers (§B4). */
export type PendingQuestionState = QuestionAsk & {
  status: 'pending' | 'submitting' | 'answered' | 'rejected' | 'error';
  answers: string[];
  message: string;
};

export type ChatControllerState = {
  sessions: SessionSummary[];
  sessionId: string | null;
  entries: ChatEntry[];
  /** A turn is in flight — gates submission only, never drafting (B8b). */
  sending: boolean;
  /** Incremental assistant text streamed in via SSE for the in-flight turn. */
  pendingText: string;
  /** Live tool activity for the in-flight turn (§B9), keyed by callID. */
  pendingToolStates: ToolStateSnapshot[];
  /** A tool-permission ask awaiting a reply (§B4), or null. */
  pendingPermission: PendingPermissionState | null;
  /** A structured question awaiting an answer (§B4), or null. */
  pendingQuestion: PendingQuestionState | null;
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
  /** Reply to `pendingPermission` (§B4). No-op if none is pending. */
  answerPermission(reply: 'once' | 'always' | 'reject'): Promise<void>;
  /** Record a draft answer for question `index` (§B4). No-op if none is pending. */
  setQuestionAnswer(index: number, answer: string): void;
  /**
   * Submit `pendingQuestion`'s answers (§B4). `answer` is a shortcut for the
   * common single-question case — equivalent to
   * `setQuestionAnswer(0, answer)` immediately before submitting.
   */
  answerQuestion(answer?: string): Promise<void>;
  /** Decline `pendingQuestion` (§B4). No-op if none is pending. */
  rejectQuestion(): Promise<void>;
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
  // 'tool-group'); FlattenedMessage has none. A tool-only group (no
  // following assistant text in the same OpenCode message) renders nothing
  // here — there is no message entry to attach it to.
  if ('type' in entry) return null;
  return {
    id: entry.id,
    kind: 'message',
    role: entry.role,
    text: entry.text,
    timestamp: entry.timestamp,
    ...(entry.toolStates && entry.toolStates.length > 0 ? { toolStates: entry.toolStates } : {}),
  };
}

export function createChatController(
  transport: Transport,
  notifier: ChatNotifier = defaultNotifier
): ChatController {
  const state: ChatControllerState = {
    sessions: [],
    sessionId: null,
    entries: [],
    sending: false,
    pendingText: '',
    pendingToolStates: [],
    pendingPermission: null,
    pendingQuestion: null,
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

  /** Clears every pending-render field (§B4/§B9) — called whenever a turn ends. */
  function resetPendingRenderState(): void {
    state.pendingText = '';
    state.pendingToolStates = [];
    state.pendingPermission = null;
    state.pendingQuestion = null;
  }

  function finalizeTurn(sessionId: string, replyTextOverride?: string): void {
    // Guards the SSE-isTurnEnd-vs-sendMessage-resolving race (whichever
    // notices first finalizes; the other is a no-op).
    if (!state.sending || !activeTurn || activeTurn.sessionId !== sessionId) return;
    const raw = replyTextOverride ?? state.pendingText;
    const text = raw.trim() || '(The assistant sent no text.)';
    const capturedToolStates = state.pendingToolStates.length > 0 ? [...state.pendingToolStates] : undefined;
    state.entries = [
      ...state.entries,
      {
        id: randomId(),
        kind: 'message',
        role: 'assistant',
        text,
        timestamp: Date.now(),
        ...(capturedToolStates ? { toolStates: capturedToolStates } : {}),
      },
    ];
    state.sending = false;
    resetPendingRenderState();
    activeTurn = null;
    notify();
    // §B12: content-free by default (notifier decides what, if anything, to
    // surface) — mirrors 455d8728's finalizeTurn() call site.
    notifier.notifyReply(text === '(The assistant sent no text.)' ? '' : text);
  }

  /** Upsert a live tool-activity update by callID (§B9, mirrors the old
   *  chat-state's `_upsertPendingToolState`). */
  function upsertToolState(update: {
    callID: string;
    tool: string;
    status: string;
    title?: string;
    detail?: string;
    output?: string;
    error?: string;
  }): void {
    const id = update.callID || `${update.tool}:${state.pendingToolStates.length}`;
    const next: ToolStateSnapshot = {
      id,
      tool: update.tool,
      status: update.status,
      title: update.title ?? update.tool,
      detail: update.detail ?? '',
      output: update.output ?? '',
      error: update.error ?? '',
      updatedAt: Date.now(),
    };
    const existing = state.pendingToolStates.find((item) => item.id === id);
    state.pendingToolStates = existing
      ? state.pendingToolStates.map((item) => (item.id === id ? { ...item, ...next } : item))
      : [...state.pendingToolStates, next];
  }

  function handleEvent(event: RawEvent): void {
    if (!state.sending || !activeTurn) return;
    const sessionId = activeTurn.sessionId;
    const delta = extractTextDelta(event, sessionId);
    if (delta) {
      state.pendingText += delta;
      notify();
    }

    const toolUpdate = extractToolUpdate(event, sessionId);
    if (toolUpdate) {
      upsertToolState(toolUpdate);
      notify();
    }

    const permissionAsk = extractPermissionAsk(event, sessionId);
    if (permissionAsk) {
      state.pendingPermission = { ...permissionAsk, status: 'pending', decision: '', message: '' };
      notify();
    }

    const questionAsk = extractQuestionAsk(event, sessionId);
    if (questionAsk) {
      state.pendingQuestion = {
        ...questionAsk,
        status: 'pending',
        answers: questionAsk.questions.map(() => ''),
        message: '',
      };
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
    resetPendingRenderState();
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
      resetPendingRenderState();
      activeTurn = null;
      state.error = friendlyMessage(e, 'Sending the message failed.');
      notify();
      notifier.notifyError(); // §B12, mirrors 455d8728's send() catch block.
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
        resetPendingRenderState();
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

    async answerPermission(reply: 'once' | 'always' | 'reject'): Promise<void> {
      const current = state.pendingPermission;
      if (!current || current.status === 'submitting') return;
      state.pendingPermission = { ...current, status: 'submitting', decision: reply, message: '' };
      notify();
      try {
        await transport.replyPermission(current.requestID, reply);
        state.pendingPermission = {
          ...current,
          status: 'resolved',
          decision: reply,
          message:
            reply === 'once'
              ? `Allowed ${current.permission} once. Waiting for the assistant to continue...`
              : reply === 'always'
                ? `Always allowed future matching ${current.permission} requests.`
                : `Denied ${current.permission}. Waiting for the assistant to continue...`,
        };
      } catch (e) {
        state.pendingPermission = {
          ...current,
          status: 'error',
          decision: reply,
          message: e instanceof Error ? e.message : 'Failed to record permission reply.',
        };
      }
      notify();
    },

    setQuestionAnswer(index: number, answer: string): void {
      const current = state.pendingQuestion;
      if (!current) return;
      if (index < 0 || index >= current.questions.length) return;
      const answers = [...current.answers];
      answers[index] = answer;
      state.pendingQuestion = { ...current, answers, message: '' };
      notify();
    },

    async answerQuestion(answer?: string): Promise<void> {
      const current = state.pendingQuestion;
      if (!current || current.status === 'submitting') return;
      const answers =
        current.questions.length === 1 && typeof answer === 'string'
          ? [answer.trim()]
          : current.answers.map((item) => item.trim());
      if (answers.some((item) => !item)) {
        state.pendingQuestion = { ...current, status: 'error', message: 'Answer every question before submitting.' };
        notify();
        return;
      }
      state.pendingQuestion = { ...current, status: 'submitting', answers, message: '' };
      notify();
      try {
        await transport.replyQuestion(
          current.requestID,
          answers.map((item) => [item])
        );
        state.pendingQuestion = { ...current, status: 'answered', answers, message: 'Answer sent.' };
      } catch (e) {
        state.pendingQuestion = {
          ...current,
          status: 'error',
          answers,
          message: e instanceof Error ? e.message : 'Failed to send answer.',
        };
      }
      notify();
    },

    async rejectQuestion(): Promise<void> {
      const current = state.pendingQuestion;
      if (!current || current.status === 'submitting') return;
      state.pendingQuestion = { ...current, status: 'submitting', message: '' };
      notify();
      try {
        await transport.rejectQuestion(current.requestID);
        state.pendingQuestion = { ...current, status: 'rejected', message: 'Question declined.' };
      } catch (e) {
        state.pendingQuestion = {
          ...current,
          status: 'error',
          message: e instanceof Error ? e.message : 'Failed to reject question.',
        };
      }
      notify();
    },

    setError(message: string): void {
      state.error = message;
      notify();
    },
  };
}
