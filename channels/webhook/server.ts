import { forwardNormalizedChannelMessage, readJsonObject, rejectPayloadTooLarge } from "@openpalm/lib/shared/channel-http.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";
import { installGracefulShutdown } from "@openpalm/lib/shared/shutdown.ts";

const log = createLogger("channel-webhook");

const PORT = Number(Bun.env.PORT ?? 8185);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_WEBHOOK_SECRET ?? "";
const INBOUND_TOKEN = Bun.env.WEBHOOK_INBOUND_TOKEN ?? "";

type WebhookRequestBody = Record<string, unknown>;

export function createWebhookFetch(gatewayUrl: string, sharedSecret: string, inboundToken: string, forwardFetch: typeof fetch = fetch) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-webhook" });
    if (url.pathname !== "/webhook" || req.method !== "POST") return json(404, { error: "not_found" });
    if (inboundToken && req.headers.get("x-webhook-token") !== inboundToken) return json(401, { error: "unauthorized" });

    const tooLarge = rejectPayloadTooLarge(req);
    if (tooLarge) return tooLarge;

    const body = await readJsonObject<WebhookRequestBody>(req);
    if (!body) return json(400, { error: "invalid_json" });

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json(400, { error: "text_required" });

    return forwardNormalizedChannelMessage({
      gatewayUrl,
      sharedSecret,
      channel: "webhook",
      userId: typeof body.userId === "string" && body.userId.trim() ? body.userId : "webhook-user",
      text,
      metadata: typeof body.metadata === "object" && body.metadata !== null && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown>
        : undefined,
    }, forwardFetch);
  };
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
