/**
 * Audit logging — append-only structured log for security events.
 *
 * Writes JSON-lines to the configured audit path. Creates the audit
 * directory at module load time (startup).
 */

const AUDIT_PATH = Bun.env.GUARDIAN_AUDIT_PATH ?? "/app/audit/guardian-audit.log";

// Ensure audit directory exists
import { mkdirSync } from "node:fs";
const auditDir = AUDIT_PATH.slice(0, AUDIT_PATH.lastIndexOf("/"));
if (auditDir) {
  try { mkdirSync(auditDir, { recursive: true }); } catch {
    console.error("Failed to create audit directory:", auditDir);
  }
}

// Use Bun.file().writer() for efficient append-only audit logging
const auditWriter = Bun.file(AUDIT_PATH).writer();

export function audit(event: Record<string, unknown>): void {
  try {
    auditWriter.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
    auditWriter.flush();
  } catch (err) {
    console.error("Audit flush failed:", err);
  }
}
