/**
 * The ONE client transport (plan ui-runtime-modes-plan.md §6.11; P5b item 1,
 * #555): talk to a connection's OpenCode/guardian base URL DIRECTLY from the
 * browser with the connection's own credentials.
 *
 * Deliberate differences from the host app's chat api
 * (packages/ui/src/lib/api/chat.ts), which is the reference implementation:
 *   - no same-origin `/proxy/assistant/*` broker — requests go straight to
 *     the connection base URL,
 *   - no cookies, ever: every request sets `credentials: 'omit'` (the host
 *     app's proxy transport does the opposite, `credentials: 'include'`;
 *     the client holds per-connection credentials, not host cookies —
 *     plan §6.8/§8.10),
 *   - auth is derived from the connection: Basic (username defaults to
 *     'opencode' — OpenCode's own server default and what the host app sends,
 *     so shipped home-password credentials work without a username field
 *     (PR #564 P2-2); the encoder is UTF-8-safe), Bearer, or none.
 *
 * Everything here is pure TS with an injectable fetch — unit-tested in
 * packages/client/tests/transport-*.test.ts (the pinned contract).
 *
 * Post-merge review 2026-07-10 (docs/reviews/ui-admin-migration-review-
 * 2026-07-10.md) additions, ported/adapted from the packages/ui reference
 * implementations named in each doc comment below:
 *   - §B2 subscribeEvents() + extractTextDelta()/isTurnEnd() — live SSE
 *     streaming (packages/ui session-events.ts + oc-events.ts),
 *   - §B3 abortTurn() + a caller-owned AbortSignal on sendMessage() — stop
 *     in-flight turns,
 *   - §B4 replyPermission()/replyQuestion()/rejectQuestion() — answer
 *     permission asks and structured questions,
 *   - §B5 getSessionMessages() + flattenSessionMessages() — session history
 *     (packages/ui session-messages.ts + tool-strip.ts),
 *   - §E3 probeHealth()'s 'blocked' state — distinguish a CORS-denied
 *     connection from a genuinely down one,
 *   - §E5 structured error-body extraction on !response.ok,
 *   - §E8 UTF-8-safe Basic-auth header encoding.
 *
 * #557 D6 — probeHealth()'s 'insecure' state: a plain-http remote target on
 * an https app origin is refused by the browser's mixed-content blocker
 * before any response is observable, so a raw fetch there would surface as
 * a misleading 'unreachable' (a TypeError, then a no-cors re-probe that is
 * ALSO mixed-content-blocked). validateConnectionUrl() (./connections/
 * url-policy.ts) is consulted first and short-circuits with zero network I/O.
 */
import { validateConnectionUrl } from '../connections/url-policy.js';

export type ConnectionAuth =
  | { mode: 'none' }
  | { mode: 'basic'; username?: string; password: string }
  | { mode: 'bearer'; token: string };

