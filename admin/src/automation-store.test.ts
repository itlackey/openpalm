import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationStore, validateCron } from "./automation-store.ts";

describe("automation store", () => {
  it("supports CRUD operations and persistence", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "openpalm-automations-"));
    const dataDir = join(baseDir, "data");
    const crontabDir = join(baseDir, "cron");

    const store = new AutomationStore(dataDir, crontabDir);

    store.add({
      id: "job-1",
      name: "Daily summary",
      schedule: "0 8 * * *",
      prompt: "summarize yesterday",
      status: "enabled" as const,
      createdAt: new Date().toISOString(),
    });

    expect(store.list().length).toBe(1);
    expect(store.get("job-1")?.name).toBe("Daily summary");

    const updated = store.update("job-1", { status: "disabled", name: "Updated summary" });
    expect(updated?.status).toBe("disabled");
    expect(updated?.name).toBe("Updated summary");

    store.writeCrontab();
    const crontab = readFileSync(join(crontabDir, "crontab"), "utf8");
    expect(crontab).toContain("# DISABLED: 0 8 * * *");

    const payloadPath = join(crontabDir, "cron-payloads", "job-1.json");
    expect(existsSync(payloadPath)).toBe(true);

    const removed = store.remove("job-1");
    expect(removed).toBe(true);
    expect(store.list().length).toBe(0);
    expect(existsSync(payloadPath)).toBe(false);

    const reloaded = new AutomationStore(dataDir, crontabDir);
    expect(reloaded.list().length).toBe(0);
  });

  it("rejects invalid cron expressions", () => {
    expect(validateCron("* * * *")).toBe("cron expression must have exactly 5 fields");
    expect(validateCron("* * * * bad!")).toContain("invalid characters");
    expect(validateCron("*/5 * * * *")).toBeNull();
  });
});
