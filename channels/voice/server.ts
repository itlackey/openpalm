import { createHttpAdapterFetch } from "@openpalm/lib/shared/channel-adapter-http-server.ts";
import type { ChannelAdapter } from "@openpalm/lib/shared/channel.ts";
import { readJsonObject, rejectPayloadTooLarge } from "@openpalm/lib/shared/channel-http.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";
import { sanitizeMetadataObject } from "@openpalm/lib/shared/metadata.ts";
import { installGracefulShutdown } from "@openpalm/lib/shared/shutdown.ts";

const log = createLogger("channel-voice");

const PORT = Number(Bun.env.PORT ?? 8183);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_VOICE_SECRET ?? "";
const INBOUND_TOKEN = Bun.env.VOICE_INBOUND_TOKEN ?? "";

export function createVoiceFetch(
  gatewayUrl: string,
  sharedSecret: string,
  inboundToken: string,
  forwardFetch: typeof fetch = fetch,
) {
  const transcriptionHandler: ChannelAdapter["routes"][number]["handler"] = async (req: Request) => {
    if (inboundToken && req.headers.get("x-voice-token") !== inboundToken) {
      return { ok: false, status: 401, body: { error: "unauthorized" } };
    }
    const tooLarge = rejectPayloadTooLarge(req);
    if (tooLarge) return { ok: false, status: 413, body: { error: "payload_too_large" } };

    const body = await readJsonObject<Record<string, unknown>>(req);
    if (!body) return { ok: false, status: 400, body: { error: "invalid_json" } };

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return { ok: false, status: 400, body: { error: "text_required" } };

    const metadata = sanitizeMetadataObject(body.metadata) ?? {};
    metadata.audioRef = body.audioRef;
    metadata.language = typeof body.language === "string" && body.language.trim() ? body.language : "en";

    return {
      ok: true,
      payload: {
        userId: typeof body.userId === "string" && body.userId.trim() ? body.userId : "voice-user",
        channel: "voice",
        text,
        metadata,
      },
    };
  };

  const adapter: ChannelAdapter = {
    name: "voice",
    routes: [
      { method: "POST", path: "/voice/transcription", handler: transcriptionHandler },
      {
        method: "GET",
        path: "/voice/stream",
        handler: async () => ({
          ok: false,
          status: 501,
          body: {
            error: "not_implemented",
            message: "Real-time voice streaming requires WebSocket upgrade. Use /voice/transcription for STT-processed text.",
          },
        }),
      },
    ],
    health: () => ({ ok: true, service: "channel-voice" }),
  };

  return createHttpAdapterFetch(adapter, gatewayUrl, sharedSecret, forwardFetch);
}

if (import.meta.main) {
  if (!SHARED_SECRET) {
    log.error("CHANNEL_VOICE_SECRET is not set, exiting");
    process.exit(1);
  }
  const server = Bun.serve({ port: PORT, fetch: createVoiceFetch(GATEWAY_URL, SHARED_SECRET, INBOUND_TOKEN) });
  installGracefulShutdown(server, { service: "channel-voice", logger: log });
  log.info("started", { port: PORT });
}
