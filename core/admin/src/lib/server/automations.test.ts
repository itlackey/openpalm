/**
 * Tests for automations.ts — discovery, merge, staging, validation, CRUD.
 *
 * Follows the control-plane.test.ts pattern: temp directories,
 * no mocking of the filesystem.
 */
import { describe, test, expect, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateAutomationJob,
  discoverUserJobs,
  discoverSystemJobs,
  mergeJobs,
  stageAutomations,
  ensureDefaultAutomations,
  readUserAutomationsConfig,
  writeUserAutomationsConfig,
  addUserJob,
  updateUserJob,
  removeUserJob,
  overrideSystemJob,
  getNextRunTime,
  getNextRunTimes,
  type AutomationJob,
  type AutomationRuntimeState
} from "./automations.js";

import type { ControlPlaneState } from "./control-plane.js";

// ── Test helpers ────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-auto-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let tempDirs: string[] = [];

function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeTestState(overrides: Partial<ControlPlaneState> = {}): ControlPlaneState {
  const stateDir = trackDir(makeTempDir());
  const configDir = trackDir(makeTempDir());
  const dataDir = trackDir(makeTempDir());
  mkdirSync(`${stateDir}/artifacts`, { recursive: true });
  return {
    adminToken: "test-admin-token",
    setupToken: "test-setup-token",
    postgresPassword: "test-pg-password",
    stateDir,
    configDir,
    dataDir,
    services: {},
    installedExtensions: new Set<string>(),
    artifacts: { compose: "", caddyfile: "" },
    artifactMeta: [],
    audit: [],
    channelSecrets: {},
    automations: {
      jobs: [],
      history: [],
      schedulerActive: false,
    },
    ...overrides,
  };
}

function makeValidJob(overrides: Partial<AutomationJob> = {}): AutomationJob {
  return {
    id: "test-job",
    name: "Test Job",
    schedule: "0 9 * * *",
    prompt: "Run a test",
    enabled: true,
    ...overrides,
  };
}

function writeAutomationsFile(dir: string, jobs: AutomationJob[]): void {
  writeFileSync(
    join(dir, "automations.json"),
    JSON.stringify({ jobs }, null, 2)
  );
}

// ── validateAutomationJob ──────────────────────────────────────────────

describe("validateAutomationJob", () => {
  test("validates a correct job", () => {
    const result = validateAutomationJob(makeValidJob());
    expect(result.ok).toBe(true);
  });

  test("rejects non-object", () => {
    expect(validateAutomationJob(null).ok).toBe(false);
    expect(validateAutomationJob("string").ok).toBe(false);
    expect(validateAutomationJob(42).ok).toBe(false);
  });

  test("rejects invalid id", () => {
    expect(validateAutomationJob(makeValidJob({ id: "" })).ok).toBe(false);
    expect(validateAutomationJob(makeValidJob({ id: "UPPERCASE" })).ok).toBe(false);
    expect(validateAutomationJob(makeValidJob({ id: "-leading-hyphen" })).ok).toBe(false);
    expect(validateAutomationJob(makeValidJob({ id: "a".repeat(64) })).ok).toBe(false);
  });

  test("rejects empty name", () => {
    expect(validateAutomationJob(makeValidJob({ name: "" })).ok).toBe(false);
    expect(validateAutomationJob(makeValidJob({ name: "  " })).ok).toBe(false);
  });

  test("rejects invalid cron expression", () => {
    expect(validateAutomationJob(makeValidJob({ schedule: "invalid" })).ok).toBe(false);
    expect(validateAutomationJob(makeValidJob({ schedule: "60 * * * *" })).ok).toBe(false);
  });

  test("rejects empty prompt", () => {
    expect(validateAutomationJob(makeValidJob({ prompt: "" })).ok).toBe(false);
  });

  test("rejects non-boolean enabled", () => {
    const job = { ...makeValidJob(), enabled: "yes" as unknown as boolean };
    expect(validateAutomationJob(job).ok).toBe(false);
  });

  test("rejects invalid timeoutMs", () => {
    expect(validateAutomationJob(makeValidJob({ timeoutMs: 500 })).ok).toBe(false);
    expect(validateAutomationJob(makeValidJob({ timeoutMs: -1 })).ok).toBe(false);
  });

  test("accepts valid optional fields", () => {
    const result = validateAutomationJob(
      makeValidJob({ description: "A test job", timeoutMs: 60000 })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job.description).toBe("A test job");
      expect(result.job.timeoutMs).toBe(60000);
    }
  });

  test("strips source field from validated job", () => {
    const result = validateAutomationJob(
      makeValidJob({ source: "system" })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job.source).toBeUndefined();
    }
  });
});

