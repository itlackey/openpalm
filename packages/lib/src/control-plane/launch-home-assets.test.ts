/**
 * The launch path applies the release's shipped assets, config included.
 *
 * The defect this pins, found by upgrading a real instance to 0.13.0-beta.32:
 * `/system-stash` was mounted and held all three shipped skills, and the
 * assistant's akm config listed only `openpalm` and `host-akm` — no bundle
 * pointed at the mount, so akm never walked it and every shipped skill resolved
 * to the stale `/stash` copy instead. `ensureSystemBundle` existed for exactly
 * this and was correct; it was simply never reached, because it hangs off
 * `applyHome` and the desktop app calls `applyHomeSeed` directly (main.ts) —
 * writing `system/skills/` on every launch while skipping the heal that makes
 * that tree readable. A desktop install updates itself without ever running
 * install or update, so nothing else was going to call it.
 *
 * These run against the REAL repo skeleton (OPENPALM_REPO_ROOT, set by the bun
 * preload), so what lands in `system/skills/` is what the build actually ships.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHomeAssets, createState } from "./lifecycle.js";
import { resolveLocalOpenpalmDir } from "./ui-assets.js";

const savedHome = process.env.OP_HOME;

afterEach(() => {
  if (savedHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = savedHome;
});

/** A home mid-upgrade: managed tree from the previous release, real config. */
function upgradedHome(bundles: Record<string, unknown>, defaultBundle = "openpalm"): string {
  const homeDir = mkdtempSync(join(tmpdir(), "openpalm-launch-assets-"));
  mkdirSync(join(homeDir, "config", "akm"), { recursive: true });
  writeFileSync(
    join(homeDir, "config", "akm", "config.json"),
    `${JSON.stringify({ configVersion: "0.9.0", bundles, defaultBundle }, null, 2)}\n`,
  );
  return homeDir;
}

describe("applyHomeAssets (what a launch, not an install, applies)", () => {
  test("registers the /system-stash bundle a config written before the skills move never got", async () => {
    // Verbatim from the real upgraded instance: stash + host-stash, no system.
    const homeDir = upgradedHome({
      openpalm: { path: "/stash", writable: true, enabled: true },
      "host-akm": { path: "/host-stash", writable: true, enabled: true },
    });
    process.env.OP_HOME = homeDir;
    try {
      await applyHomeAssets(createState());

      const cfg = JSON.parse(readFileSync(join(homeDir, "config", "akm", "config.json"), "utf-8"));
      expect(cfg.bundles["openpalm-system"]).toEqual({
        path: "/system-stash",
        writable: false,
        enabled: true,
      });
      // The mount the entry names now has something behind it, and the two
      // halves are useless apart: this is why they belong in one call.
      expect(existsSync(join(homeDir, "system", "skills", "config-diagnostics"))).toBe(true);
      // Narrow: the operator's own entries are untouched.
      expect(cfg.bundles.openpalm).toEqual({ path: "/stash", writable: true, enabled: true });
      expect(cfg.bundles["host-akm"]).toEqual({ path: "/host-stash", writable: true, enabled: true });
      expect(cfg.defaultBundle).toBe("openpalm");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("collapses the two bundle ids pointing at /stash that block akm's migration", async () => {
    // Verbatim from the real running instance: akm synthesized a `stash` bundle
    // for AKM_BUNDLE_DIR beside OpenPalm's own `openpalm`, and made it the
    // default. `akm migrate apply` then exits 70 on every boot with
    // `duplicate task migration file path: /stash/tasks/akm-improve.yml`.
    const homeDir = upgradedHome(
      {
        stash: { path: "/stash", writable: true, components: { main: { adapter: "akm" } } },
        "host-akm": { path: "/host-stash", writable: true, enabled: true },
        "openpalm-system": { path: "/system-stash", writable: false, enabled: true },
        openpalm: { path: "/stash", writable: true },
      },
      "stash",
    );
    process.env.OP_HOME = homeDir;
    try {
      await applyHomeAssets(createState());

      const cfg = JSON.parse(readFileSync(join(homeDir, "config", "akm", "config.json"), "utf-8"));
      expect(Object.keys(cfg.bundles).sort()).toEqual(["host-akm", "openpalm", "openpalm-system"]);
      // The declared adapter moves onto the survivor rather than being dropped:
      // taskRoots skips any root whose adapter is not `akm`/`akm-task`, so
      // losing it would trade the loud failure for a silent skip.
      expect(cfg.bundles.openpalm).toEqual({
        path: "/stash",
        writable: true,
        components: { main: { adapter: "akm" } },
      });
      // The default named the removed id; it has to move with it, or the config
      // names a bundle that no longer exists.
      expect(cfg.defaultBundle).toBe("openpalm");
      // The other mounts are different directories and survive the sweep.
      expect(cfg.bundles["host-akm"]).toEqual({ path: "/host-stash", writable: true, enabled: true });
      expect(cfg.bundles["openpalm-system"]).toEqual({ path: "/system-stash", writable: false, enabled: true });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("clears the stash copy shadowing a shipped skill, and never the operator's own", async () => {
    const homeDir = upgradedHome({ openpalm: { path: "/stash", writable: true, enabled: true } });
    const skeleton = resolveLocalOpenpalmDir();
    if (!skeleton) throw new Error("no local skeleton source: the bun preload should set OPENPALM_REPO_ROOT");
    // What an install before the move left in the stash, and one skill of the
    // operator's beside it.
    cpSync(join(skeleton, "system", "skills", "notify"), join(homeDir, "knowledge", "skills", "notify"), {
      recursive: true,
    });
    mkdirSync(join(homeDir, "knowledge", "skills", "mine"), { recursive: true });
    writeFileSync(join(homeDir, "knowledge", "skills", "mine", "SKILL.md"), "mine\n");
    process.env.OP_HOME = homeDir;
    try {
      await applyHomeAssets(createState());

      expect(existsSync(join(homeDir, "knowledge", "skills", "notify"))).toBe(false);
      expect(existsSync(join(homeDir, "system", "skills", "notify", "SKILL.md"))).toBe(true);
      expect(readFileSync(join(homeDir, "knowledge", "skills", "mine", "SKILL.md"), "utf8")).toBe("mine\n");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
