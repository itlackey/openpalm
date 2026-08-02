/**
 * Tests for AKM markdown task loading and scheduler functions.
 *
 * Covers:
 * 1. SCHEDULE_PRESETS display labels
 * 2. loadAutomations — reads markdown tasks from knowledge/tasks/
 * 3. readAutomationLogs — reads from data/akm/cache/tasks/logs/
 *
 * executeAutomation is verified at the route level via the run vitest.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEDULE_PRESETS,
  loadAutomations,
  readAutomationLogs,
} from "@openpalm/lib";

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-sched-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTask(stashDir: string, id: string, content: string): void {
  const tasksDir = join(stashDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${id}.yml`), content);
}

let stashDir: string;
let dataDir: string;

beforeEach(() => {
  stashDir = makeTempDir();
  dataDir = makeTempDir();
});

afterEach(() => {
  rmSync(stashDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

// ── SCHEDULE_PRESETS ─────────────────────────────────────────────────────

describe("SCHEDULE_PRESETS", () => {
  test("contains expected display labels", () => {
    expect(SCHEDULE_PRESETS["every-5-minutes"]).toBe("*/5 * * * *");
    expect(SCHEDULE_PRESETS["daily-8am"]).toBe("0 8 * * *");
    expect(SCHEDULE_PRESETS["weekly-sunday-3am"]).toBe("0 3 * * 0");
  });
});

// ── loadAutomations ──────────────────────────────────────────────────────

describe("loadAutomations", () => {
  test("returns empty array when knowledge/tasks does not exist", () => {
    const result = loadAutomations(stashDir);
    expect(result).toEqual([]);
  });

  test("loads a command-target task as shell action", () => {
    writeTask(stashDir, "health-check", `version: 2
schedule: "*/5 * * * *"
enabled: true
description: Health check every 5 minutes
tags: [openpalm]
command: ["sh","-c","openpalm status --json"]
`);

    const automations = loadAutomations(stashDir);
    expect(automations).toHaveLength(1);
    const a = automations[0];
    expect(a.name).toBe("health-check");
    expect(a.schedule).toBe("*/5 * * * *");
    expect(a.enabled).toBe(true);
    expect(a.description).toBe("Health check every 5 minutes");
    expect(a.action.type).toBe("shell");
    expect(a.fileName).toBe("health-check.yml");
  });

  test("loads a prompt-target task as assistant action", () => {
    writeTask(stashDir, "daily-brief", `version: 2
schedule: "0 8 * * *"
enabled: true
description: Daily briefing
prompt: Good morning. How are systems?
`);

    const automations = loadAutomations(stashDir);
    expect(automations).toHaveLength(1);
    const a = automations[0];
    expect(a.action.type).toBe("assistant");
    expect(a.action.content).toBe("Good morning. How are systems?");
  });

  test("respects enabled: false", () => {
    writeTask(stashDir, "disabled-task", `version: 2
schedule: "*/5 * * * *"
enabled: false
command: ["echo","hello"]
`);

    const automations = loadAutomations(stashDir);
    expect(automations).toHaveLength(1);
    expect(automations[0].enabled).toBe(false);
  });

  test("skips malformed task files without crashing", () => {
    writeTask(stashDir, "bad-task", `not valid frontmatter at all`);
    writeTask(stashDir, "good-task", `version: 2
schedule: "0 3 * * *"
command: ["akm","improve"]
`);

    const automations = loadAutomations(stashDir);
    expect(automations).toHaveLength(1);
    expect(automations[0].name).toBe("good-task");
  });

  test("loads multiple tasks", () => {
    writeTask(stashDir, "task-a", `version: 2\nschedule: "*/5 * * * *"\ncommand: ["echo","a"]\n`);
    writeTask(stashDir, "task-b", `version: 2\nschedule: "0 3 * * *"\ncommand: ["echo","b"]\n`);

    const automations = loadAutomations(stashDir);
    expect(automations).toHaveLength(2);
  });
});

// ── readAutomationLogs ───────────────────────────────────────────────────

describe("readAutomationLogs", () => {
  test("returns empty array when no log dir exists", () => {
    const lines = readAutomationLogs("health-check", dataDir, 50);
    expect(lines).toEqual([]);
  });

  test("reads lines from log files newest-first", () => {
    const logDir = join(dataDir, "akm", "cache", "tasks", "logs", "health-check");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "2026-05-15T03-00-00-000Z.log"), "line-old\n");
    writeFileSync(join(logDir, "2026-05-16T03-00-00-000Z.log"), "line-new\n");

    const lines = readAutomationLogs("health-check", dataDir, 50);
    expect(lines[0]).toBe("line-new");
    expect(lines[1]).toBe("line-old");
  });

  test("respects the limit parameter", () => {
    const logDir = join(dataDir, "akm", "cache", "tasks", "logs", "cleanup");
    mkdirSync(logDir, { recursive: true });
    const content = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
    writeFileSync(join(logDir, "2026-05-16T00-00-00-000Z.log"), content);

    const lines = readAutomationLogs("cleanup", dataDir, 5);
    expect(lines).toHaveLength(5);
  });

  test("strips .yml suffix from id", () => {
    const logDir = join(dataDir, "akm", "cache", "tasks", "logs", "health-check");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "2026-05-16T00-00-00-000Z.log"), "entry\n");

    const lines = readAutomationLogs("health-check.yml", dataDir, 50);
    expect(lines).toContain("entry");
  });
});
