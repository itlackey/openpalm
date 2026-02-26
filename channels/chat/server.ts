import { createHttpAdapterFetch } from "@openpalm/lib/shared/channel-adapter-http-server.ts";
import { createSimpleTextAdapter } from "@openpalm/lib/shared/channel-simple-text.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";
import { installGracefulShutdown } from "@openpalm/lib/shared/shutdown.ts";

const log = createLogger("channel-chat");

const PORT = Number(Bun.env.PORT ?? 8181);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_CHAT_SECRET ?? "";
const INBOUND_TOKEN = Bun.env.CHAT_INBOUND_TOKEN ?? "";

export function createChatFetch(gatewayUrl: string, sharedSecret: string, inboundToken: string, forwardFetch: typeof fetch = fetch) {
  const adapter = createSimpleTextAdapter({
    channel: "chat",
    routePath: "/chat",
    serviceName: "channel-chat",
    userIdFallback: "chat-user",
    inboundTokenHeader: "x-chat-token",
    inboundToken,
  });

  return createHttpAdapterFetch(adapter, gatewayUrl, sharedSecret, forwardFetch);
}

if (import.meta.main) {
  if (!SHARED_SECRET) {
    log.error("CHANNEL_CHAT_SECRET is not set, exiting");
    process.exit(1);
  }
  const server = Bun.serve({ port: PORT, fetch: createChatFetch(GATEWAY_URL, SHARED_SECRET, INBOUND_TOKEN) });
  installGracefulShutdown(server, { service: "channel-chat", logger: log });
  log.info("started", { port: PORT });
}
