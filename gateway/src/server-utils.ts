import { randomUUID } from "node:crypto";
import type { ChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";

export const ALLOWED_CHANNELS = new Set(["chat", "discord", "voice", "telegram"]);

export function safeRequestId(header: string | null): string {
  if (header && /^[a-zA-Z0-9_-]{1,64}$/.test(header)) return header;
  return randomUUID();
}

export function validatePayload(payload: Partial<ChannelMessage>): payload is ChannelMessage {
  return (
    typeof payload.userId === "string" &&
    payload.userId.trim().length > 0 &&
    typeof payload.channel === "string" &&
    ALLOWED_CHANNELS.has(payload.channel) &&
    typeof payload.text === "string" &&
    payload.text.trim().length > 0 &&
    payload.text.length <= 10_000 &&
    typeof payload.nonce === "string" &&
    payload.nonce.trim().length > 0 &&
    typeof payload.timestamp === "number"
  );
}
