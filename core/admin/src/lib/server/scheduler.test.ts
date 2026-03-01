/**
 * Tests for the in-process automation scheduler.
 *
 * Verifies:
 * 1. YAML parsing and validation (valid, invalid, defaults)
 * 2. Schedule preset resolution
 * 3. Automation loading from directory
 * 4. Scheduler start/stop lifecycle
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAutomationYaml,
  resolveSchedule,
  SCHEDULE_PRESETS,
  loadAutomations,
  startScheduler,
  stopScheduler,
  getSchedulerStatus
} from "./scheduler.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-sched-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── parseAutomationYaml ──────────────────────────────────────────────

describe("parseAutomationYaml", () => {
  test("parses valid api automation", () => {
    const yaml = `
name: Health Check
description: Monitor services
schedule: "*/5 * * * *"
enabled: true
action:
  type: api
  method: GET
  path: /health
`;
    const config = parseAutomationYaml(yaml, "health-check.yml");
    expect(config).not.toBeNull();
    expect(config!.name).toBe("Health Check");
    expect(config!.description).toBe("Monitor services");
    expect(config!.schedule).toBe("*/5 * * * *");
    expect(config!.enabled).toBe(true);
    expect(config!.action.type).toBe("api");
    expect(config!.action.method).toBe("GET");
    expect(config!.action.path).toBe("/health");
    expect(config!.timezone).toBe("UTC");
    expect(config!.on_failure).toBe("log");
  });

  test("parses valid http automation", () => {
    const yaml = `
schedule: daily-8am
action:
  type: http
  method: POST
  url: http://channel-chat:8181/v1/chat/completions
  body:
    model: default
    messages:
      - role: user
        content: Good morning
`;
    const config = parseAutomationYaml(yaml, "prompt.yml");
    expect(config).not.toBeNull();
    expect(config!.action.type).toBe("http");
    expect(config!.action.url).toBe("http://channel-chat:8181/v1/chat/completions");
    expect(config!.action.body).toEqual({
      model: "default",
      messages: [{ role: "user", content: "Good morning" }]
    });
    // preset should be resolved
    expect(config!.schedule).toBe("0 8 * * *");
  });

  test("parses valid shell automation", () => {
    const yaml = `
schedule: weekly-sunday-4am
action:
  type: shell
  command:
    - /bin/bash
    - -c
    - "tail -n 10000 /state/audit/audit.jsonl > /tmp/audit.tmp && mv /tmp/audit.tmp /state/audit/audit.jsonl"
`;
    const config = parseAutomationYaml(yaml, "cleanup.yml");
    expect(config).not.toBeNull();
    expect(config!.action.type).toBe("shell");
    expect(config!.action.command).toEqual([
      "/bin/bash",
      "-c",
      "tail -n 10000 /state/audit/audit.jsonl > /tmp/audit.tmp && mv /tmp/audit.tmp /state/audit/audit.jsonl"
    ]);
    expect(config!.schedule).toBe("0 4 * * 0");
  });

  test("applies defaults for optional fields", () => {
    const yaml = `
schedule: "0 0 * * *"
action:
  type: api
  path: /health
`;
    const config = parseAutomationYaml(yaml, "minimal.yml");
    expect(config).not.toBeNull();
    expect(config!.name).toBe("minimal");
    expect(config!.description).toBe("");
    expect(config!.timezone).toBe("UTC");
    expect(config!.enabled).toBe(true);
    expect(config!.on_failure).toBe("log");
    expect(config!.action.method).toBe("GET");
    expect(config!.action.timeout).toBe(30_000);
  });

  test("respects enabled: false", () => {
    const yaml = `
schedule: daily
enabled: false
action:
  type: api
  path: /health
`;
    const config = parseAutomationYaml(yaml, "disabled.yml");
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(false);
  });

  test("respects on_failure: audit", () => {
    const yaml = `
schedule: daily
on_failure: audit
action:
  type: api
  path: /health
`;
    const config = parseAutomationYaml(yaml, "audit.yml");
    expect(config).not.toBeNull();
    expect(config!.on_failure).toBe("audit");
  });

  test("rejects missing schedule", () => {
    const yaml = `
action:
  type: api
  path: /health
`;
    expect(parseAutomationYaml(yaml, "no-schedule.yml")).toBeNull();
  });

  test("rejects empty schedule", () => {
    const yaml = `
schedule: ""
action:
  type: api
  path: /health
`;
    expect(parseAutomationYaml(yaml, "empty-schedule.yml")).toBeNull();
  });

  test("rejects missing action", () => {
    const yaml = `
schedule: daily
`;
    expect(parseAutomationYaml(yaml, "no-action.yml")).toBeNull();
  });

  test("rejects invalid action type", () => {
    const yaml = `
schedule: daily
action:
  type: webhook
  url: http://example.com
`;
    expect(parseAutomationYaml(yaml, "bad-type.yml")).toBeNull();
  });

  test("rejects api action without path", () => {
    const yaml = `
schedule: daily
action:
  type: api
  method: GET
`;
    expect(parseAutomationYaml(yaml, "api-no-path.yml")).toBeNull();
  });

  test("rejects http action without url", () => {
    const yaml = `
schedule: daily
action:
  type: http
  method: GET
`;
    expect(parseAutomationYaml(yaml, "http-no-url.yml")).toBeNull();
  });

  test("rejects shell action without command", () => {
    const yaml = `
schedule: daily
action:
  type: shell
`;
    expect(parseAutomationYaml(yaml, "shell-no-cmd.yml")).toBeNull();
  });

  test("rejects shell action with empty command array", () => {
    const yaml = `
