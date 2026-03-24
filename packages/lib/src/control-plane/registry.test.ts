/**
 * Tests for registry sync functions.
 *
 * Tests validation, discovery, and merged registry building.
 * Git operations are not tested here (they require network); these
 * tests focus on the pure logic: validation, discovery from filesystem,
 * and registry merging.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateBranch,
  validateRegistryUrl,
  isValidComponentName,
  getRegistryConfig,
  readLocalAutomations,
  listLocalAddonIds,
} from "./registry.js";

// ── Validation Tests ─────────────────────────────────────────────────

describe("validateBranch", () => {
  it("accepts 'main'", () => {
    expect(validateBranch("main")).toBe("main");
  });

  it("accepts 'feat/my-branch'", () => {
    expect(validateBranch("feat/my-branch")).toBe("feat/my-branch");
  });

  it("accepts branch with dots and underscores", () => {
    expect(validateBranch("release_1.0.0")).toBe("release_1.0.0");
  });

  it("rejects branch with '..'", () => {
    expect(() => validateBranch("main/../hack")).toThrow("contains '..'");
  });

  it("rejects branch with spaces", () => {
    expect(() => validateBranch("my branch")).toThrow("Invalid registry branch name");
  });

  it("rejects empty string", () => {
    expect(() => validateBranch("")).toThrow("Invalid registry branch name");
  });

  it("rejects branch with shell metacharacters", () => {
    expect(() => validateBranch("main;rm -rf /")).toThrow("Invalid registry branch name");
  });

  it("rejects branch with backticks", () => {
    expect(() => validateBranch("`whoami`")).toThrow("Invalid registry branch name");
  });
});

describe("validateRegistryUrl", () => {
  it("accepts https:// URLs", () => {
    expect(validateRegistryUrl("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git"
    );
  });

  it("accepts git@ URLs", () => {
    expect(validateRegistryUrl("git@github.com:org/repo.git")).toBe(
      "git@github.com:org/repo.git"
    );
  });

  it("rejects http:// URLs", () => {
    expect(() => validateRegistryUrl("http://github.com/repo.git")).toThrow(
      "Invalid registry URL"
    );
  });

  it("rejects file:// URLs", () => {
    expect(() => validateRegistryUrl("file:///etc/passwd")).toThrow("Invalid registry URL");
  });

  it("rejects empty string", () => {
    expect(() => validateRegistryUrl("")).toThrow("Invalid registry URL");
  });

  it("rejects arbitrary strings", () => {
    expect(() => validateRegistryUrl("not-a-url")).toThrow("Invalid registry URL");
  });
});

describe("isValidComponentName", () => {
  it("accepts lowercase alpha names", () => {
    expect(isValidComponentName("chat")).toBe(true);
  });

  it("accepts names with hyphens", () => {
    expect(isValidComponentName("my-channel")).toBe(true);
  });

  it("accepts names with digits", () => {
    expect(isValidComponentName("channel2")).toBe(true);
  });

  it("rejects uppercase", () => {
    expect(isValidComponentName("MyChannel")).toBe(false);
  });

  it("rejects names starting with hyphen", () => {
    expect(isValidComponentName("-bad")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidComponentName("")).toBe(false);
  });

  it("rejects names with dots", () => {
    expect(isValidComponentName("my.channel")).toBe(false);
  });

  it("rejects names longer than 63 chars", () => {
    expect(isValidComponentName("a".repeat(64))).toBe(false);
  });

  it("accepts names exactly 63 chars", () => {
    expect(isValidComponentName("a".repeat(63))).toBe(true);
  });
});

describe("getRegistryConfig", () => {
  const origUrl = process.env.OP_REGISTRY_URL;
  const origBranch = process.env.OP_REGISTRY_BRANCH;

  afterEach(() => {
    if (origUrl === undefined) delete process.env.OP_REGISTRY_URL;
    else process.env.OP_REGISTRY_URL = origUrl;
    if (origBranch === undefined) delete process.env.OP_REGISTRY_BRANCH;
    else process.env.OP_REGISTRY_BRANCH = origBranch;
  });

  it("returns defaults when env vars are unset", () => {
    delete process.env.OP_REGISTRY_URL;
    delete process.env.OP_REGISTRY_BRANCH;
    const config = getRegistryConfig();
    expect(config.repoUrl).toContain("github.com");
    expect(config.branch).toBe("main");
  });

  it("respects OP_REGISTRY_URL", () => {
    process.env.OP_REGISTRY_URL = "https://github.com/custom/repo.git";
    const config = getRegistryConfig();
    expect(config.repoUrl).toBe("https://github.com/custom/repo.git");
  });

  it("respects OP_REGISTRY_BRANCH", () => {
    process.env.OP_REGISTRY_BRANCH = "develop";
    const config = getRegistryConfig();
    expect(config.branch).toBe("develop");
  });

  it("throws on invalid branch in env", () => {
    process.env.OP_REGISTRY_BRANCH = "main;exploit";
    expect(() => getRegistryConfig()).toThrow("Invalid registry branch name");
  });

  it("throws on invalid URL in env", () => {
    process.env.OP_REGISTRY_URL = "ftp://bad.com/repo";
    expect(() => getRegistryConfig()).toThrow("Invalid registry URL");
  });
});

// ── Filesystem Discovery Tests ───────────────────────────────────────

describe("readLocalAutomations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object when automations dir does not exist", () => {
    const result = readLocalAutomations(tmpDir);
    expect(result).toEqual({});
  });

  it("discovers .yml files in automations dir", () => {
    const autoDir = join(tmpDir, "automations");
    mkdirSync(autoDir, { recursive: true });
    writeFileSync(join(autoDir, "daily-backup.yml"), "schedule: daily\ndescription: Backup");
    writeFileSync(join(autoDir, "weekly-report.yml"), "schedule: weekly\ndescription: Report");

    const result = readLocalAutomations(tmpDir);
    expect(Object.keys(result).sort()).toEqual(["daily-backup", "weekly-report"]);
    expect(result["daily-backup"]).toContain("schedule: daily");
  });

  it("ignores non-yml files", () => {
    const autoDir = join(tmpDir, "automations");
    mkdirSync(autoDir, { recursive: true });
    writeFileSync(join(autoDir, "valid.yml"), "schedule: daily");
    writeFileSync(join(autoDir, "readme.md"), "not an automation");
    writeFileSync(join(autoDir, "data.json"), "{}");

    const result = readLocalAutomations(tmpDir);
    expect(Object.keys(result)).toEqual(["valid"]);
  });
});

describe("listLocalAddonIds", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when stack/addons does not exist", () => {
    const result = listLocalAddonIds(tmpDir);
    expect(result).toEqual([]);
  });

  it("lists addon directories", () => {
    const addonsDir = join(tmpDir, "stack", "addons");
    mkdirSync(join(addonsDir, "chat"), { recursive: true });
    mkdirSync(join(addonsDir, "discord"), { recursive: true });

    const result = listLocalAddonIds(tmpDir);
    expect(result.sort()).toEqual(["chat", "discord"]);
  });

  it("ignores files (only lists directories)", () => {
    const addonsDir = join(tmpDir, "stack", "addons");
    mkdirSync(join(addonsDir, "chat"), { recursive: true });
    mkdirSync(addonsDir, { recursive: true });
    writeFileSync(join(addonsDir, "readme.md"), "not an addon");

    const result = listLocalAddonIds(tmpDir);
    expect(result).toEqual(["chat"]);
  });
});
