import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cronDir = "";

describe("automations sync", () => {
  beforeEach(() => {
    cronDir = mkdtempSync(join(tmpdir(), "openpalm-automations-"));
    Bun.env.CRON_DIR = cronDir;
  });

  afterEach(() => {
    rmSync(cronDir, { recursive: true, force: true });
  });

  it("writes enabled and disabled cron entries to separate directories", async () => {
    const { ensureCronDirs, syncAutomations } = await import(`@openpalm/lib/admin/automations.ts?cron=${Date.now()}`);
    ensureCronDirs();
    syncAutomations([
      { id: "daily", name: "Daily", schedule: "0 9 * * *", script: "echo hi", enabled: true },
      { id: "nightly", name: "Nightly", schedule: "0 1 * * *", script: "echo no", enabled: false },
    ]);

    expect(existsSync(join(cronDir, "cron.d.enabled", "01-daily"))).toBeTrue();
    expect(existsSync(join(cronDir, "cron.d.disabled", "02-nightly"))).toBeTrue();

    const combined = readFileSync(join(cronDir, "cron.schedule"), "utf8");
    expect(combined).toContain("0 9 * * *");
    expect(combined).not.toContain("0 1 * * *");
  });
});
