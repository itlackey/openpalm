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
  "knowledge",      // knowledge source assets: skills/ and vaults/
  "data",       // empty service dirs (.gitkeep)
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

  test("registry/ no longer exists", () => {
    expect(existsSync(join(SKELETON_DIR, "registry"))).toBe(false);
  });

  test("stash-seeds/ no longer exists (moved to knowledge/)", () => {
    expect(existsSync(join(SKELETON_DIR, "stash-seeds"))).toBe(false);
  });
});

// ── power-user helper scripts ─────────────────────────────────────────

describe("skeleton: helper scripts", () => {
  test("openpalm.sh and openpalm.ps1 ship at the skeleton root", () => {
    expect(existsSync(join(SKELETON_DIR, "openpalm.sh"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "openpalm.ps1"))).toBe(true);
  });
});

// ── config/ subdirectory ──────────────────────────────────────────────

describe("skeleton: .openpalm/config/ structure", () => {
  test("config/stack/ exists with fixed compose files and stack.yml", () => {
    expect(existsSync(join(SKELETON_DIR, "config", "stack", "core.compose.yml"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "config", "stack", "services.compose.yml"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "config", "stack", "channels.compose.yml"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "config", "stack", "custom.compose.yml"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "config", "stack", "stack.yml"))).toBe(true);
  });

  test("config/stack/addons/ does not exist", () => {
    expect(existsSync(join(SKELETON_DIR, "config", "stack", "addons"))).toBe(false);
  });

  test("config/akm/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "config", "akm"))).toBe(true);
  });

  test("config/assistant/ has seed files", () => {
    expect(existsSync(join(SKELETON_DIR, "config", "assistant", "opencode.jsonc"))).toBe(true);
  });
});

// ── no runtime registry ───────────────────────────────────────────────

describe("skeleton: no runtime registry", () => {
  test("data/registry/ does not exist", () => {
    expect(existsSync(join(SKELETON_DIR, "data", "registry"))).toBe(false);
  });
});

// ── knowledge/ subdirectory ───────────────────────────────────────────────

describe("skeleton: .openpalm/knowledge/ structure", () => {
  test("knowledge/skills/ exists with config-diagnostics skill", () => {
    expect(existsSync(join(SKELETON_DIR, "knowledge", "skills", "config-diagnostics", "SKILL.md"))).toBe(true);
  });

  test("knowledge/vaults/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "knowledge", "vaults"))).toBe(true);
  });

  test("knowledge/tasks/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "knowledge", "tasks"))).toBe(true);
  });
});

// ── data/ service dirs ────────────────────────────────────────────────

describe("skeleton: .openpalm/data/ service directories", () => {
  const serviceDirs = ["assistant", "admin", "guardian"];

  for (const dir of serviceDirs) {
    test(`data/${dir}/ exists`, () => {
      expect(existsSync(join(SKELETON_DIR, "data", dir))).toBe(true);
    });
  }

  test("data/akm/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "data", "akm"))).toBe(true);
  });

  test("data/akm/cache and data/akm/data exist", () => {
    expect(existsSync(join(SKELETON_DIR, "data", "akm", "cache"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "data", "akm", "data"))).toBe(true);
  });

  test("data/logs/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "data", "logs"))).toBe(true);
  });
});

// ── data/rollback and workspace/ ──────────────────────────────────────

describe("skeleton: .openpalm/data/rollback and workspace/", () => {
  test("cache/ does not exist in the skeleton", () => {
    expect(existsSync(join(SKELETON_DIR, "cache"))).toBe(false);
  });

  test("data/backups/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "data", "backups"))).toBe(true);
  });

  test("data/rollback/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "data", "rollback"))).toBe(true);
  });

  test("workspace/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "workspace"))).toBe(true);
  });
});
