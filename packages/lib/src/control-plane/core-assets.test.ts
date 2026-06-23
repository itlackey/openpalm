/**
 * refreshCoreAssetsFromSource — refreshes the system-owned stack compose files
 * from the bundled skeleton on every reconcile (overwrite, backing up a changed
 * copy first). Everything else is seeded once by seedOpenPalmDir's skip-existing
 * skeleton copy (covered in ui-assets.test.ts), so it is intentionally NOT here.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { refreshCoreAssetsFromSource, MANAGED_ASSETS } from "./core-assets.js";

let tmpRoot = "";
let opHome = "";
let sourceRoot = "";

function seedSource(content: string): void {
  for (const { relPath } of MANAGED_ASSETS) {
    const p = join(sourceRoot, relPath);
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

describe("refreshCoreAssetsFromSource", () => {
  const first = MANAGED_ASSETS[0]!.relPath;

  it("seeds each managed compose file when absent", () => {
    seedSource("# fresh\n");
    const { updated, backupDir } = refreshCoreAssetsFromSource(sourceRoot, opHome);
    for (const { relPath } of MANAGED_ASSETS) {
      expect(existsSync(join(opHome, relPath))).toBe(true);
      expect(updated).toContain(relPath);
    }
    expect(backupDir).toBeNull();
  });

  it("overwrites a changed file and backs up the old copy", () => {
    seedSource("old\n");
    refreshCoreAssetsFromSource(sourceRoot, opHome);
    seedSource("new\n");
    const { updated, backupDir } = refreshCoreAssetsFromSource(sourceRoot, opHome);
    expect(readFileSync(join(opHome, first), "utf-8")).toBe("new\n");
    expect(updated).toContain(first);
    expect(backupDir).not.toBeNull();
    expect(readFileSync(join(backupDir!, first), "utf-8")).toBe("old\n");
  });

  it("skips when on-disk content already matches the source", () => {
    seedSource("same\n");
    refreshCoreAssetsFromSource(sourceRoot, opHome);
    const { updated, backupDir } = refreshCoreAssetsFromSource(sourceRoot, opHome);
    expect(updated).toHaveLength(0);
    expect(backupDir).toBeNull();
  });
});
