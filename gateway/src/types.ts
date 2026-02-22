// Re-export the canonical ChannelMessage from the shared library
export type { ChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";

export type AuditEvent = {
  ts: string;
  requestId: string;
  sessionId?: string;
  userId?: string;
  action: string;
  status: "ok" | "denied" | "error";
  details?: Record<string, unknown>;
};
