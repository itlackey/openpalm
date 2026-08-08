/**
 * overwriteSystemTree — blind-overwrites the entire managed `system/` tree from
 * the release skeleton on every install/update (constitution §1), backing up a
 * changed copy first. Unchanged files are skipped. User trees, data/, and state/
 * are NEVER touched here — they are seeded once by applyHomeSeed's
 * skip-existing copy, so they are not tested here.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
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
] as const;

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
  const first = MANAGED_FILES[0];

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
    if (backupDir === null) return; // narrow for TS; the expect above already failed the test if null
    expect(readFileSync(join(backupDir, first), "utf-8")).toBe("old\n");
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

  it("removes managed files retired by the new release", () => {
    seedSource("old\n");
    overwriteSystemTree(sourceRoot, opHome);
    const retired = join(opHome, "system", "retired.compose.yml");
    writeFileSync(retired, "retired\n");
    rmSync(join(sourceRoot, "system", "stack", "portals.compose.yml"));
    // A genuine content change accompanies the retirement — retirement alone
    // (a target-only extra) deliberately does not trigger an overwrite.
    writeFileSync(join(sourceRoot, first), "new\n");

    const result = overwriteSystemTree(sourceRoot, opHome);

    expect(existsSync(retired)).toBe(false);
    expect(existsSync(join(opHome, "system", "stack", "portals.compose.yml"))).toBe(false);
    expect(result.updated).toContain("system/retired.compose.yml");
    expect(result.updated).toContain("system/stack/portals.compose.yml");
  });

	it("allows runtime plugin symlinks in the managed assistant tree", () => {
		seedSource("old\n");
		overwriteSystemTree(sourceRoot, opHome);
		const binDir = join(opHome, "system", "assistant", "node_modules", ".bin");
		const target = join(opHome, "system", "assistant", "node_modules", "download-msgpackr-prebuilds.js");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(target, "runtime dependency\n");
		symlinkSync("../download-msgpackr-prebuilds.js", join(binDir, "download-msgpackr-prebuilds"));
		seedSource("new\n"); // a genuine skeleton change: the overwrite replaces the tree, extras included

		expect(() => overwriteSystemTree(sourceRoot, opHome)).not.toThrow();
		expect(existsSync(join(opHome, "system", "assistant", "node_modules"))).toBe(false);
	});

	it("is a no-op when the skeleton is unchanged, even with extra runtime files in the tree", () => {
		seedSource("same\n");
		overwriteSystemTree(sourceRoot, opHome);
		const nodeModules = join(opHome, "system", "assistant", "node_modules");
		mkdirSync(nodeModules, { recursive: true });
		writeFileSync(join(nodeModules, "runtime.js"), "runtime dependency\n");

		const { updated, backupDir } = overwriteSystemTree(sourceRoot, opHome);

		expect(updated).toHaveLength(0);
		expect(backupDir).toBeNull();
		expect(existsSync(join(nodeModules, "runtime.js"))).toBe(true);
		expect(existsSync(join(opHome, "data", "backups"))).toBe(false);
	});
});
