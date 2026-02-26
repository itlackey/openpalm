import type { ChannelAdapter } from "./channel.ts";
import { buildChannelMessage, forwardChannelMessage } from "./channel-sdk.ts";
import { json } from "./http.ts";

export function createHttpAdapterFetch(
  adapter: ChannelAdapter,
  gatewayUrl: string,
  sharedSecret: string,
  forwardFetch: typeof fetch = fetch,
) {
  const routeMap = new Map(adapter.routes.map((route) => [`${route.method} ${route.path}`, route.handler]));

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, adapter.health());

    const routeHandler = routeMap.get(`${req.method} ${url.pathname}`);
    if (!routeHandler) return json(404, { error: "not_found" });

    const result = await routeHandler(req);
    if (!result.ok) return json(result.status, result.body);

    const payload = buildChannelMessage({
      userId: result.payload.userId,
      channel: result.payload.channel,
      text: result.payload.text,
      metadata: result.payload.metadata,
    });

    const resp = await forwardChannelMessage(gatewayUrl, sharedSecret, payload, forwardFetch);
    if (!resp.ok) return json(resp.status >= 500 ? 502 : resp.status, { error: "gateway_error", status: resp.status });

    const gatewayBodyText = await resp.text();
    return new Response(gatewayBodyText, { status: resp.status, headers: { "content-type": "application/json" } });
  };
}
