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

// ── M1: Cron Range Validation Regression ──────────────────

describe("validateCron range validation (M1 regression)", () => {
  it("rejects minute value 60 (out of range 0-59)", () => {
    const err = validateCron("60 * * * *");
    expect(err).not.toBeNull();
    expect(err).toContain("minute");
    expect(err).toContain("out of range");
  });

  it("rejects hour value 25 (out of range 0-23)", () => {
    const err = validateCron("* 25 * * *");
    expect(err).not.toBeNull();
    expect(err).toContain("hour");
    expect(err).toContain("out of range");
  });

  it("rejects day-of-month value 32 (out of range 1-31)", () => {
    const err = validateCron("0 0 32 * *");
    expect(err).not.toBeNull();
    expect(err).toContain("day-of-month");
    expect(err).toContain("out of range");
  });

  it("rejects step of 0 (*/0 is invalid)", () => {
    const err = validateCron("*/0 * * * *");
    expect(err).not.toBeNull();
    expect(err).toContain("invalid step");
  });

  it("accepts day-of-week 0-7 (both 0 and 7 mean Sunday)", () => {
    expect(validateCron("0 0 * * 0-7")).toBeNull();
  });

  it("accepts valid comma expression", () => {
    expect(validateCron("0,30 * * * *")).toBeNull();
  });

  it("accepts standard expressions", () => {
    expect(validateCron("0 0 * * *")).toBeNull();
    expect(validateCron("*/15 * * * *")).toBeNull();
    expect(validateCron("0 9 * * 1")).toBeNull();
    expect(validateCron("30 8 1,15 * *")).toBeNull();
  });

  it("rejects empty expression", () => {
    expect(validateCron("")).not.toBeNull();
    expect(validateCron("   ")).not.toBeNull();
  });

  it("rejects expressions with too many or too few fields", () => {
    expect(validateCron("* * * *")).toContain("exactly 5 fields");
    expect(validateCron("* * * * * *")).toContain("exactly 5 fields");
  });
});
