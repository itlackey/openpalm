export type AuditEvent = {
  ts: string;
  requestId: string;
  sessionId?: string;
  userId?: string;
  action: string;
  status: "ok" | "denied" | "error";
  details?: Record<string, unknown>;
};
