import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedStashAssets } from "./core-assets.js";

describe("seedStashAssets", () => {
  let homeDir: string;
  const originalHome = process.env.OP_HOME;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "stash-seed-test-"));
    process.env.OP_HOME = homeDir;
    mkdirSync(join(homeDir, "stash"), { recursive: true });
  });

  afterEach(() => {
    process.env.OP_HOME = originalHome;
    // Restore writable mode in case a test chmod'd the stash dir.
    try {
      chmodSync(join(homeDir, "stash"), 0o755);
    } catch {
      // ignore — dir may not exist
    }
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("writes every seed under stash/ on first run", () => {
    const seeds = {
      "skills/test-skill/SKILL.md": "---\nname: test-skill\ntype: skill\n---\nhello\n",
      "commands/test-cmd.md": "---\nname: test-cmd\ntype: command\n---\nrun me\n",
    };
    const written = seedStashAssets(seeds);

    expect(written.sort()).toEqual(Object.keys(seeds).sort());
    for (const [rel, content] of Object.entries(seeds)) {
      const target = join(homeDir, "stash", rel);
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf-8")).toBe(content);
    }
  });

  it("does not overwrite existing files (user edits win)", () => {
    const seeds = { "skills/keep-mine/SKILL.md": "ORIGINAL SEED\n" };
    const userEdit = "USER EDIT — must not be overwritten\n";

    // Simulate a previous install: seed first.
    seedStashAssets(seeds);
    const target = join(homeDir, "stash/skills/keep-mine/SKILL.md");
    expect(readFileSync(target, "utf-8")).toBe("ORIGINAL SEED\n");

    // User edits the file.
    writeFileSync(target, userEdit);

    // Re-run: must return [] and leave the user's content intact.
    const written = seedStashAssets(seeds);
    expect(written).toEqual([]);
    expect(readFileSync(target, "utf-8")).toBe(userEdit);
  });

  it("creates nested directories under stash/ as needed", () => {
    const seeds = { "skills/deep/nested/asset/SKILL.md": "x" };
    seedStashAssets(seeds);
    expect(existsSync(join(homeDir, "stash/skills/deep/nested/asset/SKILL.md"))).toBe(true);
  });

  it("returns an empty list when called with no seeds", () => {
    expect(seedStashAssets({})).toEqual([]);
  });

  it("rejects seed keys that escape the stash directory", () => {
    // Path-traversal guard: ../ sequences in keys must throw rather than
    // silently writing outside stash/.
    expect(() =>
      seedStashAssets({ "../../etc/cron.d/evil": "owned\n" }),
    ).toThrow(/escapes stash dir/);

    // Confirm the malicious payload was NOT written anywhere relative to
    // the temp home.
    expect(existsSync(join(homeDir, "..", "..", "etc", "cron.d", "evil"))).toBe(false);
  });

  it("rejects seed keys that traverse through the stash dir back out", () => {
    expect(() =>
      seedStashAssets({ "skills/../../../escape.md": "x" }),
    ).toThrow(/escapes stash dir/);
  });

  it("surfaces errors when the stash directory is read-only", () => {
    // Skip when running as root (chmod is a no-op for the superuser).
    const uid = process.getuid?.();
    if (uid === 0) return;

    const stashDir = join(homeDir, "stash");
    chmodSync(stashDir, 0o555);
    try {
      expect(() =>
        seedStashAssets({ "skills/readonly/SKILL.md": "nope\n" }),
      ).toThrow();
    } finally {
      chmodSync(stashDir, 0o755);
    }
  });
});
