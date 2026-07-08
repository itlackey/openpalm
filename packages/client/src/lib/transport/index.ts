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
 *     'openpalm', mirroring the host app's probeEndpoint() so guardian
 *     credentials minted by the host stack work without a username field,
 *     #435), Bearer, or none.
 *
 * Everything here is pure TS with an injectable fetch — unit-tested in
 * packages/client/tests/transport-*.test.ts (the pinned contract).
 */

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
  state: 'accessible' | 'unauthorized' | 'unreachable';
  detail?: string;
};

export type TransportOptions = {
  baseUrl: string;
  /** Default: { mode: 'none' }. */
  auth?: ConnectionAuth;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export type Transport = {
  listSessions(): Promise<SessionSummary[]>;
  createSession(): Promise<{ id: string }>;
  sendMessage(sessionId: string, text: string): Promise<unknown>;
  probeHealth(): Promise<HealthProbeResult>;
};

/** One parsed SSE frame ('\n\n'-delimited; multi-line data joined with '\n'). */
export type SseFrame = { event?: string; data?: string; id?: string };

/** OpenCode responses can take 30–120s (same budget as the host app). */
const MESSAGE_TIMEOUT_MS = 150_000;
const PROBE_TIMEOUT_MS = 5_000;

function authorizationHeader(auth: ConnectionAuth): string | null {
  if (auth.mode === 'basic') {
    const username = auth.username ?? 'openpalm';
    return `Basic ${btoa(`${username}:${auth.password}`)}`;
  }
  if (auth.mode === 'bearer') return `Bearer ${auth.token}`;
  return null;
}

export function createTransport(options: TransportOptions): Transport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const auth = options.auth ?? { mode: 'none' };
  // Trailing-slash and path-prefix safe: '/opencode/' + '/session' must
  // become '/opencode/session' (reverse-proxied instances keep their prefix).
  const base = options.baseUrl.replace(/\/+$/, '');

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
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
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
        } catch {
          continue;
        }
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

    /** POST the OpenCode parts envelope; resolves with the raw response body. */
    async sendMessage(sessionId: string, text: string): Promise<unknown> {
      const res = await request(
        'POST',
        `/session/${encodeURIComponent(sessionId)}/message`,
        { parts: [{ type: 'text', text }] },
        AbortSignal.timeout(MESSAGE_TIMEOUT_MS)
      );
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
      if (contentType.startsWith('text/event-stream')) {
        return parseSseMessage(res);
      }
      return (await res.json()) as unknown;
    },

    /**
     * GET the connection base URL and map the outcome onto the host app's
     * RemoteStatus vocabulary (packages/ui probeEndpoint()). Never throws —
     * connection health is data, not an exception path.
     */
    async probeHealth(): Promise<HealthProbeResult> {
      try {
        const response = await fetchImpl(`${base}/`, {
          method: 'GET',
          headers: buildHeaders(),
          credentials: 'omit',
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
        return {
          state: 'unreachable',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
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
