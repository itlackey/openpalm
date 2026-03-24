/**
 * Audit logging for the OpenPalm control plane.
 */
import { mkdirSync, appendFileSync } from "node:fs";
import type { ControlPlaneState, AuditEntry, CallerType } from "./types.js";

const MAX_AUDIT_MEMORY = 1000;

export function appendAudit(
  state: ControlPlaneState,
  actor: string,
  action: string,
  args: Record<string, unknown>,
  ok: boolean,
  requestId = "",
  callerType: CallerType = "unknown"
): void {
  const entry: AuditEntry = {
    at: new Date().toISOString(),
    requestId,
    actor,
    callerType,
    action,
    args,
    ok
  };
  state.audit.push(entry);
  if (state.audit.length > MAX_AUDIT_MEMORY) {
    state.audit = state.audit.slice(-MAX_AUDIT_MEMORY);
  }
  try {
    mkdirSync(state.logsDir, { recursive: true });
    appendFileSync(
      `${state.logsDir}/admin-audit.jsonl`,
      JSON.stringify(entry) + "\n"
    );
  } catch {
    // best-effort persistence
  }
}
