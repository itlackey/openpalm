import { mkdirSync, statSync, renameSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent } from "./types.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const log = createLogger("gateway");
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export class AuditLog {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  write(event: AuditEvent) {
    const line = `${JSON.stringify(event)}\n`;

    // Chain writes to maintain ordering while keeping them async
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        // Check file size and rotate if needed
        try {
          const stats = statSync(this.filePath);
          if (stats.size >= MAX_FILE_SIZE) {
            renameSync(this.filePath, `${this.filePath}.1`);
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
}
