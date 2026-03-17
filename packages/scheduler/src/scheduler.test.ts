import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startScheduler,
  stopScheduler,
  reloadScheduler,
  getSchedulerStatus,
  getLoadedAutomations,
  getExecutionLog,
  getAllExecutionLogs,
  triggerAutomation,
  startWatching,
  stopWatching,
} from "./scheduler.js";

const TEST_DIR = join(tmpdir(), `scheduler-test-${Date.now()}`);
const AUTOMATIONS_DIR = join(TEST_DIR, "automations");

const VALID_HTTP_AUTOMATION = `
name: test-http
description: Test HTTP automation
schedule: "0 0 * * *"
enabled: true
action:
  type: http
  url: https://httpbin.org/get
  method: GET
on_failure: log
`;

const VALID_SHELL_AUTOMATION = `
name: test-shell
description: Test shell automation
schedule: "0 0 * * *"
enabled: true
action:
  type: shell
  command:
    - echo
    - hello
on_failure: log
`;

const DISABLED_AUTOMATION = `
name: disabled
description: Disabled automation
schedule: "0 0 * * *"
enabled: false
action:
  type: http
  url: https://httpbin.org/get
on_failure: log
`;

function setupDir(): void {
  mkdirSync(AUTOMATIONS_DIR, { recursive: true });
}

function cleanupDir(): void {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("scheduler", () => {
  beforeEach(() => {
    stopScheduler();
    setupDir();
  });

  afterEach(() => {
    stopScheduler();
    stopWatching();
    cleanupDir();
  });

  describe("startScheduler", () => {
    it("should load enabled automations", () => {
      writeFileSync(join(AUTOMATIONS_DIR, "test-http.yml"), VALID_HTTP_AUTOMATION);
      writeFileSync(join(AUTOMATIONS_DIR, "test-shell.yml"), VALID_SHELL_AUTOMATION);

      startScheduler(TEST_DIR, "test-token");

      const status = getSchedulerStatus();
      expect(status.jobCount).toBe(2);
      expect(status.jobs.map((j) => j.name).sort()).toEqual(["test-http", "test-shell"]);
    });

    it("should skip disabled automations", () => {
      writeFileSync(join(AUTOMATIONS_DIR, "disabled.yml"), DISABLED_AUTOMATION);

      startScheduler(TEST_DIR, "test-token");

      const status = getSchedulerStatus();
      expect(status.jobCount).toBe(0);
    });

    it("should handle empty automations directory", () => {
      startScheduler(TEST_DIR, "test-token");

      const status = getSchedulerStatus();
      expect(status.jobCount).toBe(0);
    });

    it("should handle missing automations directory", () => {
      rmSync(AUTOMATIONS_DIR, { recursive: true, force: true });

      startScheduler(TEST_DIR, "test-token");

      const status = getSchedulerStatus();
      expect(status.jobCount).toBe(0);
    });

    it("should include nextRun in status", () => {
      writeFileSync(join(AUTOMATIONS_DIR, "test-http.yml"), VALID_HTTP_AUTOMATION);

      startScheduler(TEST_DIR, "test-token");

      const status = getSchedulerStatus();
      expect(status.jobs[0].nextRun).toBeTruthy();
    });
  });

  describe("stopScheduler", () => {
    it("should clear all jobs", () => {
      writeFileSync(join(AUTOMATIONS_DIR, "test-http.yml"), VALID_HTTP_AUTOMATION);

      startScheduler(TEST_DIR, "test-token");
      expect(getSchedulerStatus().jobCount).toBe(1);

      stopScheduler();
      expect(getSchedulerStatus().jobCount).toBe(0);
    });
  });

  describe("reloadScheduler", () => {
    it("should pick up new automations", () => {
      writeFileSync(join(AUTOMATIONS_DIR, "test-http.yml"), VALID_HTTP_AUTOMATION);
      startScheduler(TEST_DIR, "test-token");
      expect(getSchedulerStatus().jobCount).toBe(1);

      writeFileSync(join(AUTOMATIONS_DIR, "test-shell.yml"), VALID_SHELL_AUTOMATION);
      reloadScheduler(TEST_DIR, "test-token");
      expect(getSchedulerStatus().jobCount).toBe(2);
    });
  });

  describe("getLoadedAutomations", () => {
    it("should return automation configs", () => {
      writeFileSync(join(AUTOMATIONS_DIR, "test-http.yml"), VALID_HTTP_AUTOMATION);
      startScheduler(TEST_DIR, "test-token");

      const automations = getLoadedAutomations();
      expect(automations).toHaveLength(1);
      expect(automations[0].name).toBe("test-http");
      expect(automations[0].action.type).toBe("http");
    });
  });

  describe("triggerAutomation", () => {
    it("should return error for unknown automation", async () => {
      startScheduler(TEST_DIR, "test-token");

      const result = await triggerAutomation("nonexistent.yml", "test-token");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should trigger and record execution for shell action", async () => {
      writeFileSync(join(AUTOMATIONS_DIR, "test-shell.yml"), VALID_SHELL_AUTOMATION);
      startScheduler(TEST_DIR, "test-token");

      const result = await triggerAutomation("test-shell.yml", "test-token");
      expect(result.ok).toBe(true);

      const logs = getExecutionLog("test-shell.yml");
      expect(logs).toHaveLength(1);
      expect(logs[0].ok).toBe(true);
    });
  });

  describe("execution logs", () => {
    it("should return empty logs for unknown automation", () => {
      const logs = getExecutionLog("unknown.yml");
      expect(logs).toEqual([]);
    });

    it("should return all logs keyed by fileName", async () => {
      writeFileSync(join(AUTOMATIONS_DIR, "test-shell.yml"), VALID_SHELL_AUTOMATION);
      startScheduler(TEST_DIR, "test-token");

      await triggerAutomation("test-shell.yml", "test-token");

      const allLogs = getAllExecutionLogs();
      expect(allLogs["test-shell.yml"]).toHaveLength(1);
    });
  });

  describe("file watching", () => {
    it("should start and stop without errors", () => {
      startScheduler(TEST_DIR, "test-token");
      startWatching(TEST_DIR, "test-token");
      stopWatching();
    });

    it("should create automations dir if missing", () => {
      rmSync(AUTOMATIONS_DIR, { recursive: true, force: true });
      startScheduler(TEST_DIR, "test-token");
      startWatching(TEST_DIR, "test-token");
      stopWatching();
    });
  });
});
