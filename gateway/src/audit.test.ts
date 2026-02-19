import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit.ts";

describe("audit log", () => {
  it("creates the parent directory and writes one JSONL event per line", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-audit-"));
    const filePath = join(dir, "nested", "audit.log");
    const audit = new AuditLog(filePath);

    audit.write({
      ts: new Date().toISOString(),
      requestId: "req-1",
      action: "channel_inbound",
      status: "ok",
      details: { channel: "chat" },
    });
    audit.write({
      ts: new Date().toISOString(),
      requestId: "req-2",
      action: "channel_forward_to_core",
      status: "error",
      details: { reason: "timeout" },
    });

    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    const second = JSON.parse(lines[1]) as Record<string, unknown>;

    expect(first.requestId).toBe("req-1");
    expect(second.requestId).toBe("req-2");
  });
});
