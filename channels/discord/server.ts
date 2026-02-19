import { createHmac } from "node:crypto";

const PORT = Number(Bun.env.PORT ?? 8184);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_DISCORD_SECRET ?? "";

export function signPayload(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: { "content-type": "application/json" } });
}

async function forwardToGateway(
  gatewayUrl: string,
  sharedSecret: string,
  forwardFetch: typeof fetch,
  userId: string,
  text: string,
  metadata: Record<string, unknown>
) {
  const payload = {
    userId,
    channel: "discord",
    text,
    metadata,
    nonce: crypto.randomUUID(),
    timestamp: Date.now()
  };
  const serialized = JSON.stringify(payload);
  const sig = signPayload(sharedSecret, serialized);

  const resp = await forwardFetch(`${gatewayUrl}/channel/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-channel-signature": sig },
    body: serialized
  });

  return { status: resp.status, body: await resp.json() as Record<string, unknown> };
}

export function createDiscordFetch(gatewayUrl: string, sharedSecret: string, forwardFetch: typeof fetch = fetch) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true, service: "channel-discord" });

    if (url.pathname === "/discord/interactions" && req.method === "POST") {
      const body = await req.json() as {
        type?: number;
        data?: { name?: string; options?: Array<{ value?: string }> };
        member?: { user?: { id?: string; username?: string } };
        user?: { id?: string; username?: string };
        channel_id?: string;
        guild_id?: string;
      };

      if (body.type === 1) return json(200, { type: 1 });

      if (body.type === 2) {
        const user = body.member?.user ?? body.user;
        const userId = user?.id ? `discord:${user.id}` : "discord:unknown";
        const text = body.data?.options?.[0]?.value ?? body.data?.name ?? "";
        if (!text) return json(200, { type: 4, data: { content: "No message provided." } });

        const result = await forwardToGateway(gatewayUrl, sharedSecret, forwardFetch, userId, text, {
          channelId: body.channel_id,
          guildId: body.guild_id,
          username: user?.username
        });

        const answer = (result.body as { answer?: string })?.answer ?? "Processing...";
        return json(200, { type: 4, data: { content: answer } });
      }

      return json(200, { type: 1 });
    }

    if (url.pathname === "/discord/webhook" && req.method === "POST") {
      const body = await req.json() as {
        userId?: string;
        text?: string;
        channelId?: string;
        guildId?: string;
        username?: string;
      };
      if (!body.text) return json(400, { error: "text_required" });

      const userId = body.userId ? `discord:${body.userId}` : "discord:unknown";
      const result = await forwardToGateway(gatewayUrl, sharedSecret, forwardFetch, userId, body.text, {
        channelId: body.channelId,
        guildId: body.guildId,
        username: body.username
      });

      return json(result.status, result.body);
    }

    return json(404, { error: "not_found" });
  };
}

if (import.meta.main) {
  Bun.serve({ port: PORT, fetch: createDiscordFetch(GATEWAY_URL, SHARED_SECRET) });
  console.log(`discord channel listening on ${PORT}`);
}
