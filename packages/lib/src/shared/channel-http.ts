import { buildChannelMessage, forwardChannelMessage } from "./channel-sdk.ts";
import { json } from "./http.ts";

export const MAX_JSON_BODY_BYTES = 1_048_576;

export function rejectPayloadTooLarge(req: Request, maxBytes: number = MAX_JSON_BODY_BYTES): Response | null {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) return json(413, { error: "payload_too_large" });
  return null;
}

export async function readJsonObject<T extends Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    const parsed = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

export async function forwardNormalizedChannelMessage(
  input: {
    gatewayUrl: string;
    sharedSecret: string;
    channel: string;
    userId: string;
    text: string;
    metadata?: Record<string, unknown>;
  },
  forwardFetch: typeof fetch,
): Promise<Response> {
  const payload = buildChannelMessage({
    userId: input.userId,
    channel: input.channel,
    text: input.text,
    metadata: input.metadata,
  });

  const resp = await forwardChannelMessage(input.gatewayUrl, input.sharedSecret, payload, forwardFetch);
  if (!resp.ok) {
    return json(resp.status >= 500 ? 502 : resp.status, {
      error: "gateway_error",
      status: resp.status,
    });
  }
  return new Response(await resp.text(), {
    status: resp.status,
    headers: { "content-type": "application/json" },
  });
}