schedule: daily
action:
  type: shell
  command: []
`;
    expect(parseAutomationYaml(yaml, "shell-empty-cmd.yml")).toBeNull();
  });

  test("rejects invalid YAML syntax", () => {
    const yaml = `schedule: [invalid: yaml: :::`;
    expect(parseAutomationYaml(yaml, "bad-yaml.yml")).toBeNull();
  });

  test("rejects non-object YAML (scalar)", () => {
    expect(parseAutomationYaml("just a string", "scalar.yml")).toBeNull();
  });

  test("preserves custom timezone", () => {
    const yaml = `
schedule: daily
timezone: America/New_York
action:
  type: api
  path: /health
`;
    const config = parseAutomationYaml(yaml, "tz.yml");
    expect(config!.timezone).toBe("America/New_York");
  });

  test("preserves custom headers", () => {
    const yaml = `
schedule: daily
action:
  type: http
  method: POST
  url: http://example.com/hook
  headers:
    Authorization: "Bearer token123"
    X-Custom: "value"
`;
    const config = parseAutomationYaml(yaml, "headers.yml");
    expect(config!.action.headers).toEqual({
      Authorization: "Bearer token123",
      "X-Custom": "value"
    });
  });
});

// ── resolveSchedule ──────────────────────────────────────────────────

describe("resolveSchedule", () => {
  test("resolves all presets correctly", () => {
    for (const [name, cron] of Object.entries(SCHEDULE_PRESETS)) {
      expect(resolveSchedule(name)).toBe(cron);
    }
  });

  test("passes through raw cron expressions unchanged", () => {
    expect(resolveSchedule("0 2 * * *")).toBe("0 2 * * *");
    expect(resolveSchedule("*/10 * * * *")).toBe("*/10 * * * *");
  });

  test("unknown preset name passes through as cron expression", () => {
    expect(resolveSchedule("every-second")).toBe("every-second");
  });
});

// ── loadAutomations ──────────────────────────────────────────────────

describe("loadAutomations", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("loads .yml files from automations dir", () => {
    const dir = join(stateDir, "automations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "health.yml"),
      'schedule: every-5-minutes\naction:\n  type: api\n  path: /health\n'
    );
    writeFileSync(
      join(dir, "update.yml"),
      'schedule: weekly\naction:\n  type: api\n  method: POST\n  path: /admin/containers/pull\n'
    );

    const configs = loadAutomations(stateDir);
    expect(configs.length).toBe(2);
  });

  test("ignores non-.yml files", () => {
    const dir = join(stateDir, "automations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "health.yml"),
      'schedule: daily\naction:\n  type: api\n  path: /health\n'
    );
    // Old crontab-style file — should be ignored
    writeFileSync(join(dir, "old-crontab"), "0 2 * * * node /work/task.sh\n");

    const configs = loadAutomations(stateDir);
    expect(configs.length).toBe(1);
    expect(configs[0].fileName).toBe("health.yml");
  });

  test("skips invalid YAML files", () => {
    const dir = join(stateDir, "automations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.yml"), "schedule: [invalid: yaml: :::");
    writeFileSync(
      join(dir, "good.yml"),
      'schedule: daily\naction:\n  type: api\n  path: /health\n'
    );

    const configs = loadAutomations(stateDir);
    expect(configs.length).toBe(1);
    expect(configs[0].fileName).toBe("good.yml");
  });

  test("returns empty array when dir does not exist", () => {
    const configs = loadAutomations(join(stateDir, "nonexistent"));
    expect(configs.length).toBe(0);
  });

  test("returns empty array when automations dir is empty", () => {
    mkdirSync(join(stateDir, "automations"), { recursive: true });
    const configs = loadAutomations(stateDir);
    expect(configs.length).toBe(0);
  });
});

// ── Scheduler lifecycle ─────────────────────────────────────────────

describe("scheduler lifecycle", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTempDir();
    stopScheduler(); // ensure clean state
  });

  afterEach(() => {
    stopScheduler();
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("startScheduler creates jobs for enabled automations", () => {
    const dir = join(stateDir, "automations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "health.yml"),
      'schedule: every-5-minutes\naction:\n  type: api\n  path: /health\n'
    );
    writeFileSync(
      join(dir, "disabled.yml"),
      'schedule: daily\nenabled: false\naction:\n  type: api\n  path: /health\n'
    );

    startScheduler(stateDir, "test-token");
    const status = getSchedulerStatus();
    expect(status.jobCount).toBe(1);
    expect(status.jobs[0].name).toBe("health");
    expect(status.jobs[0].running).toBe(true);
  });

  test("stopScheduler clears all jobs", () => {
    const dir = join(stateDir, "automations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "health.yml"),
      'schedule: every-5-minutes\naction:\n  type: api\n  path: /health\n'
    );

    startScheduler(stateDir, "test-token");
    expect(getSchedulerStatus().jobCount).toBe(1);

    stopScheduler();
    expect(getSchedulerStatus().jobCount).toBe(0);
  });

  test("getSchedulerStatus returns empty when no jobs", () => {
    const status = getSchedulerStatus();
    expect(status.jobCount).toBe(0);
    expect(status.jobs).toEqual([]);
  });

  test("startScheduler handles empty automations dir gracefully", () => {
    mkdirSync(join(stateDir, "automations"), { recursive: true });
    startScheduler(stateDir, "test-token");
    expect(getSchedulerStatus().jobCount).toBe(0);
  });

  test("startScheduler handles missing automations dir gracefully", () => {
    startScheduler(stateDir, "test-token");
    expect(getSchedulerStatus().jobCount).toBe(0);
  });
});
