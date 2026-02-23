import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cronDir = "";
let savedCronDir: string | undefined;

describe("automations sync", () => {
  beforeEach(() => {
    savedCronDir = Bun.env.CRON_DIR;
    cronDir = mkdtempSync(join(tmpdir(), "openpalm-automations-"));
    Bun.env.CRON_DIR = cronDir;
  });

  afterEach(() => {
    rmSync(cronDir, { recursive: true, force: true });
    if (savedCronDir !== undefined) Bun.env.CRON_DIR = savedCronDir;
    else delete Bun.env.CRON_DIR;
  });

  it("writes enabled and disabled cron entries to separate directories", async () => {
    const { ensureCronDirs, syncAutomations } = await import(`./automations.ts?cron=${Date.now()}`);
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
