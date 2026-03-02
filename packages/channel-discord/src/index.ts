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

import { BaseChannel, type HandleResult } from "@openpalm/channels-sdk";

export default class DiscordChannel extends BaseChannel {
  name = "discord";

  async route(req: Request, url: URL): Promise<Response | null> {
    // Only accept POST /discord/webhook — reject everything else
    if (url.pathname !== "/discord/webhook" || req.method !== "POST") {
      if (url.pathname === "/health") return null; // fall through to base health handler
      return this.json(404, { error: "not_found" });
    }
    return null; // fall through to handleRequest
  }

  async handleRequest(req: Request): Promise<HandleResult | null> {
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { throw new Error("invalid_json"); }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return { userId: "", text: "" }; // will be caught by base validation

    const rawUserId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!rawUserId) return { userId: "", text }; // will be caught by base validation

    return {
      userId: `discord:${rawUserId}`,
      text,
      metadata: {
        channelId: body.channelId,
        guildId: body.guildId,
        username: body.username,
      },
    };
  }
}
