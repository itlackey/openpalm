/**
 * Example community channel — minimal webhook adapter.
 *
 * This file demonstrates how to create a new OpenPalm channel using
 * the @openpalm/channels-sdk. To use it:
 *
 *   1. Create an npm package with a file like this one
 *   2. Install @openpalm/channels-sdk as a dependency
 *   3. Export a default class that extends BaseChannel
 *   4. Publish to npm
 *   5. Add the package name to your OpenPalm channels list
 *
 * Environment variables (auto-configured by OpenPalm):
 *   PORT                    — HTTP port (default: 8080)
 *   GUARDIAN_URL             — Guardian endpoint (default: http://guardian:8080)
 *   CHANNEL_EXAMPLE_SECRET  — HMAC secret (auto-generated on install)
 */

import { BaseChannel, type HandleResult } from "@openpalm/channels-sdk";

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
