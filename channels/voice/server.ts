import { createHmac } from "node:crypto";

const PORT = Number(Bun.env.PORT ?? 8183);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_VOICE_SECRET ?? "";

function signPayload(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: { "content-type": "application/json" } });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-voice" });

    // Voice transcription inbound (from STT pipeline)
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
      const sig = signPayload(SHARED_SECRET, serialized);

      const resp = await fetch(`${GATEWAY_URL}/channel/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-channel-signature": sig },
        body: serialized
      });

      return new Response(await resp.text(), { status: resp.status, headers: { "content-type": "application/json" } });
    }

    // WebSocket upgrade placeholder for real-time voice streaming
    if (url.pathname === "/voice/stream") {
      return json(501, {
        error: "not_implemented",
        message: "Real-time voice streaming requires WebSocket upgrade. Use /voice/transcription for STT-processed text."
      });
    }

    return json(404, { error: "not_found" });
  }
});

console.log(`voice channel listening on ${PORT}`);
