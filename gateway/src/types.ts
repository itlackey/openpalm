export type MessageRequest = {
  userId: string;
  sessionId?: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type ChannelMessage = {
  userId: string;
  channel: string;
  text: string;
  attachments?: string[];
  metadata?: Record<string, unknown>;
  nonce: string;
  timestamp: number;
};

export type AuditEvent = {
  ts: string;
  requestId: string;
  sessionId?: string;
  userId?: string;
  action: string;
  status: "ok" | "denied" | "error";
  details?: Record<string, unknown>;
};
