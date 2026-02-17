import { createHmac } from "node:crypto";

const PORT = Number(Bun.env.PORT ?? 8182);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_TELEGRAM_SECRET ?? "";
const TELEGRAM_WEBHOOK_SECRET = Bun.env.TELEGRAM_WEBHOOK_SECRET ?? "";

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: { "content-type": "application/json" } });
}

function signPayload(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true });
    if (url.pathname !== "/telegram/webhook" || req.method !== "POST") return json(404, { error: "not_found" });

    if (TELEGRAM_WEBHOOK_SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== TELEGRAM_WEBHOOK_SECRET) {
      return json(401, { error: "invalid_telegram_secret" });
    }

    const update = await req.json() as {
      message?: { text?: string; from?: { id?: number; username?: string }; chat?: { id?: number } };
    };
    const text = update.message?.text;
    if (!text) return json(200, { ok: true, skipped: "non-text message" });

    const user = update.message?.from;
    const userId = user?.id ? `telegram:${user.id}` : `telegram:${user?.username ?? "unknown"}`;
    const payload = {
      userId,
      channel: "telegram",
      text,
      metadata: {
        chatId: update.message?.chat?.id,
        username: user?.username
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
});

console.log(`telegram channel listening on ${PORT}`);
