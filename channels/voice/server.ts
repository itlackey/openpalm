import { forwardNormalizedChannelMessage, readJsonObject, rejectPayloadTooLarge } from "@openpalm/lib/shared/channel-http.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";
import { installGracefulShutdown } from "@openpalm/lib/shared/shutdown.ts";

const log = createLogger("channel-voice");

const PORT = Number(Bun.env.PORT ?? 8183);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_VOICE_SECRET ?? "";

export function createVoiceFetch(gatewayUrl: string, sharedSecret: string, forwardFetch: typeof fetch = fetch) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-voice" });

    if (url.pathname === "/voice/transcription" && req.method === "POST") {
      const tooLarge = rejectPayloadTooLarge(req);
      if (tooLarge) return tooLarge;

      const body = await readJsonObject<Record<string, unknown>>(req);
      if (!body) return json(400, { error: "invalid_json" });

      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return json(400, { error: "text_required" });

      const metadata = typeof body.metadata === "object" && body.metadata !== null && !Array.isArray(body.metadata)
        ? { ...(body.metadata as Record<string, unknown>) }
        : {};
      metadata.audioRef = body.audioRef;
      metadata.language = typeof body.language === "string" && body.language.trim() ? body.language : "en";

      return forwardNormalizedChannelMessage({
        gatewayUrl,
        sharedSecret,
        channel: "voice",
        userId: typeof body.userId === "string" && body.userId.trim() ? body.userId : "voice-user",
        text,
        metadata,
      }, forwardFetch);
    }

    if (url.pathname === "/voice/stream") {
      return json(501, {
        error: "not_implemented",
        message: "Real-time voice streaming requires WebSocket upgrade. Use /voice/transcription for STT-processed text."
      });
    }

    return json(404, { error: "not_found" });
  };
}

if (import.meta.main) {
  if (!SHARED_SECRET) {
    log.error("CHANNEL_VOICE_SECRET is not set, exiting");
    process.exit(1);
  }
  const server = Bun.serve({ port: PORT, fetch: createVoiceFetch(GATEWAY_URL, SHARED_SECRET) });
  installGracefulShutdown(server, { service: "channel-voice", logger: log });
  log.info("started", { port: PORT });
}
