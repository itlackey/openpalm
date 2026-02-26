import type { ChannelAdapter } from "./channel.ts";
import { readJsonObject, rejectPayloadTooLarge } from "./channel-http.ts";
import { sanitizeMetadataObject } from "./metadata.ts";

type CreateSimpleTextAdapterOptions = {
  channel: string;
  routePath: string;
  serviceName: string;
  userIdFallback: string;
  inboundTokenHeader: string;
  inboundToken: string;
};

export function createSimpleTextAdapter(options: CreateSimpleTextAdapterOptions): ChannelAdapter {
  const {
    channel,
    routePath,
    serviceName,
    userIdFallback,
    inboundTokenHeader,
    inboundToken,
  } = options;

  const adapter: ChannelAdapter = {
    name: channel,
    routes: [{
      method: "POST",
      path: routePath,
      handler: async (req: Request) => {
        if (inboundToken && req.headers.get(inboundTokenHeader) !== inboundToken) {
          return { ok: false, status: 401, body: { error: "unauthorized" } };
        }
        const tooLarge = rejectPayloadTooLarge(req);
        if (tooLarge) return { ok: false, status: 413, body: { error: "payload_too_large" } };

        const body = await readJsonObject<Record<string, unknown>>(req);
        if (!body) return { ok: false, status: 400, body: { error: "invalid_json" } };

        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return { ok: false, status: 400, body: { error: "text_required" } };

        return {
          ok: true,
          payload: {
            userId: typeof body.userId === "string" && body.userId.trim() ? body.userId : userIdFallback,
            channel,
            text,
            metadata: sanitizeMetadataObject(body.metadata),
          },
        };
      },
    }],
    health: () => ({ ok: true, service: serviceName }),
  };

  return adapter;
}
