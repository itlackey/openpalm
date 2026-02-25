import { forwardNormalizedChannelMessage, readJsonObject, rejectPayloadTooLarge } from "@openpalm/lib/shared/channel-http.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";
import { installGracefulShutdown } from "@openpalm/lib/shared/shutdown.ts";

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

    const tooLarge = rejectPayloadTooLarge(req);
    if (tooLarge) return tooLarge;

    const update = await readJsonObject<Record<string, unknown>>(req);
    if (!update) return json(400, { error: "invalid_json" });

    const message = typeof update.message === "object" && update.message !== null && !Array.isArray(update.message)
      ? update.message as Record<string, unknown>
      : undefined;
    const user = typeof message?.from === "object" && message.from !== null && !Array.isArray(message.from)
      ? message.from as Record<string, unknown>
      : undefined;
    const chat = typeof message?.chat === "object" && message.chat !== null && !Array.isArray(message.chat)
      ? message.chat as Record<string, unknown>
      : undefined;

    const text = typeof message?.text === "string" ? message.text.trim() : "";
    if (!text) return json(200, { ok: true, skipped: "non-text message" });

    const userId = typeof user?.id === "number"
      ? `telegram:${user.id}`
      : `telegram:${typeof user?.username === "string" && user.username ? user.username : "unknown"}`;

    return forwardNormalizedChannelMessage({
      gatewayUrl,
      sharedSecret,
      channel: "telegram",
      userId,
      text,
      metadata: {
        chatId: chat?.id,
        username: user?.username,
      },
    }, forwardFetch);
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
  const server = Bun.serve({ port: PORT, fetch: createTelegramFetch(GATEWAY_URL, SHARED_SECRET, TELEGRAM_WEBHOOK_SECRET) });
  installGracefulShutdown(server, { service: "channel-telegram", logger: log });
  log.info("started", { port: PORT });
}
