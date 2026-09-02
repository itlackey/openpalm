/**
 * overwriteSystemTree — blind-overwrites the entire managed `system/` tree from
 * the release skeleton on every install/update (constitution §1), backing up a
 * changed copy first. Unchanged files are skipped. User trees, data/, and state/
 * are NEVER touched here — they are seeded once by applyHomeSeed's
 * skip-existing copy, so they are not tested here.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { overwriteSystemTree } from "./core-assets.js";

// chmod 0 only blocks a NON-root process; root bypasses DAC permission checks
// entirely, so the reproduction below (#641) needs to run as an unprivileged
// user to actually hit EACCES. Same environment-guard style as
// config-persistence-operator-ids.test.ts, inverted: that suite needs root,
// this one needs to NOT be root.
function isRootProcess(): boolean {
  return process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0;
}

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

	// #641: an operator upgrading from a release whose guardian installed its
	// own dependencies at boot (pre-0.13.1) can have root-owned entries under
	// system/guardian/node_modules on their FIRST 0.13.1 upgrade. The rename
	// that retires the old tree needs only write on its PARENT directory and
	// succeeds regardless of who owns the entries inside, but a non-root CLI
	// then cannot unlink a file inside a root-owned, non-writable directory —
	// so the final best-effort cleanup must warn and continue rather than
	// throw and report a completed update as a failure.
	it("does not abort a completed update when the retired system/ copy has an unremovable directory", () => {
		if (isRootProcess()) return; // see isRootProcess() docblock above
		seedSource("old\n");
		overwriteSystemTree(sourceRoot, opHome);
		const blockedDir = join(opHome, "system", "guardian", "node_modules", "some-pkg");
		mkdirSync(blockedDir, { recursive: true });
		writeFileSync(join(blockedDir, "index.js"), "module.exports = {}\n");
		// r-xr-xr-x, matching a real npm-installed package directory: readable/
		// listable (so the pre-swap backup copy still succeeds, as it does in
		// the real bug) but not writable, so unlinking its entry fails. 0o000
		// would additionally block the read/scan the backup copy needs,
		// reproducing a different (scandir) failure than the reported one.
		chmodSync(blockedDir, 0o555);
		seedSource("new\n");

		try {
			expect(() => overwriteSystemTree(sourceRoot, opHome)).not.toThrow();
			// The swap itself must have completed: the new tree is live.
			expect(readFileSync(join(opHome, first), "utf-8")).toBe("new\n");
		} finally {
			// A successful (fixed) run renames the retired tree to
			// .system-previous-<nonce> and leaves it in place (rm best-effort
			// failed, by design) — the blocked directory now lives there, not at
			// its original system/ path. Restore its permissions wherever it
			// landed so afterEach's rmSync(tmpRoot) can actually clean up; a
			// pre-fix run throws before any rename, so the original path is the
			// fallback.
			const previous = readdirSync(opHome).find((name) => name.startsWith(".system-previous-"));
			const stillBlocked = previous
				? join(opHome, previous, "guardian", "node_modules", "some-pkg")
				: blockedDir;
			if (existsSync(stillBlocked)) chmodSync(stillBlocked, 0o755);
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
