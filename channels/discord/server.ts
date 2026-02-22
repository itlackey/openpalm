import { buildChannelMessage, forwardChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import { json } from "@openpalm/lib/shared/http.ts";

const PORT = Number(Bun.env.PORT ?? 8184);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_DISCORD_SECRET ?? "";
const DISCORD_PUBLIC_KEY = Bun.env.DISCORD_PUBLIC_KEY ?? "";

async function verifyDiscordSignature(req: Request, body: string): Promise<boolean> {
  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");
  if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(DISCORD_PUBLIC_KEY, "hex"),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      Buffer.from(signature, "hex"),
      new TextEncoder().encode(timestamp + body)
    );
  } catch {
    return false;
  }
}

async function forwardToGateway(
  gatewayUrl: string,
  sharedSecret: string,
  forwardFetch: typeof fetch,
  userId: string,
  text: string,
  metadata: Record<string, unknown>
) {
  const payload = buildChannelMessage({ userId, channel: "discord", text, metadata });
  const resp = await forwardChannelMessage(gatewayUrl, sharedSecret, payload, forwardFetch);

  if (!resp.ok) {
    return { status: resp.status, body: { error: "gateway_error", status: resp.status }, isError: true };
  }

  return { status: resp.status, body: await resp.json() as Record<string, unknown>, isError: false };
}

export function createDiscordFetch(gatewayUrl: string, sharedSecret: string, forwardFetch: typeof fetch = fetch) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-discord" });

    if (url.pathname === "/discord/interactions" && req.method === "POST") {
      const contentLength = Number(req.headers.get("content-length") ?? "0");
      if (contentLength > 1_048_576) {
        return new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413 });
      }

      let rawBody: string;
      try {
        rawBody = await req.text();
      } catch {
        return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
      }

      // Verify Discord Ed25519 signature
      const isValid = await verifyDiscordSignature(req, rawBody);
      if (!isValid) {
        return json(401, { error: "invalid_signature" });
      }

      let body: {
        type?: number;
        data?: { name?: string; options?: Array<{ value?: string }> };
        member?: { user?: { id?: string; username?: string } };
        user?: { id?: string; username?: string };
        channel_id?: string;
        guild_id?: string;
      };
      try {
        body = JSON.parse(rawBody);
      } catch {
        return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
      }

      if (body.type === 1) return json(200, { type: 1 });

      if (body.type === 2) {
        const user = body.member?.user ?? body.user;
        const userId = user?.id ? `discord:${user.id}` : "";
        if (!userId) {
          return new Response(JSON.stringify({ error: "missing_user_id" }), { status: 400 });
        }

        const text = body.data?.options?.[0]?.value ?? body.data?.name ?? "";
        if (!text) return json(200, { type: 4, data: { content: "No message provided." } });

        const result = await forwardToGateway(gatewayUrl, sharedSecret, forwardFetch, userId, text, {
          channelId: body.channel_id,
          guildId: body.guild_id,
          username: user?.username
        });

        if (result.isError) {
          return json(200, { type: 4, data: { content: "An error occurred processing your request." } });
        }

        const answer = (result.body as { answer?: string })?.answer ?? "Processing...";
        return json(200, { type: 4, data: { content: answer } });
      }

      return json(200, { type: 1 });
    }

    if (url.pathname === "/discord/webhook" && req.method === "POST") {
      const contentLength = Number(req.headers.get("content-length") ?? "0");
      if (contentLength > 1_048_576) {
        return new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413 });
      }

      let body: {
        userId?: string;
        text?: string;
        channelId?: string;
        guildId?: string;
        username?: string;
      };
      try {
        body = await req.json();
      } catch {
        return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
      }

      if (!body.text) return json(400, { error: "text_required" });

      const userId = body.userId ? `discord:${body.userId}` : "";
      if (!userId) {
        return new Response(JSON.stringify({ error: "missing_user_id" }), { status: 400 });
      }

      const result = await forwardToGateway(gatewayUrl, sharedSecret, forwardFetch, userId, body.text, {
        channelId: body.channelId,
        guildId: body.guildId,
        username: body.username
      });

      if (result.isError) {
        return new Response(JSON.stringify({ error: "gateway_error", status: result.status }), {
          status: result.status >= 500 ? 502 : result.status,
          headers: { "content-type": "application/json" },
        });
      }

      return json(result.status, result.body);
    }

    return json(404, { error: "not_found" });
  };
}

if (import.meta.main) {
  if (!SHARED_SECRET) {
    console.error("[channel-discord] FATAL: CHANNEL_DISCORD_SECRET environment variable is not set. Exiting.");
    process.exit(1);
  }
  Bun.serve({ port: PORT, fetch: createDiscordFetch(GATEWAY_URL, SHARED_SECRET) });
  console.log(`discord channel listening on ${PORT}`);
}
