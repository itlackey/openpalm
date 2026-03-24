/**
 * Audit logging — append-only structured log for security events.
 *
 * Writes JSON-lines to the configured audit path. Creates the audit
 * directory at module load time (startup).
 */

import { createLogger } from "@openpalm/channels-sdk/logger";

const logger = createLogger("guardian:audit");

const AUDIT_PATH = Bun.env.GUARDIAN_AUDIT_PATH ?? "/app/audit/guardian-audit.log";

// Ensure audit directory exists
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
const auditDir = dirname(AUDIT_PATH);
if (auditDir) {
  try { mkdirSync(auditDir, { recursive: true }); } catch {
    logger.error("Failed to create audit directory", { path: auditDir });
  }
}

// Use Bun.file().writer() for efficient append-only audit logging
const auditWriter = Bun.file(AUDIT_PATH).writer();

export function audit(event: Record<string, unknown>): void {
  try {
    auditWriter.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
    auditWriter.flush();
  } catch (err) {
    logger.error("Audit flush failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
