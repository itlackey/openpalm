/**
 * Tests for the akm user-env helpers (`env:user`).
 *
 * akm (>= 0.8.0) no longer manages individual env entries, so OpenPalm owns the
 * `knowledge/env/user.env` file directly. Writes/deletes are plain atomic .env
 * edits — no akm subprocess — so these tests run everywhere (no akm-on-PATH gate).
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureAkmUserEnv,
  readUserEnvFile,
  readUserEnvSync,
  writeUserEnvKey,
  deleteUserEnvKey,
  userEnvPathSync,
  AKM_USER_ENV_REF,
} from "./akm-user-env.js";
import type { ControlPlaneState } from "./types.js";

function makeState(homeDir: string): ControlPlaneState {
  return {
    homeDir,
    configDir: join(homeDir, "config"),
    stashDir: join(homeDir, "knowledge"),
    workspaceDir: join(homeDir, "workspace"),
    dataDir: join(homeDir, "data"),
    stackDir: join(homeDir, "config", "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
  };
}

describe("akm user-env helpers", () => {
  let homeDir: string;
  let state: ControlPlaneState;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-akm-env-"));
    state = makeState(homeDir);
    mkdirSync(state.stashDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("ensureAkmUserEnv creates env/user.env (mode 0600) and returns its path", () => {
    const path = ensureAkmUserEnv(state);
    expect(path).toBe(userEnvPathSync(state));
    expect(path).toBe(join(state.stashDir, "env", "user.env"));
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("writeUserEnvKey upserts a key, readUserEnvSync reads it back", () => {
    writeUserEnvKey(state, "TOKEN", "secret-9988");
    expect(readUserEnvSync(state).TOKEN).toBe("secret-9988");

    // Upsert replaces in place rather than appending a duplicate.
    writeUserEnvKey(state, "TOKEN", "rotated");
    const parsed = readUserEnvSync(state);
    expect(parsed.TOKEN).toBe("rotated");
    const lines = readFileSync(userEnvPathSync(state), "utf-8").split("\n").filter((l) => l.startsWith("TOKEN="));
    expect(lines.length).toBe(1);
  });

  it("writeUserEnvKey single-quotes values with spaces/special chars (shell-source-safe, dotenv round-trips)", () => {
    writeUserEnvKey(state, "TOKEN", "sk-simple123");
    writeUserEnvKey(state, "OWNER", "Ada Lovelace");
    writeUserEnvKey(state, "URL", "https://x.example/p?a=1&b=2");
    writeUserEnvKey(state, "NOTE", "a#b$c");

    // dotenv round-trip (what akm env run / the admin endpoint parse).
    const parsed = readUserEnvSync(state);
    expect(parsed.OWNER).toBe("Ada Lovelace");
    expect(parsed.URL).toBe("https://x.example/p?a=1&b=2");
    expect(parsed.NOTE).toBe("a#b$c");

    // Raw lines: simple tokens stay bare; anything with spaces/shell-meta is
    // POSIX single-quoted so the entrypoint's `set -a; . user.env` is safe
    // (no word-splitting, no `&`/`$` interpretation, no injection).
    const raw = readFileSync(userEnvPathSync(state), "utf-8");
    expect(raw).toContain("TOKEN=sk-simple123\n");
    expect(raw).toContain("OWNER='Ada Lovelace'\n");
    expect(raw).toContain("URL='https://x.example/p?a=1&b=2'\n");
  });

  it("deleteUserEnvKey removes only the named key", () => {
    writeUserEnvKey(state, "TOKEN_A", "value-a");
    writeUserEnvKey(state, "TOKEN_B", "value-b");
    deleteUserEnvKey(state, "TOKEN_A");
    const parsed = readUserEnvSync(state);
    expect(parsed.TOKEN_A).toBeUndefined();
    expect(parsed.TOKEN_B).toBe("value-b");
  });

  it("deleteUserEnvKey is idempotent on a missing key", () => {
    expect(() => deleteUserEnvKey(state, "NEVER_SET_KEY")).not.toThrow();
  });

  it("readUserEnvSync returns {} when no file exists yet", () => {
    expect(readUserEnvSync(state)).toEqual({});
  });

  it("ensureAkmUserEnv migrates a legacy vaults/user.env non-destructively", () => {
    // Seed the legacy location.
    const legacyDir = join(state.stashDir, "vaults");
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, "user.env");
    writeFileSync(legacyPath, "FOO=bar\nBAZ=qux\n");

    const path = ensureAkmUserEnv(state);
    expect(readUserEnvFile(path)).toEqual({ FOO: "bar", BAZ: "qux" });
    // Original is left intact (copy, never move).
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(legacyPath, "utf-8")).toBe("FOO=bar\nBAZ=qux\n");
  });

  it("ensureAkmUserEnv prefers an existing env/user.env over the legacy file", () => {
    writeUserEnvKey(state, "NEW", "1");
    const legacyDir = join(state.stashDir, "vaults");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "user.env"), "OLD=should-not-win\n");

    ensureAkmUserEnv(state);
    const parsed = readUserEnvSync(state);
    expect(parsed.NEW).toBe("1");
    expect(parsed.OLD).toBeUndefined();
  });
});

describe("AKM_USER_ENV_REF", () => {
  it("exports the canonical akm ref string", () => {
    expect(AKM_USER_ENV_REF).toBe("env:user");
  });
});
