/**
 * BasePortal — the platform-agnostic core shared by every OpenPalm chat portal.
 *
 * A portal (Discord, Slack, …) is a small HTTP service that also connects to a
 * chat platform. Everything that does NOT depend on the chat platform lives here:
 *   - the `/health` HTTP surface (`createFetch`) and its JSON helper;
 *   - the guardian bootstrap (`startServer`: verify the principal secret, then
 *     bind the health server, exiting on failure);
 *   - the buffered (non-streaming) turn: `forward()` creates a guarded OpenCode
 *     session, prompts it, and collects the assistant answer;
 *   - the per-session serialization queue.
 *
 * Each concrete portal supplies only its platform wiring (Bolt vs discord.js),
 * its rendering, and its platform-specific tunables (`name`, `maxMessageLength`,
 * the forward-timeout default). This keeps the two adapters byte-for-byte
 * identical on everything that isn't Discord- or Slack-specific.
 */
import {
  asRaw,
  ConversationQueue,
  type createLogger,
  extractTextDelta,
  isTurnEnd,
  OcClient,
  partSnapshotType,
  readRequiredSecretFile,
  SecretFileError,
} from './runtime.ts';

/** The structured logger shape produced by {@link createLogger}. */
export type PortalLogger = ReturnType<typeof createLogger>;

/** A single forwarded turn: who is asking, what they said, and any metadata
 * (notably `sessionKey`, used by the guardian to group a conversation). */
export type ForwardResult = {
  userId: string;
  text: string;
  metadata?: Record<string, unknown>;
};

/** Build a JSON `Response` with the given status. */
export function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Drive one buffered turn to completion: subscribe to the principal's filtered
 * /event stream and accumulate assistant text deltas (skipping reasoning parts)
 * until the session reaches turn-end. Returns the assembled answer, or a
 * `(no response)` sentinel when the turn produced no text.
 */
export async function collectTurnAnswer(
  client: OcClient,
  userId: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<string> {
  const reasoningPartIds = new Set<string>();
  let answer = '';
  for await (const event of client.events(userId, signal)) {
    const raw = asRaw(event);
    const snapshot = partSnapshotType(raw);
    if (snapshot?.type === 'reasoning') reasoningPartIds.add(snapshot.partID);
    const delta = extractTextDelta(raw, sessionId, reasoningPartIds);
    if (delta) answer += delta;
    if (isTurnEnd(raw, sessionId)) break;
  }
  return answer || '(no response)';
}

export abstract class BasePortal {
  /** Stable channel name, e.g. "discord" or "slack". */
  abstract readonly name: string;
  /** Platform hard message-length cap (Discord 2000, Slack 4000). */
  protected abstract readonly maxMessageLength: number;

  port: number = Number(Bun.env.PORT) || 8080;
  guardianUrl = 'http://guardian:8080';
  protected _fetchFn: typeof fetch = fetch;
  protected conversationQueue = new ConversationQueue();

  /**
   * Threads the bot is actively participating in: key → last-activity ms. The
   * key scheme is platform-specific (Discord: threadId; Slack: "channel:ts"), so
   * each portal builds the key and calls the shared TTL/prune helpers below.
   */
  protected activeThreads = new Map<string, number>();
  /** Thread inactivity TTL in ms (each portal supplies its own env-driven value). */
  protected abstract readonly threadTtlMs: number;

  /** Structured logger scoped to this channel (`channel-<name>`). */
  protected readonly log: PortalLogger;

  protected constructor(log: PortalLogger) {
    this.log = log;
  }

  /** The portal principal secret, read fresh from PRINCIPAL_SECRET_FILE. */
  get secret(): string {
    return readRequiredSecretFile('PRINCIPAL_SECRET_FILE');
  }

  /** Gateway/socket portals take no inbound HTTP beyond `/health`. */
  async handleRequest(_req: Request): Promise<null> {
    return null;
  }

  /** True if the keyed thread has activity within the TTL. Prunes it if expired. */
  protected isThreadKeyActive(key: string): boolean {
    const lastActivity = this.activeThreads.get(key);
    if (lastActivity === undefined) return false;
    if (Date.now() - lastActivity > this.threadTtlMs) {
      this.activeThreads.delete(key);
      return false;
    }
    return true;
  }

  /** Mark a keyed thread active. Prunes stale entries once the map grows large. */
  protected touchThreadKey(key: string): void {
    this.activeThreads.set(key, Date.now());
    if (this.activeThreads.size > 100) {
      const now = Date.now();
      for (const [id, ts] of this.activeThreads) {
        if (now - ts > this.threadTtlMs) this.activeThreads.delete(id);
      }
    }
  }

  /**
   * Forward one turn to the guardian: open a signed OpenCode session, prompt it,
   * and collect the buffered answer. An optional positive `timeoutMs` aborts the
   * whole turn; `0`/undefined means no timeout.
   */
  protected async forward(result: ForwardResult, fetchFn?: typeof fetch, timeoutMs?: number): Promise<Response> {
    const fn = fetchFn ?? this._fetchFn;
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const client = new OcClient({
        principalId: Bun.env.PRINCIPAL_ID ?? this.name,
        secret: this.secret,
        baseUrl: `${this.guardianUrl}/oc`,
        fetch: fn,
      });
      const sessionKey = typeof result.metadata?.sessionKey === 'string' ? result.metadata.sessionKey : result.userId;
      const session = await client.createSession(result.userId, sessionKey);
      const answerPromise = collectTurnAnswer(client, result.userId, session.id, controller?.signal ?? new AbortController().signal);
      await client.prompt(result.userId, session.id, result.text);
      const answer = await answerPromise;
      return json(200, { userId: result.userId, sessionId: session.id, answer });
    } finally {
      if (timer) clearTimeout(timer);
      controller?.abort();
    }
  }

  /** Build the `/health` request handler and record the fetch impl for forwarding. */
  createFetch(fetchFn: typeof fetch = fetch): (req: Request) => Promise<Response> {
    this._fetchFn = fetchFn;
    return async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return json(200, { ok: true, service: `channel-${this.name}` });
      }
      return json(404, { error: 'not_found' });
    };
  }

  /**
   * Verify the principal secret is readable, then bind the health server.
   * Exits the process on failure. Subclasses call this from {@link start} and
   * then connect their platform gateway.
   */
  protected startServer(): void {
    try {
      this.secret;
    } catch (err) {
      this.log.error('startup_error', {
        reason: err instanceof SecretFileError ? err.message : 'PRINCIPAL_SECRET_FILE could not be read',
      });
      process.exit(1);
    }

    try {
      Bun.serve({ port: this.port, fetch: this.createFetch() });
      this.log.info('started', { port: this.port });
    } catch (err) {
      this.log.error('failed to start server', {
        port: this.port,
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  }

  /** Boot the portal: start the health server, then connect the platform. */
  abstract start(): void;
}
