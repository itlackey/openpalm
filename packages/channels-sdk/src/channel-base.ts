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

import type { ChannelPayload } from "./channel.ts";
import { buildChannelMessage, forwardChannelMessage } from "./channel-sdk.ts";
import { createLogger } from "./logger.ts";

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

  /** Guardian URL. Defaults to env GUARDIAN_URL. */
  guardianUrl: string = Bun.env.GUARDIAN_URL ?? "http://guardian:8080";

  /**
   * HMAC shared secret. Auto-resolved from CHANNEL_<NAME>_SECRET env var.
   * Can be overridden for testing.
   */
  get secret(): string {
    const envKey = `CHANNEL_${this.name.toUpperCase().replace(/-/g, "_")}_SECRET`;
    return Bun.env[envKey] ?? "";
  }

  /**
   * Parse an incoming request into channel message fields.
   * Return null to skip forwarding (e.g., webhook verification handshakes).
   *
   * This is the only method community developers MUST implement.
   */
  abstract handleRequest(req: Request): Promise<HandleResult | null>;

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
    const payload: ChannelPayload = buildChannelMessage({
      userId: result.userId,
      channel: this.name,
      text: result.text,
      metadata: result.metadata,
    });

    return forwardChannelMessage(
      this.guardianUrl,
      this.secret,
      payload,
      fn,
      timeoutMs,
    );
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

  /**
   * Forward a message to the guardian with channel-prefixed userId.
   * Throws on non-OK response. Returns the assistant's answer text.
   *
   * @param userId - Raw user ID (will be prefixed with "{channel}:")
   * @param text - Message text to forward
   * @param metadata - Additional metadata for the request
   * @param timeoutMs - Optional request timeout in milliseconds
   */
  protected async forwardToGuardian(
    userId: string,
    text: string,
    metadata: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<string> {
    const resp = await this.forward(
      { userId: `${this.name}:${userId}`, text, metadata },
      undefined,
      timeoutMs,
    );

    if (!resp.ok) {
      throw new Error(`Guardian returned status ${resp.status}`);
    }

    const result = (await resp.json()) as { answer?: string };
    return result.answer ?? "No response received.";
  }

  /** Start the Bun HTTP server. Called by the entrypoint loader. */
  start(): void {
    if (!this.secret) {
      this.log("error", `CHANNEL_${this.name.toUpperCase().replace(/-/g, "_")}_SECRET is not set, exiting`);
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
