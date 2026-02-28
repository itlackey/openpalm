/**
 * OpenPalm Channel Discord — Webhook endpoint.
 *
 * Handles incoming webhook requests and forwards them as signed channel
 * messages to the guardian.
 *
 * Endpoints:
 *   POST /discord/webhook
 *   GET  /health
 */

import { buildChannelMessage, forwardChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const logger = createLogger("channel-discord");

const PORT = Number(Bun.env.PORT ?? 8184);
const GUARDIAN_URL = Bun.env.GUARDIAN_URL ?? "http://guardian:8080";
const SHARED_SECRET = Bun.env.CHANNEL_DISCORD_SECRET ?? "";

// ── Helpers ──────────────────────────────────────────────────────────────

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

// ── Fetch handler (exported for testing) ─────────────────────────────────

export function createDiscordFetch(
  gatewayUrl: string,
  sharedSecret: string,
  forwardFetch: typeof fetch = fetch,
) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-discord" });

    if (url.pathname !== "/discord/webhook" || req.method !== "POST") {
      return json(404, { error: "not_found" });
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json(400, { error: "invalid_json" }); }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json(400, { error: "text_required" });

    const rawUserId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!rawUserId) return json(400, { error: "missing_user_id" });

    const payload = buildChannelMessage({
      userId: `discord:${rawUserId}`,
      channel: "discord",
      text,
      metadata: {
        channelId: body.channelId,
        guildId: body.guildId,
        username: body.username,
      },
    });

    let guardianResp: Response;
    try {
      guardianResp = await forwardChannelMessage(gatewayUrl, sharedSecret, payload, forwardFetch);
    } catch (err) {
      return json(502, { error: `guardian_error: ${err}` });
    }

    if (!guardianResp.ok) {
      return json(guardianResp.status >= 500 ? 502 : guardianResp.status, { error: `guardian_error_${guardianResp.status}` });
    }

    const data = await guardianResp.json() as unknown;
    return json(200, data);
  };
}

// ── Startup ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  if (!SHARED_SECRET) {
    logger.error("CHANNEL_DISCORD_SECRET is not set, exiting");
    process.exit(1);
  }
  Bun.serve({ port: PORT, fetch: createDiscordFetch(GUARDIAN_URL, SHARED_SECRET) });
  logger.info("started", { port: PORT });
}
