/**
 * OpenPalm BaseChannel — Abstract base class for community channel adapters.
 *
 * Extend this class and implement `handleRequest` to create a new channel.
 * The base class handles server startup, health checks, HMAC signing,
 * guardian forwarding, structured logging, and error handling.
 *
 * Example:
 *   export default class SlackChannel extends BaseChannel {
 *     name = "slack";
 *     async handleRequest(req: Request) {
 *       const body = await req.json();
 *       return { userId: body.user, text: body.text };
 *     }
 *   }
 */

import { createLogger } from "./logger.ts";
import { readRequiredSecretFile, SecretFileError } from "./secret-file.ts";
import { OcClient } from './oc-client.ts';
import { asRaw, extractTextDelta, isTurnEnd, partSnapshotType } from './oc-events.ts';

// ── Types ────────────────────────────────────────────────────────────────

/** Result returned by handleRequest to be forwarded to the guardian. */
export type HandleResult = {
  userId: string;
  text: string;
  metadata?: Record<string, unknown>;
};

// ── Base Class ───────────────────────────────────────────────────────────

export abstract class BaseChannel {
  /** Channel name used in payloads (e.g., "slack", "telegram"). */
  abstract name: string;

  /** Port to listen on. Defaults to env PORT or 8080. */
  port: number = Number(Bun.env.PORT) || 8080;

  /**
   * Guardian URL. Hardcoded to the in-network service name — channels always
   * run in the same compose project as guardian, so Docker DNS resolves this
   * deterministically. No env override (we tried; the override only ever
   * caused stale-config bugs).
   */
  guardianUrl: string = "http://guardian:8080";

  /**
   * HMAC shared secret. Auto-resolved from CHANNEL_SECRET_FILE.
   * Can be overridden for testing.
   */
  get secret(): string {
    const key = Bun.env.PRINCIPAL_SECRET_FILE ? 'PRINCIPAL_SECRET_FILE' : 'CHANNEL_SECRET_FILE';
    return readRequiredSecretFile(key);
  }

  /**
   * Parse an incoming request into channel message fields.
   * Return null to skip forwarding (e.g., webhook verification handshakes).
   *
   * Optional — channels that handle everything inside `route()` can omit
   * this method. The default implementation returns null (no-op). Channels
   * that rely on the default POST handler MUST override this method.
   */
  async handleRequest(_req: Request): Promise<HandleResult | null> {
    return null;
  }

  /**
   * Optional: handle custom routes (e.g., webhook verification, OAuth callbacks).
   * Return a Response to short-circuit, or null to fall through to the default handler.
   */
  route?(req: Request, url: URL): Promise<Response | null>;

  // ── Internal helpers ─────────────────────────────────────────────────

  /**
   * Active fetch function. Set by createFetch() so that route() implementations
   * can call this.forward() and get the mock fetch in tests.
   */
  private _fetchFn: typeof fetch = fetch;

  /** Lazily initialized structured logger using createLogger from @openpalm/channels-sdk. */
  private _logger?: ReturnType<typeof createLogger>;
  private get logger() {
    return (this._logger ??= createLogger(`channel-${this.name}`));
  }

  protected log(level: "info" | "error" | "warn", msg: string, extra?: Record<string, unknown>): void {
    this.logger[level](msg, extra);
  }

  protected json(status: number, data: unknown): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * Build, sign, and forward a message to the guardian.
   * Exposed as protected so subclasses can override if needed.
   *
   * @param timeoutMs - Optional request timeout in milliseconds.
   *   Defaults to 0 (no timeout). When set, should be at least 12 hours
   *   to avoid cutting off long-running assistant tasks.
   */
  protected async forward(
    result: HandleResult,
    fetchFn?: typeof fetch,
    timeoutMs?: number,
  ): Promise<Response> {
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
      return this.json(200, { userId: result.userId, sessionId: session.id, answer });
    } finally {
      if (timer) clearTimeout(timer);
      controller?.abort();
    }
  }

  /**
   * Create the Bun.serve fetch handler. Exported for testing —
   * tests can call `createFetch()` without starting a real server.
   */
  createFetch(fetchFn: typeof fetch = fetch): (req: Request) => Promise<Response> {
    this._fetchFn = fetchFn;
    return async (req: Request): Promise<Response> => {
      const url = new URL(req.url);

      // Health endpoint
      if (url.pathname === "/health") {
        return this.json(200, { ok: true, service: `channel-${this.name}` });
      }

      // Custom routes (optional)
      if (this.route) {
        const custom = await this.route(req, url);
        if (custom) return custom;
      }

      // Only accept POST for message handling
      if (req.method !== "POST") {
        return this.json(404, { error: "not_found" });
      }

      // Parse and forward
      let result: HandleResult | null;
      try {
        result = await this.handleRequest(req);
      } catch (err) {
        this.logger.error("Request handling error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return this.json(400, { error: "invalid_request" });
      }

      // null = skip forwarding (e.g., webhook verification)
      if (result === null) {
        return this.json(200, { ok: true, skipped: true });
      }

      if (typeof result.text !== "string" || !result.text.trim()) {
        return this.json(400, { error: "text_required" });
      }
      if (typeof result.userId !== "string" || !result.userId.trim()) {
        return this.json(400, { error: "missing_user_id" });
      }

      let guardianResp: Response;
      try {
        guardianResp = await this.forward(result, fetchFn);
      } catch (err) {
        this.logger.error("Guardian communication error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return this.json(502, { error: "guardian_error" });
      }

      if (!guardianResp.ok) {
        return this.json(
          guardianResp.status >= 500 ? 502 : guardianResp.status,
          { error: `guardian_error_${guardianResp.status}` },
        );
      }

      const data = await guardianResp.json() as unknown;
      return this.json(200, data);
    };
  }

  /** Start the Bun HTTP server. Called by the entrypoint loader. */
  start(): void {
    try {
      this.secret;
    } catch (err) {
      this.log("error", "startup_error", {
        reason: err instanceof SecretFileError ? err.message : "CHANNEL_SECRET_FILE could not be read",
      });
      process.exit(1);
    }

    try {
      Bun.serve({ port: this.port, fetch: this.createFetch() });
      this.log("info", "started", { port: this.port });
    } catch (err) {
      this.log("error", "failed to start server", {
        port: this.port,
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  }
}

async function collectTurnAnswer(client: OcClient, userId: string, sessionId: string, signal: AbortSignal): Promise<string> {
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
