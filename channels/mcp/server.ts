import { createMcpChannel } from "./channel.ts";
import type { ChannelAdapter } from "@openpalm/lib/shared/channel.ts";
import { createChannelJsonRpcFetch } from "@openpalm/lib/shared/channel-jsonrpc-fetch.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";
import { installGracefulShutdown } from "@openpalm/lib/shared/shutdown.ts";

const log = createLogger("channel-mcp");

const PORT = Number(Bun.env.PORT ?? 8187);
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const SHARED_SECRET = Bun.env.CHANNEL_MCP_SECRET ?? "";

export function createFetch(
  adapter: ChannelAdapter,
  gatewayUrl: string,
  sharedSecret: string,
  forwardFetch: typeof fetch = fetch,
) {
  return createChannelJsonRpcFetch(
    adapter,
    gatewayUrl,
    sharedSecret,
    ({ answer }) => ({
      content: [{ type: "text", text: answer }],
    }),
    forwardFetch,
  );
}

if (import.meta.main) {
  if (!SHARED_SECRET) {
    log.error("CHANNEL_MCP_SECRET is not set, exiting");
    process.exit(1);
  }
  const adapter = createMcpChannel();
  const server = Bun.serve({ port: PORT, fetch: createFetch(adapter, GATEWAY_URL, SHARED_SECRET) });
  installGracefulShutdown(server, { service: "channel-mcp", logger: log });
  log.info("started", { port: PORT });
}
