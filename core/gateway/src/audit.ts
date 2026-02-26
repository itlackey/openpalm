import { mkdirSync, statSync, renameSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import type { AuditEvent } from "./types.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const log = createLogger("gateway");
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const DEFAULT_RETENTION_COUNT = 5;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

type AuditLogOptions = {
  maxFileSizeBytes?: number;
  retentionCount?: number;
};

export class AuditLog {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly maxFileSizeBytes: number;
  private readonly retentionCount: number;

  constructor(private readonly filePath: string, options: AuditLogOptions = {}) {
    mkdirSync(dirname(filePath), { recursive: true });
    const envMaxFileSize = parsePositiveInt(Bun.env.OPENPALM_AUDIT_MAX_FILE_SIZE, DEFAULT_MAX_FILE_SIZE);
    const envRetentionCount = parsePositiveInt(Bun.env.OPENPALM_AUDIT_RETENTION_COUNT, DEFAULT_RETENTION_COUNT);
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? envMaxFileSize;
    this.retentionCount = options.retentionCount ?? envRetentionCount;
  }

  write(event: AuditEvent) {
    const line = `${JSON.stringify(event)}\n`;

    // Chain writes to maintain ordering while keeping them async
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        // Check file size and rotate if needed
        try {
          const stats = statSync(this.filePath);
          if (stats.size >= this.maxFileSizeBytes) {
            this.rotate();
          }
        } catch {
          // File may not exist yet — that is fine
        }

        await appendFile(this.filePath, line, "utf8");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("failed to write audit log", { error: message });
      }
    });
  }

  /** Wait for all pending writes to complete. Useful for tests. */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  private rotate() {
    const keepCount = Math.max(1, this.retentionCount);
    const oldestPath = `${this.filePath}.${keepCount}.gz`;
    if (existsSync(oldestPath)) rmSync(oldestPath, { force: true });

    for (let i = keepCount - 1; i >= 1; i -= 1) {
      const from = `${this.filePath}.${i}.gz`;
      const to = `${this.filePath}.${i + 1}.gz`;
      if (existsSync(from)) renameSync(from, to);
    }

    const current = readFileSync(this.filePath);
    const compressed = gzipSync(current);
    writeFileSync(`${this.filePath}.1.gz`, compressed);
    rmSync(this.filePath, { force: true });
  }
}
