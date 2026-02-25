import { signPayload } from "./crypto.ts";

export type ChannelMessage = {
  userId: string;
  channel: string;
  text: string;
  attachments?: string[];
  metadata?: Record<string, unknown>;
  nonce: string;
  timestamp: number;
};

const METADATA_MAX_DEPTH = 4;
const METADATA_MAX_KEYS_PER_OBJECT = 64;
const METADATA_MAX_ARRAY_ITEMS = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeMetadataValue(value: unknown, depth: number): unknown {
  if (depth >= METADATA_MAX_DEPTH) return undefined;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const sanitizedItems = value
      .slice(0, METADATA_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeMetadataValue(item, depth + 1))
      .filter((item) => item !== undefined);
    return sanitizedItems;
  }

  if (!isPlainObject(value)) return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, METADATA_MAX_KEYS_PER_OBJECT)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const sanitized = sanitizeMetadataValue(raw, depth + 1);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

function sanitizeMetadata(metadata: unknown): Record<string, unknown> {
  const sanitized = sanitizeMetadataValue(metadata, 0);
  return isPlainObject(sanitized) ? sanitized : {};
}

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
    metadata: sanitizeMetadata(input.metadata),
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
