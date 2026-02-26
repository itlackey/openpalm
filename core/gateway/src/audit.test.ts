import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { AuditLog } from "./audit.ts";

describe("audit log", () => {
  it("creates the parent directory and writes one JSONL event per line", async () => {
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

    await audit.flush();
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    const second = JSON.parse(lines[1]) as Record<string, unknown>;

    expect(first.requestId).toBe("req-1");
    expect(second.requestId).toBe("req-2");
  });

  it("rotates to compressed files and enforces retention", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-audit-"));
    const filePath = join(dir, "audit.log");
    const audit = new AuditLog(filePath, { maxFileSizeBytes: 1, retentionCount: 2 });

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
      action: "channel_inbound",
      status: "ok",
      details: { channel: "chat" },
    });
    audit.write({
      ts: new Date().toISOString(),
      requestId: "req-3",
      action: "channel_inbound",
      status: "ok",
      details: { channel: "chat" },
    });

    await audit.flush();

    expect(existsSync(`${filePath}.1.gz`)).toBe(true);
    expect(existsSync(`${filePath}.2.gz`)).toBe(true);
    expect(existsSync(`${filePath}.3.gz`)).toBe(false);

    const latestRotated = gunzipSync(readFileSync(`${filePath}.1.gz`)).toString("utf8");
    const olderRotated = gunzipSync(readFileSync(`${filePath}.2.gz`)).toString("utf8");
    expect(latestRotated).toContain("req-2");
    expect(olderRotated).toContain("req-1");

    const current = readFileSync(filePath, "utf8");
    expect(current).toContain("req-3");
  });
});
