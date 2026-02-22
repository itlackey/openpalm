import { signPayload } from "./crypto.ts";

export type ChannelMessage = {
  userId: string;
  channel: string;
  text: string;
  metadata?: Record<string, unknown>;
  nonce: string;
  timestamp: number;
};

export function buildChannelMessage(input: {
  userId: string;
  channel: string;
  text: string;
  metadata?: Record<string, unknown>;
}): ChannelMessage {
  return {
    userId: input.userId,
    channel: input.channel,
    text: input.text,
    metadata: input.metadata ?? {},
    nonce: crypto.randomUUID(),
    timestamp: Date.now(),
  };
}

export async function forwardChannelMessage(
  gatewayUrl: string,
  sharedSecret: string,
  payload: ChannelMessage,
  forwardFetch: typeof fetch = fetch,
): Promise<Response> {
  const serialized = JSON.stringify(payload);
  const signature = signPayload(sharedSecret, serialized);
  return forwardFetch(`${gatewayUrl}/channel/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-channel-signature": signature },
    body: serialized,
  });
}
