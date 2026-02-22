import { buildChannelMessage, forwardChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";

export { signPayload };

const PORT = Number(Bun.env.PORT ?? 8185);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_WEBHOOK_SECRET ?? "";
const INBOUND_TOKEN = Bun.env.WEBHOOK_INBOUND_TOKEN ?? "";

export function createWebhookFetch(gatewayUrl: string, sharedSecret: string, inboundToken: string, forwardFetch: typeof fetch = fetch) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-webhook" });
    if (url.pathname !== "/webhook" || req.method !== "POST") return json(404, { error: "not_found" });
    if (inboundToken && req.headers.get("x-webhook-token") !== inboundToken) return json(401, { error: "unauthorized" });

    const body = await req.json() as { userId?: string; text?: string; metadata?: Record<string, unknown> };
    if (!body.text) return json(400, { error: "text_required" });

    const payload = buildChannelMessage({
      userId: body.userId ?? "webhook-user",
      channel: "webhook",
      text: body.text,
      metadata: body.metadata ?? {}
    });

    const resp = await forwardChannelMessage(gatewayUrl, sharedSecret, payload, forwardFetch);

    return new Response(await resp.text(), { status: resp.status, headers: { "content-type": "application/json" } });
  };
}

if (import.meta.main) {
  Bun.serve({ port: PORT, fetch: createWebhookFetch(GATEWAY_URL, SHARED_SECRET, INBOUND_TOKEN) });
  console.log(JSON.stringify({ kind: "startup", service: "channel-webhook", port: PORT }));
}
