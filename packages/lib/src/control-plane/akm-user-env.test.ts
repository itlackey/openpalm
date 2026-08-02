/**
 * Tests for the akm user-env helpers (`env/user`).
 *
 * akm manages the persisted env asset as a whole file, so OpenPalm owns the
 * `knowledge/env/user.env` file directly. Writes/deletes are plain atomic .env
 * edits — no akm subprocess — so these tests run everywhere (no akm-on-PATH gate).
 */
import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureAkmUserEnv,
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

  it("writeUserEnvKey uses dotenv-safe quoting and round-trips special values", () => {
    writeUserEnvKey(state, "TOKEN", "sk-simple123");
    writeUserEnvKey(state, "OWNER", "Ada Lovelace");
    writeUserEnvKey(state, "URL", "https://x.example/p?a=1&b=2");
    writeUserEnvKey(state, "NOTE", "a#b$c");
    writeUserEnvKey(state, "CONTACT", "O'Brien");
    writeUserEnvKey(state, "MULTILINE", "line one\nline two");

    // dotenv round-trip (what akm env run / the admin endpoint parse).
    const parsed = readUserEnvSync(state);
    expect(parsed.OWNER).toBe("Ada Lovelace");
    expect(parsed.URL).toBe("https://x.example/p?a=1&b=2");
    expect(parsed.NOTE).toBe("a#b$c");
    expect(parsed.CONTACT).toBe("O'Brien");
    expect(parsed.MULTILINE).toBe("line one\nline two");

    // Raw lines stay readable while values with dotenv metacharacters are quoted.
    const raw = readFileSync(userEnvPathSync(state), "utf-8");
    expect(raw).toContain("TOKEN=sk-simple123\n");
    expect(raw).toContain("OWNER=Ada Lovelace\n");
    expect(raw).toContain("URL=https://x.example/p?a=1&b=2\n");
    expect(raw).toContain('CONTACT="O\'Brien"\n');
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

  // D5: chmod requires ownership. A root-seeded or container-recreated
  // user.env this process does not own throws EPERM — ensureAkmUserEnv is
  // called unguarded from prepareInstallFiles, so letting that throw would
  // abort the whole install before the wizard is ever served.
  it("does not throw when chmod on an existing user.env fails (best-effort, mirrors enforceVaultDirMode)", () => {
    const path = ensureAkmUserEnv(state);
    writeFileSync(path, "TOKEN=already-here\n");

    const spy = spyOn(nodeFs, "chmodSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    try {
      expect(() => ensureAkmUserEnv(state)).not.toThrow();
      expect(ensureAkmUserEnv(state)).toBe(path);
    } finally {
      spy.mockRestore();
    }

    // The file itself is untouched by the failed chmod attempt.
    expect(readFileSync(path, "utf-8")).toBe("TOKEN=already-here\n");
  });
});

describe("AKM_USER_ENV_REF", () => {
  it("exports the canonical akm ref string", () => {
    expect(AKM_USER_ENV_REF).toBe("env/user");
  });
});