export type SessionSummary = {
  id: string;
  /** '' until OpenCode summarizes (UI renders a fallback). */
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type HealthProbeResult = {
  /**
   * 'blocked' (review 2026-07-10 §E3) means the connection is very likely UP
   * but its CORS policy refuses the browser origin — see the heuristic on
   * `probeCorsBlock` below. 'insecure' (#557 D6) means the target is a
   * plain-http non-loopback URL and the app itself runs on an https origin —
   * the browser's mixed-content blocker would refuse the request outright,
   * so `probeHealth()` short-circuits via `validateConnectionUrl()` instead
   * of performing a doomed fetch (`detail: 'plain-http-remote'`). Existing
   * consumers that only match the pre-existing states keep working; both are
   * additive.
   */
  state: 'accessible' | 'unauthorized' | 'unreachable' | 'blocked' | 'insecure';
  detail?: string;
};

export type TransportOptions = {
  baseUrl: string;
  /** Default: { mode: 'none' }. */
  auth?: ConnectionAuth;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Path `probeHealth()` GETs relative to `baseUrl` (default `'/'`). Guardian
   * `/oc`-fronted connections ('openpalm-client-api' kind, #486 D2) probe an
   * allowlisted route (`'/session'`) instead — bare `GET /oc/` is not an
   * allowlisted guardian route and 404s even against a fully healthy
   * guardian.
   */
  probePath?: string;
};

/** Raw OpenCode SSE event envelope (session.*, message.*, tool.*, permission.*, question.*, …). */
export type RawEvent = {
  type: string;
  properties?: Record<string, unknown>;
};

export type StreamHandlers = {
  /**
   * Called for every parsed event on the stream, regardless of type. The
   * transport does no session-scoped filtering itself (unlike the host app's
   * subscribeSessionEvents) — the UI stage combines this with
   * `extractTextDelta`/`isTurnEnd` below (and its own tool/permission/question
   * extraction) to build per-session behavior.
   */
  onEvent(event: RawEvent): void;
  onConnect?(): void;
  onDisconnect?(error: Error): void;
  /**
   * Called instead of an indefinite reconnect loop when the `/event` stream
   * fails with 401/403 (review F6) — the stored credentials were rejected,
   * which will never self-heal by retrying. `subscribeEvents()` stops
   * reconnecting once this fires; the consumer (chat-controller) surfaces it
   * as an error state instead of silently retrying forever.
   */
  onAuthError?(error: Error): void;
};

/** A raw OpenCode session-message part, as returned by `GET /session/:id/message`. */
export type SessionMessagePart = {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  id?: string;
  state?: {
    status?: string;
    title?: string;
    input?: unknown;
    metadata?: unknown;
    progress?: unknown;
    output?: unknown;
    error?: string;
  };
};

/** A raw OpenCode message row, as returned by `GET /session/:id/message`. */
export type SessionMessageRow = {
  info: {
    id: string;
    role: 'user' | 'assistant';
    time?: { created?: number };
  };
  parts: SessionMessagePart[];
};

/** A tool/step snapshot attached to a flattened message (packages/ui ToolStripEntry, trimmed to transport concerns — no presentation helpers). */
export type ToolStateSnapshot = {
  id: string;
  tool: string;
  status: string;
  title: string;
  detail: string;
  output: string;
  error: string;
  updatedAt: number;
};

export type FlattenedMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  toolStates?: ToolStateSnapshot[];
};

/** Tool parts with no following assistant text in the same OpenCode message. */
export type FlattenedToolGroup = {
  id: string;
  type: 'tool-group';
  toolStates: ToolStateSnapshot[];
  timestamp: number;
};

export type FlattenedEntry = FlattenedMessage | FlattenedToolGroup;

export type Transport = {
  listSessions(): Promise<SessionSummary[]>;
  createSession(): Promise<{ id: string }>;
  /**
   * POST the OpenCode parts envelope. `options.signal` lets the caller wire
   * a stop button (or its own timeout); when omitted, the 150s default
   * budget applies (review 2026-07-10 §B3).
   */
  sendMessage(sessionId: string, text: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  /** POST `/session/{id}/abort` — best-effort turn cancellation (§B3). */
  abortTurn(sessionId: string): Promise<void>;
  /** GET + flatten a session's message history (§B5). */
  getSessionMessages(sessionId: string): Promise<FlattenedEntry[]>;
  /** POST a reply to a pending tool-permission ask (§B4). */
  replyPermission(requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void>;
  /** POST answers to a pending structured question (§B4). */
  replyQuestion(requestId: string, answers: string[][]): Promise<void>;
  /** POST a rejection of a pending structured question (§B4). */
  rejectQuestion(requestId: string): Promise<void>;
  /**
   * Open the OpenCode `/event` SSE stream and dispatch every parsed event.
   * Returns an unsubscribe function that aborts the stream and prevents
   * reconnection (§B2, ported from packages/ui session-events.ts).
   */
  subscribeEvents(handlers: StreamHandlers): () => void;
  probeHealth(): Promise<HealthProbeResult>;
};

/** One parsed SSE frame ('\n\n'-delimited; multi-line data joined with '\n'). */
export type SseFrame = { event?: string; data?: string; id?: string };

/** OpenCode responses can take 30–120s (same budget as the host app). */
const MESSAGE_TIMEOUT_MS = 150_000;
const PROBE_TIMEOUT_MS = 5_000;

/** SSE reconnect backoff (ported from packages/ui session-events.ts, §B2). */
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * UTF-8-encode before base64ing (review 2026-07-10 §E8): `btoa()` alone only
 * accepts Latin-1 code points and throws a synchronous `InvalidCharacterError`
 * for any password containing e.g. Cyrillic/CJK/emoji characters, before any
 * network I/O happens — the old broker used a UTF-8 Buffer encoding instead.
 */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function authorizationHeader(auth: ConnectionAuth): string | null {
  if (auth.mode === 'basic') {
    const username = auth.username ?? 'opencode';
    return `Basic ${base64Utf8(`${username}:${auth.password}`)}`;
  }
  if (auth.mode === 'bearer') return `Bearer ${auth.token}`;
  return null;
}

/**
 * On !response.ok, prefer a JSON `message`/`error` field, else trimmed
 * response text, else the `fallback` (review 2026-07-10 §E5 — mirrors the old
 * `readErrorMessage`, `git show 455d8728:packages/ui/src/lib/api/core.ts`).
 * Structured guardian/OpenCode errors (`cors_origin_denied`, provider auth
 * failures, …) were previously discarded in favor of a bare "HTTP <status>".
 */
async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await response
      .clone()
      .json()
      .catch(() => null)) as Record<string, unknown> | null;
    if (data && typeof data.message === 'string' && data.message.length > 0) return data.message;
    if (data && typeof data.error === 'string' && data.error.length > 0) return data.error;
  }
  const text = (await response.text().catch(() => '')).trim();
  return text || fallback;
}

