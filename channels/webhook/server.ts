import { createHttpAdapterFetch } from "@openpalm/lib/shared/channel-adapter-http-server.ts";
import { createSimpleTextAdapter } from "@openpalm/lib/shared/channel-simple-text.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";
import { installGracefulShutdown } from "@openpalm/lib/shared/shutdown.ts";

const log = createLogger("channel-webhook");

const PORT = Number(Bun.env.PORT ?? 8185);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_WEBHOOK_SECRET ?? "";
const INBOUND_TOKEN = Bun.env.WEBHOOK_INBOUND_TOKEN ?? "";

export function createWebhookFetch(gatewayUrl: string, sharedSecret: string, inboundToken: string, forwardFetch: typeof fetch = fetch) {
  const adapter = createSimpleTextAdapter({
    channel: "webhook",
    routePath: "/webhook",
    serviceName: "channel-webhook",
    userIdFallback: "webhook-user",
    inboundTokenHeader: "x-webhook-token",
    inboundToken,
  });

  return createHttpAdapterFetch(adapter, gatewayUrl, sharedSecret, forwardFetch);
}

if (import.meta.main) {
  if (!SHARED_SECRET) {
    log.error("CHANNEL_WEBHOOK_SECRET is not set, exiting");
    process.exit(1);
  }
  const server = Bun.serve({ port: PORT, fetch: createWebhookFetch(GATEWAY_URL, SHARED_SECRET, INBOUND_TOKEN) });
  installGracefulShutdown(server, { service: "channel-webhook", logger: log });
  log.info("started", { port: PORT });
}
