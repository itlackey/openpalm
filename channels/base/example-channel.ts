/**
 * Example community channel — minimal webhook adapter.
 *
 * This file demonstrates how to create a new OpenPalm channel using
 * the prebuilt channel-base image. To use it:
 *
 *   1. Write a file like this one that extends BaseChannel
 *   2. Create a Dockerfile:
 *        FROM openpalm/channel-base:latest
 *        COPY my-channel.ts /app/channel.ts
 *   3. Build and run — the base image handles everything else
 *
 * Environment variables (auto-configured by OpenPalm):
 *   PORT                    — HTTP port (default: 8080)
 *   GUARDIAN_URL             — Guardian endpoint (default: http://guardian:8080)
 *   CHANNEL_EXAMPLE_SECRET  — HMAC secret (auto-generated on install)
 */

import { BaseChannel, type HandleResult } from "@openpalm/lib/shared/channel-base.ts";

export default class ExampleChannel extends BaseChannel {
  name = "example";

  async handleRequest(req: Request): Promise<HandleResult | null> {
    const body = await req.json() as Record<string, unknown>;

    const text = typeof body.text === "string" ? body.text.trim() : "";
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";

    if (!userId || !text) return null;

    return { userId, text };
  }
}
