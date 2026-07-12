import type { Event } from '@opencode-ai/sdk';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { SessionReuseMap } from './session-map.ts';

const DEFAULT_OPENCODE_BASE_URL = 'http://guardian:8080/oc';
const H_USER = 'x-openpalm-user';
const H_SESSION_KEY = 'x-openpalm-session-key';
const DEFAULT_SESSION_TTL_MS = 900_000;
const SESSION_MAP_MAX_SIZE = 1000;

export interface OcClientOptions {
  principalId: string;
  secret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * Session-reuse mode (D2, #491). `'server'` (default) is the guardian-mode
   * regression pin: the client-side map is never constructed or consulted, so
   * the guardian's own server-side reuse cache stays sole authority.
   * `'client'` is for standalone use against a plain OpenCode server (which
   * ignores the `x-openpalm-session-key` hint header) — falls back to
   * `Bun.env.PORTAL_SESSION_REUSE` when not passed explicitly; any value other
   * than `'client'` resolves to the fail-safe `'server'` default.
   */
  sessionReuse?: 'client' | 'server';
  /** Client-mode session-map TTL in ms. Falls back to `Bun.env.PORTAL_SESSION_TTL_MS`, default 900000 (15 min). */
  sessionTtlMs?: number;
}

export interface OcSession {
  id: string;
  title?: string;
}

export class OcClient {
  private readonly principalId: string;
  private readonly secret: string;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly client: ReturnType<typeof createOpencodeClient>;
  private readonly sessionReuse: 'client' | 'server';
  private readonly sessionMap: SessionReuseMap | null;

  constructor(opts: OcClientOptions) {
    this.principalId = opts.principalId;
    this.secret = opts.secret;
    this.base = opts.baseUrl ?? Bun.env.OPENCODE_BASE_URL ?? DEFAULT_OPENCODE_BASE_URL;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.client = createOpencodeClient({ baseUrl: this.base, fetch: this.fetchFn });
    this.sessionReuse = opts.sessionReuse ?? (Bun.env.PORTAL_SESSION_REUSE === 'client' ? 'client' : 'server');
    const configuredTtlMs = opts.sessionTtlMs ?? Number(Bun.env.PORTAL_SESSION_TTL_MS);
    const sessionTtlMs = configuredTtlMs > 0 ? configuredTtlMs : DEFAULT_SESSION_TTL_MS;
    this.sessionMap = this.sessionReuse === 'client' ? new SessionReuseMap({ ttlMs: sessionTtlMs, maxSize: SESSION_MAP_MAX_SIZE }) : null;
  }

  private headers(userId: string, extra?: Record<string, string>): Record<string, string> {
    const credentials = Buffer.from(`${this.principalId}:${this.secret}`, 'utf-8').toString('base64');
    return {
      [H_USER]: userId,
      authorization: `Basic ${credentials}`,
      ...(extra ?? {}),
    };
  }

  async createSession(userId: string, sessionKey?: string): Promise<OcSession> {
    // Client-side reuse (D2): only consulted in 'client' mode. The reuse key
    // binds the full (userId, sessionKey) identity, mirroring the guardian's
    // own identity-bound cacheKey (session-target.ts:44), so distinct users
    // sharing a sessionKey never collide.
    const reuseKey = this.sessionMap ? JSON.stringify([userId, sessionKey ?? userId]) : null;
    if (reuseKey) {
      const cached = this.sessionMap?.get(reuseKey);
      if (cached) return { id: cached };
    }

    // The @opencode-ai/sdk client resolves to a { data, error } envelope
    // (ThrowOnError defaults to false). The session lives in `.data` — reading
    // the envelope directly yields an undefined id, which then renders the
    // prompt path as the literal `/session/{id}/message`, and the guardian
    // denies it with no_route. Always pull the session out of `.data`.
    const { data, error } = await this.client.session.create({
      body: {},
      headers: this.headers(userId, sessionKey ? { [H_SESSION_KEY]: sessionKey } : undefined),
    });
    if (error || !data?.id) {
      throw new Error(`createSession failed: ${error ? JSON.stringify(error) : 'no session id in response'}`);
    }
    if (reuseKey) this.sessionMap?.set(reuseKey, data.id);
    return data as OcSession;
  }

  async prompt(userId: string, sessionId: string, text: string): Promise<void> {
    // ThrowOnError is false, so a denied/failed prompt surfaces as `.error`
    // rather than a throw — check it so failures aren't silently swallowed.
    const { error } = await this.client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text }] },
      headers: this.headers(userId),
    });
    if (error) {
      // Client-mode self-heal: a dead standalone session (e.g. the upstream
      // server restarted) evicts from the cache so the next createSession
      // re-creates rather than the caller re-prompting a dead session id
      // forever. No retry here — a retry could double-send the prompt.
      this.sessionMap?.evictBySessionId(sessionId);
      throw new Error(`prompt failed: ${JSON.stringify(error)}`);
    }
  }

  async replyPermission(userId: string, requestID: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<boolean> {
    const body: Record<string, unknown> = { reply };
    if (message) body.message = message;
    const response = await this.fetchFn(`${this.base}/permission/${requestID}/reply`, {
      method: 'POST',
      headers: {
        ...this.headers(userId),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`replyPermission failed: ${response.status}`);
    return true;
  }

  async replyQuestion(userId: string, requestID: string, answers: string[][]): Promise<boolean> {
    const response = await this.fetchFn(`${this.base}/question/${requestID}/reply`, {
      method: 'POST',
      headers: {
        ...this.headers(userId),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ answers }),
    });
    if (!response.ok) throw new Error(`replyQuestion failed: ${response.status}`);
    return true;
  }

  async rejectQuestion(userId: string, requestID: string): Promise<void> {
    const response = await this.fetchFn(`${this.base}/question/${requestID}/reject`, {
      method: 'POST',
      headers: {
        ...this.headers(userId),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    if (!response.ok) throw new Error(`rejectQuestion failed: ${response.status}`);
  }

  async abort(userId: string, sessionId: string): Promise<void> {
    await this.client.session.abort({
      path: { id: sessionId },
      headers: this.headers(userId),
    });
  }

  async *events(userId: string, signal: AbortSignal): AsyncGenerator<Event> {
    const subscription = await this.client.event.subscribe({
      headers: {
        ...this.headers(userId),
        accept: 'text/event-stream',
      },
      signal,
    });
    for await (const event of subscription.stream as AsyncIterable<Event>) {
      yield event;
    }
  }
}
