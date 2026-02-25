import type { ChannelAdapter } from "./channel.ts";
import { signPayload } from "./crypto.ts";
import { json } from "./http.ts";

type RpcId = string | number | null;

export type JsonRpcResultBuilder = (input: {
  rpcId: RpcId;
  metadata: Record<string, unknown> | undefined;
  answer: string;
}) => unknown;

export function createJsonRpcAdapterFetch(
  adapter: ChannelAdapter,
  gatewayUrl: string,
  sharedSecret: string,
  buildResult: JsonRpcResultBuilder,
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

    const metadata = result.payload.metadata;
    const rpcId = (metadata?.rpcId as RpcId | undefined) ?? null;
    const gatewayPayload = {
      ...result.payload,
      nonce: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    const serialized = JSON.stringify(gatewayPayload);
    const sig = signPayload(sharedSecret, serialized);
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
        result: buildResult({ rpcId, metadata, answer }),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}
