import { buildChannelMessage, forwardChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const log = createLogger("channel-chat");

const PORT = Number(Bun.env.PORT ?? 8181);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_CHAT_SECRET ?? "";
const INBOUND_TOKEN = Bun.env.CHAT_INBOUND_TOKEN ?? "";

type ChatRequestBody = {
  userId?: string;
  text?: string;
  metadata?: Record<string, unknown>;
};

function asChatRequestBody(value: unknown): ChatRequestBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as ChatRequestBody;
}

export function createChatFetch(gatewayUrl: string, sharedSecret: string, inboundToken: string, forwardFetch: typeof fetch = fetch) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-chat" });
    if (url.pathname !== "/chat" || req.method !== "POST") return json(404, { error: "not_found" });
    if (inboundToken && req.headers.get("x-chat-token") !== inboundToken) return json(401, { error: "unauthorized" });

    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (contentLength > 1_048_576) {
      return new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413 });
    }

    let body: ChatRequestBody;
    try {
      const parsed = await req.json();
      const normalized = asChatRequestBody(parsed);
      if (!normalized) return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
      body = normalized;
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
    }

    if (!body.text) return json(400, { error: "text_required" });

    const payload = buildChannelMessage({
      userId: body.userId ?? "chat-user",
      channel: "chat",
      text: body.text,
      metadata: body.metadata ?? {}
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
    log.error("CHANNEL_CHAT_SECRET is not set, exiting");
    process.exit(1);
  }
  Bun.serve({ port: PORT, fetch: createChatFetch(GATEWAY_URL, SHARED_SECRET, INBOUND_TOKEN) });
  log.info("started", { port: PORT });
}
