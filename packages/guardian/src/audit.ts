/**
 * Audit logging — append-only structured log for security events.
 *
 * Writes JSON-lines to the configured audit path. Creates the audit
 * directory at module load time (startup). Each event is written
 * immediately to the Bun writer's internal buffer; an explicit flush
 * to disk runs every 5 seconds. Best-effort: a crash may lose only
 * unflushed writes from the OS buffer.
 */

import { createLogger } from './logger.ts';

const logger = createLogger("guardian:audit");

const AUDIT_PATH = Bun.env.GUARDIAN_AUDIT_PATH ?? "/opt/openpalm/logs/guardian-audit.log";
const FLUSH_INTERVAL_MS = 5_000;

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Append-only audit writer, created lazily on first write. Deferring the
// directory creation + file open keeps importing this module (and the
// @openpalm/guardian library entrypoint that transitively pulls it in) free of
// filesystem side effects — only a running guardian touches the audit log.
type AuditWriter = ReturnType<ReturnType<typeof Bun.file>["writer"]>;
let auditWriter: AuditWriter | null = null;
let dirty = false;

function getAuditWriter(): AuditWriter {
  if (auditWriter) return auditWriter;
  const auditDir = dirname(AUDIT_PATH);
  if (auditDir) {
    try {
      mkdirSync(auditDir, { recursive: true });
    } catch {
      logger.error("Failed to create audit directory", { path: auditDir });
    }
  }
  auditWriter = Bun.file(AUDIT_PATH).writer();
  return auditWriter;
}

function flushAuditBuffer(): void {
  if (!dirty || !auditWriter) return;
  try {
    auditWriter.flush();
    dirty = false;
  } catch (err) {
    logger.error("Audit flush failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

// Periodic flush — unref so the timer doesn't keep the process alive
const flushTimer = setInterval(flushAuditBuffer, FLUSH_INTERVAL_MS);
flushTimer.unref();

// Flush remaining events on graceful shutdown
function onShutdown(): void {
  flushAuditBuffer();
}
process.on("SIGTERM", onShutdown);
process.on("SIGINT", onShutdown);
process.on("beforeExit", onShutdown);

export function audit(event: Record<string, unknown>): void {
  try {
    getAuditWriter().write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
    dirty = true;
  } catch (err) {
    logger.error("Audit write failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
