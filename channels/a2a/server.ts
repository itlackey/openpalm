import { createA2aChannel } from "./channel.ts";
import type { ChannelAdapter } from "@openpalm/lib/shared/channel.ts";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const log = createLogger("channel-a2a");

const PORT = Number(Bun.env.PORT ?? 8188);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_A2A_SECRET ?? "";

export function createFetch(
  adapter: ChannelAdapter,
  gatewayUrl: string,
  sharedSecret: string,
  forwardFetch: typeof fetch = fetch,
) {
  const routeMap = new Map(adapter.routes.map((route) => [`${route.method} ${route.path}`, route.handler]));

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, adapter.health());

    const handler = routeMap.get(`${req.method} ${url.pathname}`);
    if (!handler) return json(404, { error: "not_found" });

    const result = await handler(req);

    if (!result.ok) {
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    }

    const gatewayPayload = {
      ...result.payload,
      nonce: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    const serialized = JSON.stringify(gatewayPayload);
    const sig = signPayload(sharedSecret, serialized);
    const rpcId = (result.payload.metadata?.rpcId as string | number | null) ?? null;
    const taskId = (result.payload.metadata?.taskId as string) ?? "";

    const resp = await forwardFetch(`${gatewayUrl}/channel/inbound`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": sig,
      },
      body: serialized,
    });

    if (!resp.ok) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId,
          error: { code: -32000, message: `Gateway error (${resp.status})` },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const answerBody = await resp.text();
    let answer = "";
    try {
      const parsed = JSON.parse(answerBody) as Record<string, unknown>;
      if (typeof parsed.answer === "string") answer = parsed.answer;
    } catch {
      answer = answerBody;
    }

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          id: taskId,
          status: { state: "completed" },
          artifacts: [
            {
              parts: [{ type: "text", text: answer }],
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

if (import.meta.main) {
  if (!SHARED_SECRET) {
    log.error("CHANNEL_A2A_SECRET is not set, exiting");
    process.exit(1);
  }
  const adapter = createA2aChannel();
  Bun.serve({ port: PORT, fetch: createFetch(adapter, GATEWAY_URL, SHARED_SECRET) });
  log.info("started", { port: PORT });
}
