/**
 * overwriteSystemTree — blind-overwrites the entire managed `system/` tree from
 * the release skeleton on every install/update (constitution §1), backing up a
 * changed copy first. Unchanged files are skipped. User trees, data/, and state/
 * are NEVER touched here — they are seeded once by applyHomeSeed's
 * skip-existing copy, so they are not tested here.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
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
    // Retirement ALONE triggers the overwrite: no source file changed content
    // here, and nothing else prunes the managed tree.

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

	// The two target-only classes pull in opposite directions, so pin them
	// together: runtime extras never trigger an overwrite, a retirement always
	// does — even when it arrives in the same tree as those extras.
	it("still detects a retirement when runtime extras are present", () => {
		seedSource("same\n");
		overwriteSystemTree(sourceRoot, opHome);
		const nodeModules = join(opHome, "system", "assistant", "node_modules");
		mkdirSync(nodeModules, { recursive: true });
		writeFileSync(join(nodeModules, "runtime.js"), "runtime dependency\n");
		rmSync(join(sourceRoot, "system", "stack", "portals.compose.yml"));

		const { updated, backupDir } = overwriteSystemTree(sourceRoot, opHome);

		expect(existsSync(join(opHome, "system", "stack", "portals.compose.yml"))).toBe(false);
		expect(updated).toContain("system/stack/portals.compose.yml");
		expect(backupDir).not.toBeNull();
	});
});

describe("#641/#642/#653 — a permission-denied file surfaces an actionable message, not a bare EACCES", () => {
  it("names the exact path and the repair-ownership remedy instead of a bare EACCES", () => {
    // Root bypasses DAC checks entirely (that is the whole reason
    // repairRootOwnedBindMounts delegates to a sandboxed container instead of
    // chowning directly), so a chmod 000 file is still fully readable/writable
    // here and this path cannot be exercised as root. Run this file's tests
    // as a non-root user (`runuser -u optest -- bun test ...`) to prove it —
    // see the agent runbook.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    seedSource("old\n");
    overwriteSystemTree(sourceRoot, opHome);
    const locked = join(opHome, MANAGED_FILES[0]);
    // A file left un-writable by the current session (the #641/#642
    // shape) — the owner itself can chmod it, but afterward even the owner
    // cannot read/write it, exactly like a prior root-owned run's leftovers.
    chmodSync(locked, 0o000);
    try {
      seedSource("new\n"); // a genuine skeleton change, so the overwrite proceeds
      let thrown: unknown;
      try {
        overwriteSystemTree(sourceRoot, opHome);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).not.toContain("EACCES: permission denied"); // the bare, unhelpful original
      expect(message).toContain(locked);
      expect(message).toContain("openpalm repair-ownership");
    } finally {
      chmodSync(locked, 0o644); // restore so afterEach's rmSync can clean up
    }
  });
});

describe("AGENTS.md is a runtime extra, not a retirement", () => {
  it("does not report changed when only the container-seeded AGENTS.md is extra", () => {
    // The assistant entrypoint seeds the image's AGENTS.md into
    // system/assistant on every boot and the skeleton ships none. Reading that
    // as a retired file made `changed` true on EVERY run, so each launch
    // backed up the whole system/ tree and then replaced it — deleting the
    // plugin node_modules and swapping the inode of a directory the running
    // assistant has bind-mounted. Backups are only pruned on install/update,
    // so they accumulated (24 on the machine where this was found).
    seedSource("managed\n");
    overwriteSystemTree(sourceRoot, opHome);

    // The container then writes its own files into the bind mount.
    writeFileSync(join(opHome, "system", "assistant", "AGENTS.md"), "# seeded by the image\n");
    mkdirSync(join(opHome, "system", "assistant", "node_modules", "x"), { recursive: true });
    writeFileSync(join(opHome, "system", "assistant", "node_modules", "x", "i.js"), "//\n");

    const second = overwriteSystemTree(sourceRoot, opHome);

    // No backup written and nothing replaced — the observable form of
    // "this run was a no-op".
    expect(second.backupDir).toBeNull();
    expect(second.updated).toEqual([]);
    // Both survive — that is the point.
    expect(existsSync(join(opHome, "system", "assistant", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(opHome, "system", "assistant", "node_modules", "x", "i.js"))).toBe(true);
  });
});
