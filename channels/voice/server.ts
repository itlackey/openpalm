import { signPayload } from "@openpalm/lib/shared/crypto.ts";
import { json } from "@openpalm/lib/shared/http.ts";

export { signPayload };

const PORT = Number(Bun.env.PORT ?? 8183);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_VOICE_SECRET ?? "";

export function createVoiceFetch(gatewayUrl: string, sharedSecret: string, forwardFetch: typeof fetch = fetch) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-voice" });

    if (url.pathname === "/voice/transcription" && req.method === "POST") {
      const body = await req.json() as {
        userId?: string;
        text?: string;
        audioRef?: string;
        language?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body.text) return json(400, { error: "text_required" });

      const payload = {
        userId: body.userId ?? "voice-user",
        channel: "voice",
        text: body.text,
        metadata: {
          ...body.metadata,
          audioRef: body.audioRef,
          language: body.language ?? "en"
        },
        nonce: crypto.randomUUID(),
        timestamp: Date.now()
      };
      const serialized = JSON.stringify(payload);
      const sig = signPayload(sharedSecret, serialized);

      const resp = await forwardFetch(`${gatewayUrl}/channel/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-channel-signature": sig },
        body: serialized
      });

      return new Response(await resp.text(), { status: resp.status, headers: { "content-type": "application/json" } });
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
  Bun.serve({ port: PORT, fetch: createVoiceFetch(GATEWAY_URL, SHARED_SECRET) });
  console.log(`voice channel listening on ${PORT}`);
}
