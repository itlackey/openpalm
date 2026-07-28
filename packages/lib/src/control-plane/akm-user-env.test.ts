/**
 * Tests for the akm user-env helpers (`env:user`).
 *
 * akm (>= 0.8.0) no longer manages individual env entries, so OpenPalm owns the
 * `knowledge/env/user.env` file directly. Writes/deletes are plain atomic .env
 * edits — no akm subprocess — so these tests run everywhere (no akm-on-PATH gate).
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureAkmUserEnv,
  readUserEnvSync,
  writeUserEnvKey,
  deleteUserEnvKey,
  userEnvPathSync,
  AKM_USER_ENV_REF,
  buildAkmEnv,
  assertAkmEnvComplete,
  AKM_ENV_KEYS,
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
});

describe("AKM_USER_ENV_REF", () => {
  it("exports the canonical akm ref string", () => {
    expect(AKM_USER_ENV_REF).toBe("env:user");
  });
});

describe("assertAkmEnvComplete (I-6 guard)", () => {
  it("passes for the env produced by buildAkmEnv", () => {
    const env = buildAkmEnv({ stashDir: "/k", configDir: "/c", dataDir: "/d" } as ControlPlaneState);
    expect(() => assertAkmEnvComplete(env)).not.toThrow();
  });

  it("throws when any of the four AKM_* dirs is missing", () => {
    for (const omit of AKM_ENV_KEYS) {
      const env: NodeJS.ProcessEnv = {
        AKM_STASH_DIR: "/s",
        AKM_CONFIG_DIR: "/c",
        AKM_CACHE_DIR: "/ca",
        AKM_DATA_DIR: "/d",
      };
      delete env[omit];
      expect(() => assertAkmEnvComplete(env)).toThrow(omit);
    }
  });

  it("throws when a key is present but blank", () => {
    expect(() =>
      assertAkmEnvComplete({ AKM_STASH_DIR: "/s", AKM_CONFIG_DIR: "  ", AKM_CACHE_DIR: "/ca", AKM_DATA_DIR: "/d" }),
    ).toThrow("AKM_CONFIG_DIR");
  });
});
