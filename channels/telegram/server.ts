import { createHttpAdapterFetch } from "@openpalm/lib/shared/channel-adapter-http-server.ts";
import type { ChannelAdapter } from "@openpalm/lib/shared/channel.ts";
import { readJsonObject, rejectPayloadTooLarge } from "@openpalm/lib/shared/channel-http.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";
import { installGracefulShutdown } from "@openpalm/lib/shared/shutdown.ts";

const log = createLogger("channel-telegram");

const PORT = Number(Bun.env.PORT ?? 8182);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_TELEGRAM_SECRET ?? "";
const TELEGRAM_WEBHOOK_SECRET = Bun.env.TELEGRAM_WEBHOOK_SECRET ?? "";

export function createTelegramFetch(gatewayUrl: string, sharedSecret: string, webhookSecret: string, forwardFetch: typeof fetch = fetch) {
  const adapter: ChannelAdapter = {
    name: "telegram",
    routes: [{
      method: "POST",
      path: "/telegram/webhook",
      handler: async (req: Request) => {
        if (webhookSecret && req.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret) {
          return { ok: false, status: 401, body: { error: "invalid_telegram_secret" } };
        }

        const tooLarge = rejectPayloadTooLarge(req);
        if (tooLarge) return { ok: false, status: 413, body: { error: "payload_too_large" } };

        const update = await readJsonObject<Record<string, unknown>>(req);
        if (!update) return { ok: false, status: 400, body: { error: "invalid_json" } };

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
        if (!text) return { ok: false, status: 200, body: { ok: true, skipped: "non-text message" } };

        const userId = typeof user?.id === "number"
          ? `telegram:${user.id}`
          : `telegram:${typeof user?.username === "string" && user.username ? user.username : "unknown"}`;

        return {
          ok: true,
          payload: {
            userId,
            channel: "telegram",
            text,
            metadata: {
              chatId: chat?.id,
              username: user?.username,
            },
          },
        };
      },
    }],
    health: () => ({ ok: true, service: "channel-telegram" }),
  };

  return createHttpAdapterFetch(adapter, gatewayUrl, sharedSecret, forwardFetch);
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
