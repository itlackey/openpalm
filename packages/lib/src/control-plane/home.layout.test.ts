/**
 * Locks the OP_HOME layout single-source-of-truth (home.ts). Every well-known
 * path is defined ONCE here; this test asserts the four-tree shape so a change is
 * caught and reviewed (and so a future `config/stack`→`system/` move is a one-line
 * edit in home.ts with this test as the guard).
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authJsonFile,
  composeFilePath,
  ensureHomeDirs,
  hostIdentityFile,
  privateDir,
  privateSecretsDir,
  resolveStateDir,
  resolveSystemDir,
  secretsDir,
  stackEnvFile,
  userEnvFile,
} from "./home.js";

const H = "/op/home";

describe("OP_HOME layout (single source of truth)", () => {
  test("well-known files derive from the home root, defined once", () => {
    expect(stackEnvFile(H)).toBe("/op/home/state/stack.env");
    expect(hostIdentityFile(H)).toBe("/op/home/state/host-identity.json");
    expect(stackEnvFile(H)).toBe("/op/home/state/stack.env");
    expect(userEnvFile(H)).toBe("/op/home/knowledge/env/user.env");
    expect(secretsDir(H)).toBe("/op/home/knowledge/secrets");
    expect(authJsonFile(H)).toBe("/op/home/knowledge/secrets/auth.json");
    expect(composeFilePath(H, "core.compose.yml")).toBe("/op/home/system/stack/core.compose.yml");
  });

  test("ensureHomeDirs creates the managed (system/) and state/ trees", () => {
    const prev = process.env.OP_HOME;
    const home = mkdtempSync(join(tmpdir(), "op-home-layout-"));
    try {
      process.env.OP_HOME = home;
      ensureHomeDirs();
      expect(resolveSystemDir()).toBe(join(home, "system"));
      expect(resolveStateDir()).toBe(join(home, "state"));
      expect(existsSync(join(home, "system"))).toBe(true);
      expect(existsSync(join(home, "state"))).toBe(true);
      expect(existsSync(join(home, "data/assistant/.config/opencode"))).toBe(true);
      expect(existsSync(join(home, "data/guardian/.config/opencode"))).toBe(true);
      expect(statSync(join(home, "data/assistant/.local/share/opencode/auth.json")).isFile()).toBe(
        true,
      );
      expect(statSync(join(home, "data/guardian/.local/share/opencode/auth.json")).isFile()).toBe(
        true,
      );

      chmodSync(privateDir(home), 0o755);
      chmodSync(privateSecretsDir(home), 0o755);
      ensureHomeDirs(home);
      expect(statSync(privateDir(home)).mode & 0o777).toBe(0o700);
      expect(statSync(privateSecretsDir(home)).mode & 0o777).toBe(0o700);
    } finally {
      if (prev === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
