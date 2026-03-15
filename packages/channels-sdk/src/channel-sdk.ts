/**
 * OpenPalm channel SDK helpers.
 *
 * buildChannelMessage: adds nonce and timestamp to a ChannelMessageInput.
 * forwardChannelMessage: signs the payload and POSTs it to the guardian.
 */

import type { ChannelPayload, ChannelMessageInput } from "./channel.ts";
import { signPayload } from "./crypto.ts";

/**
 * Adds a fresh nonce (UUID) and current timestamp to a ChannelMessageInput,
 * producing a complete ChannelPayload ready for signing and forwarding.
 */
export function buildChannelMessage(input: ChannelMessageInput): ChannelPayload {
  return {
    ...input,
    nonce: crypto.randomUUID(),
    timestamp: Date.now(),
  };
}

/**
 * Signs the payload and POSTs it to the guardian's /channel/inbound endpoint.
 * An optional fetch override is accepted for testing.
 *
 * No timeout is applied by default — the guardian (and assistant behind it)
 * may run long tasks. Set timeoutMs to a positive value to enable.
 */
export async function forwardChannelMessage(
  guardianUrl: string,
  secret: string,
  payload: ChannelPayload,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 0,
): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = signPayload(secret, body);
  return fetchFn(`${guardianUrl}/channel/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-channel-signature": signature,
    },
    body,
    ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
}
