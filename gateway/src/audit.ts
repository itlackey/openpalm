import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEvent } from "./types.ts";

export class AuditLog {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  write(event: AuditEvent) {
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}
