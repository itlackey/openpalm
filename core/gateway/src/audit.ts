import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent } from "./types.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const log = createLogger("gateway");

export class AuditLog {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  write(event: AuditEvent) {
    const line = `${JSON.stringify(event)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await appendFile(this.filePath, line, "utf8");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("failed to write audit log", { error: message });
      }
    });
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }
}
