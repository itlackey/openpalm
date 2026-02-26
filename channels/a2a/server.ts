import { createA2aChannel } from "./channel.ts";
import type { ChannelAdapter } from "@openpalm/lib/shared/channel.ts";
import { createChannelJsonRpcFetch } from "@openpalm/lib/shared/channel-jsonrpc-fetch.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";
import { installGracefulShutdown } from "@openpalm/lib/shared/shutdown.ts";

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
  return createChannelJsonRpcFetch(
    adapter,
    gatewayUrl,
    sharedSecret,
    ({ metadata, answer }) => ({
      id: (metadata?.taskId as string | undefined) ?? "",
      status: { state: "completed" },
      artifacts: [{ parts: [{ type: "text", text: answer }] }],
    }),
    forwardFetch,
  );
}

if (import.meta.main) {
  if (!SHARED_SECRET) {
    log.error("CHANNEL_A2A_SECRET is not set, exiting");
    process.exit(1);
  }
  const adapter = createA2aChannel();
  const server = Bun.serve({ port: PORT, fetch: createFetch(adapter, GATEWAY_URL, SHARED_SECRET) });
  installGracefulShutdown(server, { service: "channel-a2a", logger: log });
  log.info("started", { port: PORT });
}
