export type Approval = { approved: boolean; approvedBy?: string; reason?: string };

export type MessageRequest = {
  userId: string;
  sessionId?: string;
  text: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  approval?: Approval;
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

export type MemoryRecord = {
  id: string;
  userId: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  timestamp: string;
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

export type ProviderConnection = {
  id: string;
  name: string;
  url: string;
  apiKey: string;
  createdAt: string;
};

export type ConnectionType = "ai-provider" | "platform" | "api-service";

export type Connection = {
  id: string;
  name: string;
  type: ConnectionType;
  endpoint: string;
  status: "configured" | "not-configured" | "error";
  usedBy: string[];
  envPrefix: string; // e.g., "OPENPALM_CONN_ANTHROPIC"
  createdAt: string;
};

export type ModelAssignment = "small" | "openmemory";

