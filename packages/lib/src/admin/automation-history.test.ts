import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHistory, getLatestRun } from "./automation-history.ts";

describe("automation history", () => {
  it("reads latest entries in reverse order", () => {
    const root = mkdtempSync(join(tmpdir(), "openpalm-automation-history-"));
    const cronDir = join(root, "cron");
    const logDir = join(cronDir, "log");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "daily.jsonl"), [
      JSON.stringify({ ts: "2024-01-01T00:00:00Z", id: "daily", status: "success" }),
      JSON.stringify({ ts: "2024-01-02T00:00:00Z", id: "daily", status: "error" }),
    ].join("\n"), "utf8");

    const runs = readHistory("daily", 2, cronDir);
    expect(runs.length).toBe(2);
    expect(runs[0]?.status).toBe("error");
    expect(getLatestRun("daily", cronDir)?.status).toBe("error");
  });
});
