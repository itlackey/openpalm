/**
 * Skeleton guardrail tests — validate .openpalm/ directory structure matches v0.11.0.
 *
 * The .openpalm/ directory is the repo-shipped OP_HOME skeleton. These tests
 * prevent reintroduction of pre-v0.11.0 directories (stack/, registry/,
 * stash-seeds/) and ensure the v0.11.0 structure stays intact.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SKELETON_DIR = join(REPO_ROOT, ".openpalm");

// Allowed top-level dirs in .openpalm/ — mirrors the OP_HOME runtime layout
const ALLOWED_SOURCE_DIRS = new Set([
  "config",     // seed files for config/ (assistant, guardian, stack/, akm/)
  "stash",      // stash source assets: skills/ and vaults/
  "state",      // state/registry/ + empty service dirs (.gitkeep)
  "cache",      // empty cache dirs (.gitkeep — regenerable at runtime)
  "workspace",  // empty workspace dir (.gitkeep)
]);

// ── Top-level structure ───────────────────────────────────────────────

describe("skeleton: .openpalm/ top-level directories", () => {
  test("only allowed directories exist", () => {
    const entries = readdirSync(SKELETON_DIR);
    const dirs = entries.filter(e => {
      try { return statSync(join(SKELETON_DIR, e)).isDirectory(); } catch { return false; }
    });
    const unexpected = dirs.filter(d => !ALLOWED_SOURCE_DIRS.has(d));
    expect(unexpected).toEqual([]);
  });

  test("stack/ no longer exists (moved to config/stack/)", () => {
    expect(existsSync(join(SKELETON_DIR, "stack"))).toBe(false);
  });

  test("registry/ no longer exists (moved to state/registry/)", () => {
    expect(existsSync(join(SKELETON_DIR, "registry"))).toBe(false);
  });

  test("stash-seeds/ no longer exists (moved to stash/)", () => {
    expect(existsSync(join(SKELETON_DIR, "stash-seeds"))).toBe(false);
  });
});

// ── config/ subdirectory ──────────────────────────────────────────────

describe("skeleton: .openpalm/config/ structure", () => {
  test("config/stack/ exists with core.compose.yml and stack.yml", () => {
    expect(existsSync(join(SKELETON_DIR, "config", "stack", "core.compose.yml"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "config", "stack", "stack.yml"))).toBe(true);
  });

  test("config/stack/addons/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "config", "stack", "addons"))).toBe(true);
  });

  test("config/akm/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "config", "akm"))).toBe(true);
  });

  test("config/assistant/ has seed files", () => {
    expect(existsSync(join(SKELETON_DIR, "config", "assistant", "opencode.json"))).toBe(true);
  });
});

// ── state/registry/ subdirectory ─────────────────────────────────────

describe("skeleton: .openpalm/state/registry/ structure", () => {
  test("state/registry/addons/ exists with addon subdirectories", () => {
    const addonsDir = join(SKELETON_DIR, "state", "registry", "addons");
    expect(existsSync(addonsDir)).toBe(true);
    const addons = readdirSync(addonsDir);
    expect(addons).toContain("chat");
    expect(addons).toContain("api");
    expect(addons).toContain("discord");
  });

  test("state/registry/automations/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "state", "registry", "automations"))).toBe(true);
  });

  test("each addon has compose.yml", () => {
    const addonsDir = join(SKELETON_DIR, "state", "registry", "addons");
    const addons = readdirSync(addonsDir).filter(e => {
      try { return statSync(join(addonsDir, e)).isDirectory(); } catch { return false; }
    });
    for (const addon of addons) {
      expect(existsSync(join(addonsDir, addon, "compose.yml"))).toBe(true);
    }
  });
});

// ── stash/ subdirectory ───────────────────────────────────────────────

describe("skeleton: .openpalm/stash/ structure", () => {
  test("stash/skills/ exists with config-diagnostics skill", () => {
    expect(existsSync(join(SKELETON_DIR, "stash", "skills", "config-diagnostics", "SKILL.md"))).toBe(true);
  });

  test("stash/vaults/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "stash", "vaults"))).toBe(true);
  });

  test("stash/tasks/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "stash", "tasks"))).toBe(true);
  });
});

// ── state/ service dirs ───────────────────────────────────────────────

describe("skeleton: .openpalm/state/ service directories", () => {
  const serviceDirs = ["assistant", "admin", "guardian", "logs", "backups"];

  for (const dir of serviceDirs) {
    test(`state/${dir}/ exists`, () => {
      expect(existsSync(join(SKELETON_DIR, "state", dir))).toBe(true);
    });
  }

  test("state/akm/data/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "state", "akm", "data"))).toBe(true);
  });

  test("state/akm/state/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "state", "akm", "state"))).toBe(true);
  });

  test("state/logs/opencode/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "state", "logs", "opencode"))).toBe(true);
  });
});

// ── cache/ and workspace/ ─────────────────────────────────────────────

describe("skeleton: .openpalm/cache/ and workspace/", () => {
  test("cache/akm/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "cache", "akm"))).toBe(true);
  });

  test("cache/rollback/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "cache", "rollback"))).toBe(true);
  });

  test("workspace/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "workspace"))).toBe(true);
  });
});
