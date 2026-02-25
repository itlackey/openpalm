import { buildChannelMessage, forwardChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

export { signPayload };

const log = createLogger("channel-telegram");

const PORT = Number(Bun.env.PORT ?? 8182);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_TELEGRAM_SECRET ?? "";
const TELEGRAM_WEBHOOK_SECRET = Bun.env.TELEGRAM_WEBHOOK_SECRET ?? "";

export function createTelegramFetch(gatewayUrl: string, sharedSecret: string, webhookSecret: string, forwardFetch: typeof fetch = fetch) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-telegram" });
    if (url.pathname !== "/telegram/webhook" || req.method !== "POST") return json(404, { error: "not_found" });

    if (webhookSecret && req.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret) {
      return json(401, { error: "invalid_telegram_secret" });
    }

    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (contentLength > 1_048_576) {
      return new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413 });
    }

    let update: {
      message?: { text?: string; from?: { id?: number; username?: string }; chat?: { id?: number } };
    };
    try {
      update = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
    }

    const text = update.message?.text;
    if (!text) return json(200, { ok: true, skipped: "non-text message" });

    const user = update.message?.from;
    const userId = user?.id ? `telegram:${user.id}` : `telegram:${user?.username ?? "unknown"}`;
    const payload = buildChannelMessage({
      userId,
      channel: "telegram",
      text,
      metadata: {
        chatId: update.message?.chat?.id,
        username: user?.username
      }
    });

    const resp = await forwardChannelMessage(gatewayUrl, sharedSecret, payload, forwardFetch);

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: "gateway_error", status: resp.status }), {
        status: resp.status >= 500 ? 502 : resp.status,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(await resp.text(), { status: resp.status, headers: { "content-type": "application/json" } });
  };
}

if (import.meta.main) {
  if (!SHARED_SECRET) {
    log.error("CHANNEL_TELEGRAM_SECRET is not set, exiting");
    process.exit(1);
  }
  if (!TELEGRAM_WEBHOOK_SECRET) {
    log.warn("TELEGRAM_WEBHOOK_SECRET is not set — webhook verification disabled");
  }
  Bun.serve({ port: PORT, fetch: createTelegramFetch(GATEWAY_URL, SHARED_SECRET, TELEGRAM_WEBHOOK_SECRET) });
  log.info("started", { port: PORT });
}
