/**
 * overwriteSystemTree — blind-overwrites the entire managed `system/` tree from
 * the release skeleton on every install/update (constitution §1), backing up a
 * changed copy first. Unchanged files are skipped. User trees, data/, and state/
 * are NEVER touched here — they are seeded once by seedOpenPalmDir's
 * skip-existing copy (covered in ui-assets.test.ts), so they are not tested here.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { overwriteSystemTree } from "./core-assets.js";

let tmpRoot = "";
let opHome = "";
let sourceRoot = "";

// A representative slice of the managed system/ tree: the compose stack plus a
// nested system OpenCode config file (the two managed asset classes §1 names).
const MANAGED_FILES = [
  "system/stack/core.compose.yml",
  "system/stack/services.compose.yml",
  "system/stack/portals.compose.yml",
  "system/assistant/opencode.jsonc",
];

function seedSource(content: string): void {
  for (const rel of MANAGED_FILES) {
    const p = join(sourceRoot, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "core-assets-test-"));
  opHome = join(tmpRoot, "ophome");
  sourceRoot = join(tmpRoot, "src");
  mkdirSync(opHome, { recursive: true });
  process.env.OP_HOME = opHome;
});

afterEach(() => {
  delete process.env.OP_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("overwriteSystemTree", () => {
  const first = MANAGED_FILES[0]!;

  it("writes every managed system/ file when absent", () => {
    seedSource("# fresh\n");
    const { updated, backupDir } = overwriteSystemTree(sourceRoot, opHome);
    for (const rel of MANAGED_FILES) {
      expect(existsSync(join(opHome, rel))).toBe(true);
      expect(updated).toContain(rel);
    }
    expect(backupDir).toBeNull();
  });

  it("overwrites a changed file and backs up the old copy", () => {
    seedSource("old\n");
    overwriteSystemTree(sourceRoot, opHome);
    seedSource("new\n");
    const { updated, backupDir } = overwriteSystemTree(sourceRoot, opHome);
    expect(readFileSync(join(opHome, first), "utf-8")).toBe("new\n");
    expect(updated).toContain(first);
    expect(backupDir).not.toBeNull();
    expect(readFileSync(join(backupDir!, first), "utf-8")).toBe("old\n");
  });

  it("skips when on-disk content already matches the source", () => {
    seedSource("same\n");
    overwriteSystemTree(sourceRoot, opHome);
    const { updated, backupDir } = overwriteSystemTree(sourceRoot, opHome);
    expect(updated).toHaveLength(0);
    expect(backupDir).toBeNull();
  });

  it("no-ops when the source has no system/ tree", () => {
    const { updated, backupDir } = overwriteSystemTree(sourceRoot, opHome);
    expect(updated).toHaveLength(0);
    expect(backupDir).toBeNull();
  });
});