export function createTransport(options: TransportOptions): Transport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const auth = options.auth ?? { mode: 'none' };
  // Trailing-slash and path-prefix safe: '/opencode/' + '/session' must
  // become '/opencode/session' (reverse-proxied instances keep their prefix).
  const base = options.baseUrl.replace(/\/+$/, '');
  const probePath = options.probePath ?? '/';

  function buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    const authorization = authorizationHeader(auth);
    if (authorization) headers.authorization = authorization;
    return headers;
  }

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: buildHeaders(body === undefined ? undefined : { 'content-type': 'application/json' }),
      // 'omit' is the only fetch credentials mode that guarantees no cookies
      // — the default 'same-origin' would still leak cookies to a
      // same-origin connection URL. Never 'include'.
      credentials: 'omit',
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal) init.signal = signal;
    const response = await fetchImpl(`${base}${path}`, init);
    if (!response.ok) {
      const message = await readErrorMessage(response, `HTTP ${response.status}`);
      throw Object.assign(new Error(message), { status: response.status });
    }
    return response;
  }

  async function parseSseMessage(response: Response): Promise<unknown> {
    if (!response.body) return null;
    let lastPayload: unknown = null;
    try {
      for await (const frame of parseSseStream(response.body)) {
        if (!frame.data) continue;
        try {
          const payload = JSON.parse(frame.data) as unknown;
          lastPayload = payload;
          if (typeof payload === 'object' && payload !== null && 'parts' in payload) {
            return payload;
          }
        } catch {}
      }
    } catch (error) {
      throw error instanceof Error
        ? error
        : Object.assign(new Error(String(error)), { status: 502 });
    }
    return lastPayload;
  }

  return {
    /**
     * List sessions on the connection. OpenCode returns `Array<Session>`
     * with no ordering guarantee; sorted desc by `time.updated` here so
     * consumers can rely on it (ported from packages/ui listSessions()).
     */
    async listSessions(): Promise<SessionSummary[]> {
      const res = await request('GET', '/session');
      const raw = (await res.json()) as Array<{
        id: string;
        title?: string;
        time?: { created?: number; updated?: number };
      }>;
      const summaries: SessionSummary[] = raw.map((s) => ({
        id: s.id,
        title: s.title ?? '',
        createdAt: s.time?.created ?? 0,
        updatedAt: s.time?.updated ?? s.time?.created ?? 0,
      }));
      summaries.sort((a, b) => b.updatedAt - a.updatedAt);
      return summaries;
    },

    async createSession(): Promise<{ id: string }> {
      const res = await request('POST', '/session', {});
      return (await res.json()) as { id: string };
    },

    /**
     * POST the OpenCode parts envelope; resolves with the raw response body.
     * `options.signal` (§B3) lets the caller cancel the send (e.g. a stop
     * button) or supply its own timeout; the 150s default applies only when
     * no signal is given.
     */
    async sendMessage(
      sessionId: string,
      text: string,
      options?: { signal?: AbortSignal }
    ): Promise<unknown> {
      const res = await request(
        'POST',
        `/session/${encodeURIComponent(sessionId)}/message`,
        { parts: [{ type: 'text', text }] },
        options?.signal ?? AbortSignal.timeout(MESSAGE_TIMEOUT_MS)
      );
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
      if (contentType.startsWith('text/event-stream')) {
        return parseSseMessage(res);
      }
      return (await res.json()) as unknown;
    },

    /**
     * Best-effort cancellation of an in-flight turn (§B3, mirrors
     * `abortChatTurn` — OpenCode exposes this as `POST /session/{id}/abort`,
     * see `@opencode-ai/sdk` `session.abort`).
     */
    async abortTurn(sessionId: string): Promise<void> {
      await request('POST', `/session/${encodeURIComponent(sessionId)}/abort`, {});
    },

    /**
     * Fetch a session's message history and flatten it into renderable
     * entries (§B5) — old sessions must not open empty on reload/reselect.
     */
    async getSessionMessages(sessionId: string): Promise<FlattenedEntry[]> {
      const res = await request('GET', `/session/${encodeURIComponent(sessionId)}/message`);
      const rows = (await res.json()) as SessionMessageRow[];
      return flattenSessionMessages(rows);
    },

    /** Reply to a pending tool-permission ask (§B4). */
    async replyPermission(requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
      await request('POST', `/permission/${encodeURIComponent(requestId)}/reply`, { reply });
    },

    /** Answer a pending structured question (§B4). */
    async replyQuestion(requestId: string, answers: string[][]): Promise<void> {
      await request('POST', `/question/${encodeURIComponent(requestId)}/reply`, { answers });
    },

    /** Reject a pending structured question (§B4). */
    async rejectQuestion(requestId: string): Promise<void> {
      await request('POST', `/question/${encodeURIComponent(requestId)}/reject`, {});
    },

    /**
     * Open the OpenCode `/event` SSE stream (§B2). Ported from
     * packages/ui/src/lib/chat/session-events.ts subscribeSessionEvents():
     * hand-rolled fetch + reader (not EventSource) so reconnect backoff and
     * Last-Event-ID resend stay under our control; reconnects with
     * exponential backoff (1s → 30s) on error, a short fixed delay on a clean
     * stream close, and never reconnects after unsubscribe. Every event is
     * handed to `onEvent` — session-scoped filtering
     * (extractTextDelta/isTurnEnd below, or the UI stage's own tool/
     * permission/question extraction) is the caller's job.
     */
    subscribeEvents(handlers: StreamHandlers): () => void {
      let stopped = false;
      let controller = new AbortController();
      let lastEventId: string | undefined;

      // §T2: the `{ once: true }` abort listener below only ever self-removes
      // when `controller.signal` actually aborts — which never happens on the
      // normal (non-aborted) path of a reconnect delay elapsing on its own,
      // so every ordinary sleep() call left one more listener permanently
      // attached to the same long-lived signal. Explicitly remove it once
      // the timer fires too, so a clean elapse cleans up just as the abort
      // path does.
      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });

      async function readStream(): Promise<void> {
        const headers = buildHeaders({ accept: 'text/event-stream' });
        if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;
        const response = await fetchImpl(`${base}/event`, {
          method: 'GET',
          headers,
          credentials: 'omit',
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          // §F6: attach `status` (mirrors request() above) so 401/403 can be
          // told apart from a generic transient disconnect below — a bare
          // Error with no status made an auth failure indistinguishable from
          // "the network hiccuped", so it reconnect-looped with backoff
          // forever instead of ever giving up.
          throw Object.assign(new Error(`SSE stream failed: ${response.status} ${response.statusText}`), {
            status: response.status,
          });
        }
        handlers.onConnect?.();
        for await (const frame of parseSseStream(response.body)) {
          if (frame.id !== undefined) lastEventId = frame.id;
          if (!frame.data) continue;
          let payload: RawEvent;
          try {
            payload = JSON.parse(frame.data) as RawEvent;
          } catch {
            continue; // Bad JSON in a frame — skip it, keep the stream alive.
          }
          handlers.onEvent(payload);
        }
      }

      void (async () => {
        let attempt = 0;
        while (!stopped) {
          try {
            attempt++;
            await readStream();
            // Clean server-side close — reconnect promptly, don't tight-loop.
            attempt = 0;
            if (!stopped) await sleep(500);
          } catch (err) {
            if (stopped) return;
            const error = err instanceof Error ? err : new Error(String(err));
            // AbortError means WE tore the stream down (unsubscribe) — not a
            // disconnect worth reporting.
            if (error.name !== 'AbortError') {
              handlers.onDisconnect?.(error);
            }
            // §F6: 401/403 means the stored credentials were rejected — that
            // will never self-heal by retrying, so surface it as an
            // auth-failure and stop reconnecting instead of looping with
            // backoff forever.
            const status = (error as { status?: number }).status;
            if (status === 401 || status === 403) {
              handlers.onAuthError?.(error);
              return;
            }
            const backoff = Math.min(INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
            await sleep(backoff);
            if (controller.signal.aborted && !stopped) {
              controller = new AbortController();
            }
          }
        }
      })();

      return () => {
        stopped = true;
        try {
          controller.abort();
        } catch {
          // noop
        }
      };
    },

    /**
     * GET the connection base URL and map the outcome onto the host app's
     * RemoteStatus vocabulary (packages/ui probeEndpoint()), plus a 'blocked'
     * state this transport adds (§E3 — see probeCorsBlock below for the
     * disambiguation heuristic). Never throws — connection health is data,
     * not an exception path.
     */
    async probeHealth(): Promise<HealthProbeResult> {
      // #557 D6: an `insecure-remote` verdict means the fetch below is
      // doomed (mixed-content-blocked by the browser before it ever leaves)
      // — short-circuit with zero network I/O rather than let it surface as
      // a misleading 'unreachable'. An `invalid-url` verdict does NOT
      // short-circuit: an unparseable base already surfaces as 'unreachable'
      // via the fetch throw below, unchanged behavior.
      const verdict = validateConnectionUrl(base);
      if (!verdict.ok && verdict.reason === 'insecure-remote') {
        return { state: 'insecure', detail: 'plain-http-remote' };
      }
      try {
        const response = await fetchImpl(`${base}${probePath}`, {
          method: 'GET',
          headers: buildHeaders(),
          credentials: 'omit',
          // H1 (review 2026-07-10 §H1): a service worker's NetworkFirst
          // runtime cache would otherwise happily serve a stale cached probe
          // response through a real outage — the connection badge and the
          // chat page's reachability check would both keep reporting
          // "reachable" forever. 'no-store' never enters Cache Storage.
          cache: 'no-store',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (response.status === 401 || response.status === 403) {
          return { state: 'unauthorized', detail: `HTTP ${response.status}` };
        }
        if (response.ok || (response.status >= 300 && response.status < 400)) {
          return { state: 'accessible' };
        }
        return { state: 'unreachable', detail: `HTTP ${response.status}` };
      } catch (error) {
        if (error instanceof TypeError && (await probeCorsBlock(fetchImpl, base))) {
          return { state: 'blocked', detail: 'cors' };
        }
        return {
          state: 'unreachable',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * Disambiguate a CORS-blocked connection from a genuinely down one (review
 * 2026-07-10 §E3). Both surface identically as `fetch` throwing a bare
 * `TypeError` — the browser gives script no way to read a CORS-denied
 * response's status. Heuristic: re-probe with `mode: 'no-cors'`. A no-cors
 * request still resolves (as an unreadable "opaque" response) whenever the
 * server is reachable at the network level, REGARDLESS of what CORS headers
 * it sends back — no-cors requests are never subject to the CORS check that
 * makes normal-mode fetches throw. So:
 *   - no-cors probe resolves   -> the server IS up; the original TypeError
 *     can only have been the browser refusing to expose a cross-origin
 *     response body -> CORS-blocked.
 *   - no-cors probe ALSO throws -> genuinely unreachable (DNS/connection
 *     failure, not a CORS policy).
 * The no-cors probe carries no custom headers: no-cors mode restricts
 * requests to CORS-safelisted headers, and `authorization` is not one of
 * them (browsers would otherwise silently strip it or reject the request).
 */
async function probeCorsBlock(fetchImpl: typeof globalThis.fetch, base: string): Promise<boolean> {
  try {
    await fetchImpl(`${base}/`, {
      method: 'GET',
      mode: 'no-cors',
      credentials: 'omit',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse one '\n\n'-delimited SSE frame body. Multi-line `data:` fields are
 * concatenated with '\n' per the SSE spec; comment lines (':…') and `retry:`
 * fields are ignored (same behavior as packages/ui session-events.ts
 * parseFrame()).
 */
function parseFrame(chunk: string): SseFrame {
  const frame: SseFrame = {};
  const dataLines: string[] = [];
  for (const rawLine of chunk.split('\n')) {
    if (!rawLine || rawLine.startsWith(':')) continue; // comment / heartbeat
    if (rawLine.startsWith('data:')) {
      dataLines.push(rawLine.replace(/^data:\s?/, ''));
    } else if (rawLine.startsWith('event:')) {
      frame.event = rawLine.replace(/^event:\s?/, '');
    } else if (rawLine.startsWith('id:')) {
      frame.id = rawLine.replace(/^id:\s?/, '');
    }
    // `retry:` is ignored — reconnect pacing is the consumer's concern.
  }
  if (dataLines.length > 0) frame.data = dataLines.join('\n');
  return frame;
}

/**
 * Parse a raw SSE byte stream into frames. Yields ONLY frames that carry at
 * least one of event/data/id (comment-only and retry-only frames yield
 * nothing); an unterminated trailing frame at end-of-stream is discarded
 * (SSE spec). Frames split across chunk boundaries are buffered, and the
 * decoder runs in streaming mode so multi-byte UTF-8 characters split
 * mid-sequence decode correctly.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        if (!chunk) continue;
        const frame = parseFrame(chunk);
        if (frame.event !== undefined || frame.data !== undefined || frame.id !== undefined) {
          yield frame;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Message-stream parsing (§B2, ported/adapted from packages/ui oc-events.ts) ──
// Pure functions the UI stage layers on top of subscribeEvents()'s onEvent
// callback to render incremental assistant text without a 150s blocking wait.

function propStr(props: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = props?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Identify a `message.part.updated` event's part id/type (e.g. `'reasoning'`
 * vs `'text'`), or null if the event isn't a part-snapshot at all. Ported
 * from packages/ui/src/lib/chat/oc-events.ts partSnapshotType() — the
 * chat-controller uses this to build a per-turn `reasoningPartIds` set
 * (§F10) so `extractTextDelta` can exclude a reasoning model's thinking-token
 * deltas from the rendered assistant reply.
 */
export function partSnapshotType(event: RawEvent): { partID: string; type: string } | null {
  if (event.type !== 'message.part.updated') return null;
  const part = event.properties?.part as { id?: unknown; type?: unknown } | undefined;
  if (typeof part?.id === 'string' && typeof part.type === 'string') {
    return { partID: part.id, type: part.type };
  }
  return null;
}

/**
 * Extract an incremental assistant-text chunk for `sessionId` from a raw
 * OpenCode event, or null if the event carries none (wrong session, wrong
 * type, a non-text delta field, or a reasoning-part delta named in
 * `reasoningPartIds`). Ported from packages/ui/src/lib/chat/oc-events.ts.
 */
export function extractTextDelta(
  event: RawEvent,
  sessionId: string,
  reasoningPartIds?: ReadonlySet<string>
): string | null {
  const props = event.properties ?? {};
  if (propStr(props, 'sessionID') !== sessionId) return null;

  if (event.type === 'session.next.text.delta') {
    return propStr(props, 'delta') ?? propStr(props, 'text') ?? null;
  }

  if (event.type === 'message.part.delta') {
    const field = propStr(props, 'field');
    if (field && field !== 'text') return null;
    const partID = propStr(props, 'partID');
    if (partID && reasoningPartIds?.has(partID)) return null;
    return propStr(props, 'delta') ?? null;
  }

  return null;
}

function statusName(status: unknown): string | undefined {
  if (typeof status === 'string') return status;
  if (status && typeof status === 'object' && typeof (status as { type?: unknown }).type === 'string') {
    return (status as { type: string }).type;
  }
  return undefined;
}

/**
 * Whether a raw OpenCode event marks the end of `sessionId`'s in-flight
 * turn. Ported from packages/ui/src/lib/chat/oc-events.ts.
 */
export function isTurnEnd(event: RawEvent, sessionId: string): boolean {
  const props = event.properties ?? {};
  if (propStr(props, 'sessionID') !== sessionId) return false;
  if (event.type === 'session.idle') return true;
  if (event.type === 'session.status') {
    const name = statusName(props.status);
    return name === 'idle' || name === 'completed' || name === 'done';
  }
  return false;
}

// ── Permission/question/tool asks (§B4, §B9, ported from packages/ui oc-events.ts) ──
// Layered on top of subscribeEvents()'s onEvent callback by the UI stage
// (chat-controller.ts), the same way extractTextDelta/isTurnEnd already are.

export type ToolUpdate = {
  callID: string;
  tool: string;
  status: string;
  title?: string;
  detail?: string;
  output?: string;
  error?: string;
};

export type PermissionAsk = {
  requestID: string;
  permission: string;
  patterns: string[];
  always: string[];
  tool: string;
  detail: string;
};

export type QuestionOption = {
  label: string;
  description: string;
};

export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
};

export type QuestionAsk = {
  requestID: string;
  questions: QuestionInfo[];
};

function askValueToText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value == null) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function askFirstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = askValueToText(value);
    if (text) return text;
  }
  return undefined;
}

/**
 * Extract a `permission.asked` event for `sessionId`, or null (wrong session,
 * wrong type, or no request id). Ported from
 * packages/ui/src/lib/chat/oc-events.ts extractPermissionAsk().
 */
export function extractPermissionAsk(event: RawEvent, sessionId: string): PermissionAsk | null {
  if (event.type !== 'permission.asked') return null;
  if (propStr(event.properties, 'sessionID') !== sessionId) return null;
  const id = propStr(event.properties, 'id');
  if (!id) return null;
  const patterns = Array.isArray(event.properties?.patterns)
    ? (event.properties.patterns as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const always = Array.isArray(event.properties?.always)
    ? (event.properties.always as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const toolRecord = event.properties?.tool as Record<string, unknown> | undefined;
  return {
    requestID: id,
    permission: propStr(event.properties, 'permission') ?? 'tool',
    patterns,
    always,
    tool: propStr(toolRecord, 'callID') ?? propStr(event.properties, 'permission') ?? 'tool',
    detail: askFirstText(event.properties?.metadata, event.properties?.message) ?? '',
  };
}

/**
 * Extract a `question.asked` event for `sessionId`, or null (wrong session,
 * wrong type, or an empty questions array). Ported from
 * packages/ui/src/lib/chat/oc-events.ts extractQuestionAsk().
 */
export function extractQuestionAsk(event: RawEvent, sessionId: string): QuestionAsk | null {
  if (event.type !== 'question.asked') return null;
  if (propStr(event.properties, 'sessionID') !== sessionId) return null;
  const id = propStr(event.properties, 'id');
  if (!id) return null;
  const rawQuestions = Array.isArray(event.properties?.questions) ? event.properties.questions : [];
  const questions: QuestionInfo[] = [];
  for (const raw of rawQuestions) {
    const item = raw as { question?: unknown; header?: unknown; options?: unknown };
    const options = Array.isArray(item.options)
      ? item.options
          .map((option) => option as { label?: unknown; description?: unknown })
          .filter((option) => typeof option.label === 'string')
          .map((option) => ({
            label: option.label as string,
            description: typeof option.description === 'string' ? option.description : '',
          }))
      : [];
    questions.push({
      question: typeof item.question === 'string' ? item.question : '',
      header: typeof item.header === 'string' ? item.header : '',
      options,
    });
  }
  if (questions.length === 0) return null;
  return { requestID: id, questions };
}

/**
 * Extract a live tool-activity update from a raw event (either a
 * `message.part.updated` tool part, or an OpenCode `session.next.tool.*`
 * lifecycle event), or null. Ported from packages/ui/src/lib/chat/
 * oc-events.ts extractToolUpdate() — drives the B9 ToolLog rail while a turn
 * is in flight (the history counterpart, `toolStateFromPart` above, covers
 * already-completed turns loaded via getSessionMessages()).
 */
export function extractToolUpdate(event: RawEvent, sessionId: string): ToolUpdate | null {
  const props = event.properties ?? {};
  if (propStr(props, 'sessionID') !== sessionId) return null;

  const part = (props.part ?? props.tool) as Record<string, unknown> | undefined;
  if (event.type === 'message.part.updated' && part && (part.type === 'tool' || part.state)) {
    const state = (part.state ?? {}) as Record<string, unknown>;
    return {
      callID: String(part.callID ?? part.id ?? ''),
      tool: String(part.tool ?? 'tool'),
      status: String(state.status ?? 'running'),
      title: typeof state.title === 'string' ? state.title : undefined,
      detail: askFirstText(state.input, state.metadata, state.progress, state.output),
      output: askValueToText(state.output),
      error: typeof state.error === 'string' ? state.error : undefined,
    };
  }

  if (event.type.startsWith('session.next.tool.')) {
    const type = event.type.replace('session.next.tool.', '');
    return {
      callID: propStr(props, 'callID') ?? '',
      tool: propStr(props, 'tool') ?? 'tool',
      status:
        type === 'completed'
          ? 'completed'
          : type === 'failed'
            ? 'error'
            : type === 'called'
              ? 'running'
              : (propStr(props, 'status') ?? 'running'),
      title: propStr(props, 'title') ?? propStr(props, 'tool'),
      detail: askFirstText(props.message, props.delta, props.progress, props.input, props.metadata),
      output: askFirstText(props.output, props.result),
      error: askFirstText(props.error),
    };
  }

  return null;
}

// ── Session-history flattening (§B5, ported from packages/ui session-messages.ts + tool-strip.ts) ──

function valueToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = valueToText(value);
    if (text) return text;
  }
  return '';
}

/**
 * Map one tool/state part to a `ToolStateSnapshot`, or null if the part
 * isn't a tool part. Ported from packages/ui/src/lib/chat/tool-strip.ts
 * toolStripEntryFromSessionPart() — trimmed to the fields the transport
 * layer owns (icon/label/formatting presentation helpers stay a UI concern).
 */
function toolStateFromPart(part: SessionMessagePart, fallbackId: string): ToolStateSnapshot | null {
  if (part.type !== 'tool' && !part.state) return null;
  const status = part.state?.status ?? 'running';
  return {
    id: part.callID ?? part.id ?? fallbackId,
    tool: part.tool ?? 'tool',
    status,
    title: part.state?.title ?? part.tool ?? 'tool',
    detail: firstText(part.state?.input, part.state?.metadata, part.state?.progress, part.state?.output),
    output: valueToText(part.state?.output),
    error: part.state?.error ?? '',
    updatedAt: Date.now(),
  };
}

/**
 * Flatten raw OpenCode session-message rows into renderable entries (§B5 —
 * old sessions must not open empty). Tool parts are grouped into the
 * assistant turn that follows them (attached as `toolStates`); tool parts
 * with no following text in the same OpenCode message are emitted as a
 * single `FlattenedToolGroup` (never as N separate entries). Empty-text
 * messages with no tool activity are dropped. Ported from
 * packages/ui/src/lib/chat/session-messages.ts flattenSessionMessages().
 */
export function flattenSessionMessages(rows: SessionMessageRow[]): FlattenedEntry[] {
  const entries: FlattenedEntry[] = [];
  for (const row of rows) {
    const timestamp = row.info.time?.created ?? Date.now();
    let textBuffer = '';
    let textIndex = 0;
    const pendingToolStates: ToolStateSnapshot[] = [];

    const flushText = (): void => {
      const text = textBuffer.trim();
      textBuffer = '';
      if (!text && pendingToolStates.length === 0) return;

      if (text) {
        const entry: FlattenedMessage = {
          id: textIndex === 0 ? row.info.id : `${row.info.id}:text:${textIndex}`,
          role: row.info.role,
          text,
          timestamp,
        };
        if (pendingToolStates.length > 0) {
          entry.toolStates = [...pendingToolStates];
          pendingToolStates.length = 0;
        }
        entries.push(entry);
        textIndex += 1;
      } else if (pendingToolStates.length > 0) {
        const group: FlattenedToolGroup = {
          id: `${row.info.id}:tools:${textIndex}`,
          type: 'tool-group',
          toolStates: [...pendingToolStates],
          timestamp,
        };
        pendingToolStates.length = 0;
        entries.push(group);
        textIndex += 1;
      }
    };

    row.parts.forEach((part, index) => {
      if (part.type === 'text' && part.text) {
        textBuffer += part.text;
        return;
      }
      if (part.type === 'tool' || part.state) {
        const toolState = toolStateFromPart(part, `${row.info.id}:${index}`);
        if (!toolState) return;
        pendingToolStates.push(toolState);
      }
    });

    flushText();
  }
  return entries;
}
