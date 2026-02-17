import { createHmac } from "node:crypto";

const PORT = Number(Bun.env.PORT ?? 8181);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_CHAT_SECRET ?? "";
const INBOUND_TOKEN = Bun.env.CHAT_INBOUND_TOKEN ?? "";

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
    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-chat" });
    if (url.pathname !== "/chat" || req.method !== "POST") return json(404, { error: "not_found" });
    if (INBOUND_TOKEN && req.headers.get("x-chat-token") !== INBOUND_TOKEN) return json(401, { error: "unauthorized" });

    const body = await req.json() as { userId?: string; text?: string; metadata?: Record<string, unknown> };
    if (!body.text) return json(400, { error: "text_required" });

    const payload = {
      userId: body.userId ?? "chat-user",
      channel: "chat",
      text: body.text,
      metadata: body.metadata ?? {},
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
});

console.log(`chat channel listening on ${PORT}`);