// ── discoverUserJobs / discoverSystemJobs ──────────────────────────────

describe("discoverUserJobs", () => {
  test("returns empty array when file does not exist", () => {
    const dir = trackDir(makeTempDir());
    expect(discoverUserJobs(dir)).toEqual([]);
  });

  test("returns jobs from valid file", () => {
    const dir = trackDir(makeTempDir());
    writeAutomationsFile(dir, [makeValidJob()]);
    const jobs = discoverUserJobs(dir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("test-job");
    expect(jobs[0].source).toBe("user");
  });

  test("skips invalid jobs and returns valid ones", () => {
    const dir = trackDir(makeTempDir());
    writeFileSync(
      join(dir, "automations.json"),
      JSON.stringify({
        jobs: [
          makeValidJob({ id: "valid-job" }),
          { id: "INVALID", name: "", schedule: "bad", prompt: "", enabled: "no" },
        ],
      })
    );
    const jobs = discoverUserJobs(dir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("valid-job");
  });

  test("returns empty array on malformed JSON", () => {
    const dir = trackDir(makeTempDir());
    writeFileSync(join(dir, "automations.json"), "not valid json");
    expect(discoverUserJobs(dir)).toEqual([]);
  });

  test("returns empty array when jobs is not an array", () => {
    const dir = trackDir(makeTempDir());
    writeFileSync(join(dir, "automations.json"), JSON.stringify({ jobs: "not-array" }));
    expect(discoverUserJobs(dir)).toEqual([]);
  });
});

describe("discoverSystemJobs", () => {
  test("tags jobs with source: system", () => {
    const dir = trackDir(makeTempDir());
    writeAutomationsFile(dir, [makeValidJob({ id: "sys-job" })]);
    const jobs = discoverSystemJobs(dir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].source).toBe("system");
  });
});

// ── mergeJobs ──────────────────────────────────────────────────────────

describe("mergeJobs", () => {
  test("combines disjoint user and system jobs", () => {
    const userJobs = [makeValidJob({ id: "user-job" })];
    const systemJobs = [makeValidJob({ id: "system-job" })];
    const merged = mergeJobs(userJobs, systemJobs);
    expect(merged).toHaveLength(2);
  });

  test("user job overrides system job with same id", () => {
    const userJobs = [makeValidJob({ id: "shared", name: "User Version", enabled: false })];
    const systemJobs = [makeValidJob({ id: "shared", name: "System Version", enabled: true })];
    const merged = mergeJobs(userJobs, systemJobs);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("User Version");
    expect(merged[0].enabled).toBe(false);
    expect(merged[0].source).toBe("user");
  });

  test("preserves all system jobs when no overlap", () => {
    const userJobs: AutomationJob[] = [];
    const systemJobs = [
      makeValidJob({ id: "sys-1" }),
      makeValidJob({ id: "sys-2" }),
    ];
    const merged = mergeJobs(userJobs, systemJobs);
    expect(merged).toHaveLength(2);
    expect(merged.every((j) => j.source === "system")).toBe(true);
  });
});

// ── stageAutomations ───────────────────────────────────────────────────

describe("stageAutomations", () => {
  test("writes merged automations.json to STATE_HOME/artifacts", () => {
    const state = makeTestState();
    writeAutomationsFile(state.configDir, [makeValidJob({ id: "user-1" })]);
    writeAutomationsFile(state.dataDir, [makeValidJob({ id: "sys-1" })]);

    stageAutomations(state);

    const stagedPath = join(state.stateDir, "artifacts", "automations.json");
    expect(existsSync(stagedPath)).toBe(true);

    const staged = JSON.parse(readFileSync(stagedPath, "utf-8"));
    expect(staged.jobs).toHaveLength(2);
  });

  test("updates in-memory state.automations.jobs", () => {
    const state = makeTestState();
    writeAutomationsFile(state.configDir, [makeValidJob({ id: "mem-job" })]);

    stageAutomations(state);

    expect(state.automations.jobs).toHaveLength(1);
    expect(state.automations.jobs[0].id).toBe("mem-job");
  });

  test("handles missing config files gracefully", () => {
    const state = makeTestState();
    // No automations.json in either dir
    stageAutomations(state);

    expect(state.automations.jobs).toEqual([]);
    const stagedPath = join(state.stateDir, "artifacts", "automations.json");
    const staged = JSON.parse(readFileSync(stagedPath, "utf-8"));
    expect(staged.jobs).toEqual([]);
  });

  test("is idempotent", () => {
    const state = makeTestState();
    writeAutomationsFile(state.configDir, [makeValidJob()]);

    stageAutomations(state);
    const first = readFileSync(join(state.stateDir, "artifacts", "automations.json"), "utf-8");

    stageAutomations(state);
    const second = readFileSync(join(state.stateDir, "artifacts", "automations.json"), "utf-8");

    expect(first).toBe(second);
  });
});

// ── ensureDefaultAutomations ───────────────────────────────────────────

describe("ensureDefaultAutomations", () => {
  test("creates DATA_HOME/automations.json when missing", () => {
    const dir = trackDir(makeTempDir());
    ensureDefaultAutomations(dir);
    expect(existsSync(join(dir, "automations.json"))).toBe(true);
  });

  test("does not overwrite existing file", () => {
    const dir = trackDir(makeTempDir());
    const customContent = JSON.stringify({ jobs: [makeValidJob({ id: "custom" })] });
    writeFileSync(join(dir, "automations.json"), customContent);

    ensureDefaultAutomations(dir);

    const content = readFileSync(join(dir, "automations.json"), "utf-8");
    expect(content).toBe(customContent);
  });

  test("seeded file contains valid jobs", () => {
    const dir = trackDir(makeTempDir());
    ensureDefaultAutomations(dir);

    const content = JSON.parse(readFileSync(join(dir, "automations.json"), "utf-8"));
    expect(Array.isArray(content.jobs)).toBe(true);
    expect(content.jobs.length).toBeGreaterThan(0);

    for (const job of content.jobs) {
      const result = validateAutomationJob(job);
      expect(result.ok).toBe(true);
    }
  });
});

// ── User Config CRUD ───────────────────────────────────────────────────

describe("readUserAutomationsConfig", () => {
  test("returns empty config when file missing", () => {
    const dir = trackDir(makeTempDir());
    const config = readUserAutomationsConfig(dir);
    expect(config.jobs).toEqual([]);
  });

  test("returns parsed config from file", () => {
    const dir = trackDir(makeTempDir());
    writeAutomationsFile(dir, [makeValidJob()]);
    const config = readUserAutomationsConfig(dir);
    expect(config.jobs).toHaveLength(1);
  });
});

describe("addUserJob", () => {
  test("adds a job to empty config", () => {
    const dir = trackDir(makeTempDir());
    const err = addUserJob(dir, makeValidJob({ id: "new-job" }));
    expect(err).toBeNull();

    const config = readUserAutomationsConfig(dir);
    expect(config.jobs).toHaveLength(1);
    expect(config.jobs[0].id).toBe("new-job");
  });

  test("rejects duplicate id", () => {
    const dir = trackDir(makeTempDir());
    writeAutomationsFile(dir, [makeValidJob({ id: "dup" })]);

    const err = addUserJob(dir, makeValidJob({ id: "dup" }));
    expect(err).toContain("already exists");
  });
});

describe("updateUserJob", () => {
  test("updates existing job", () => {
    const dir = trackDir(makeTempDir());
    writeAutomationsFile(dir, [makeValidJob({ id: "upd", name: "Old Name" })]);

    const err = updateUserJob(dir, "upd", { name: "New Name" });
    expect(err).toBeNull();

    const config = readUserAutomationsConfig(dir);
    expect(config.jobs[0].name).toBe("New Name");
    expect(config.jobs[0].id).toBe("upd"); // id unchanged
  });

  test("returns error for nonexistent job", () => {
    const dir = trackDir(makeTempDir());
    const err = updateUserJob(dir, "nonexistent", { name: "X" });
    expect(err).toContain("not found");
  });
});

describe("removeUserJob", () => {
  test("removes existing job", () => {
    const dir = trackDir(makeTempDir());
    writeAutomationsFile(dir, [
      makeValidJob({ id: "keep" }),
      makeValidJob({ id: "remove" }),
    ]);

    const err = removeUserJob(dir, "remove");
    expect(err).toBeNull();

    const config = readUserAutomationsConfig(dir);
    expect(config.jobs).toHaveLength(1);
    expect(config.jobs[0].id).toBe("keep");
  });

  test("returns error for nonexistent job", () => {
    const dir = trackDir(makeTempDir());
    const err = removeUserJob(dir, "nonexistent");
    expect(err).toContain("not found");
  });
});

describe("overrideSystemJob", () => {
  test("creates override entry for system job", () => {
    const configDir = trackDir(makeTempDir());
    const dataDir = trackDir(makeTempDir());
    writeAutomationsFile(dataDir, [makeValidJob({ id: "sys-job", enabled: true })]);

    const err = overrideSystemJob(configDir, dataDir, "sys-job", { enabled: false });
    expect(err).toBeNull();

    const config = readUserAutomationsConfig(configDir);
    expect(config.jobs).toHaveLength(1);
    expect(config.jobs[0].id).toBe("sys-job");
    expect(config.jobs[0].enabled).toBe(false);
  });

  test("updates existing override", () => {
    const configDir = trackDir(makeTempDir());
    const dataDir = trackDir(makeTempDir());
    writeAutomationsFile(dataDir, [makeValidJob({ id: "sys-job" })]);
    writeAutomationsFile(configDir, [makeValidJob({ id: "sys-job", enabled: false })]);

    const err = overrideSystemJob(configDir, dataDir, "sys-job", { enabled: true });
    expect(err).toBeNull();

    const config = readUserAutomationsConfig(configDir);
    expect(config.jobs[0].enabled).toBe(true);
  });

  test("returns error for nonexistent system job", () => {
    const configDir = trackDir(makeTempDir());
    const dataDir = trackDir(makeTempDir());

    const err = overrideSystemJob(configDir, dataDir, "nonexistent", { enabled: false });
    expect(err).toContain("not found");
  });
});

// ── Query Helpers ──────────────────────────────────────────────────────

describe("getNextRunTime", () => {
  test("returns ISO string for enabled job", () => {
    const job = makeValidJob({ schedule: "* * * * *", enabled: true });
    const next = getNextRunTime(job);
    expect(next).not.toBeNull();
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now());
  });

  test("returns null for disabled job", () => {
    const job = makeValidJob({ enabled: false });
    expect(getNextRunTime(job)).toBeNull();
  });
});

describe("getNextRunTimes", () => {
  test("returns map of job id to next run time", () => {
    const jobs = [
      makeValidJob({ id: "job-a", schedule: "* * * * *", enabled: true }),
      makeValidJob({ id: "job-b", schedule: "* * * * *", enabled: true }),
      makeValidJob({ id: "job-c", enabled: false }),
    ];
    const times = getNextRunTimes(jobs);
    expect(times["job-a"]).toBeDefined();
    expect(times["job-b"]).toBeDefined();
    expect(times["job-c"]).toBeUndefined();
  });
});
