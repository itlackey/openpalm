import { createJsonRpcAdapterFetch } from "./channel-adapter-server.ts";
import type { JsonRpcResultBuilder } from "./channel-adapter-server.ts";
import type { ChannelAdapter } from "./channel.ts";

export function createChannelJsonRpcFetch(
  adapter: ChannelAdapter,
  gatewayUrl: string,
  sharedSecret: string,
  mapCoreResponse: JsonRpcResultBuilder,
  forwardFetch: typeof fetch = fetch,
) {
  return createJsonRpcAdapterFetch(adapter, gatewayUrl, sharedSecret, mapCoreResponse, forwardFetch);
}
