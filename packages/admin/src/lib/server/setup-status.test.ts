/**
 * Tests for setup-status.ts — setup detection utilities.
 *
 * Verifies:
 * 1. readSecretsKeys parses .env files correctly (key presence and emptiness)
 * 2. detectUserId prefers env vars, falls back to os.userInfo, then "default_user"
 * 3. isSetupComplete checks staged stack.env first, falls back to secrets.env
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSecretsKeys, detectUserId, isSetupComplete } from "./setup-status.js";

// ── Test helpers ────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let tempDirs: string[] = [];
function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

// ── readSecretsKeys ─────────────────────────────────────────────────────

describe("readSecretsKeys", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("returns empty object when secrets.env does not exist", () => {
    expect(readSecretsKeys(configDir)).toEqual({});
  });

  test("detects key presence with non-empty value as true", () => {
    writeFileSync(join(configDir, "secrets.env"), "ADMIN_TOKEN=my-token\n");
    const result = readSecretsKeys(configDir);
    expect(result.ADMIN_TOKEN).toBe(true);
  });

  test("detects empty value as false", () => {
    writeFileSync(join(configDir, "secrets.env"), "ADMIN_TOKEN=\n");
    const result = readSecretsKeys(configDir);
    expect(result.ADMIN_TOKEN).toBe(false);
  });

  test("skips comment lines", () => {
    writeFileSync(
      join(configDir, "secrets.env"),
      "# This is a comment\nADMIN_TOKEN=token\n# Another comment\n"
    );
    const result = readSecretsKeys(configDir);
    expect(result.ADMIN_TOKEN).toBe(true);
    expect(Object.keys(result)).toHaveLength(1);
  });

  test("skips blank lines", () => {
    writeFileSync(
      join(configDir, "secrets.env"),
      "\n\nADMIN_TOKEN=token\n\n"
    );
    const result = readSecretsKeys(configDir);
    expect(result.ADMIN_TOKEN).toBe(true);
  });

  test("handles multiple keys", () => {
    writeFileSync(
      join(configDir, "secrets.env"),
      "ADMIN_TOKEN=token\nOPENAI_API_KEY=sk-test\nGROQ_API_KEY=\n"
    );
    const result = readSecretsKeys(configDir);
    expect(result.ADMIN_TOKEN).toBe(true);
    expect(result.OPENAI_API_KEY).toBe(true);
    expect(result.GROQ_API_KEY).toBe(false);
  });

  test("handles lines without = sign", () => {
    writeFileSync(
      join(configDir, "secrets.env"),
      "invalid_line_no_equals\nADMIN_TOKEN=token\n"
    );
    const result = readSecretsKeys(configDir);
    expect(result.ADMIN_TOKEN).toBe(true);
    expect(Object.keys(result)).toHaveLength(1);
  });

  test("handles value with = in it", () => {
    writeFileSync(
      join(configDir, "secrets.env"),
      "OPENAI_BASE_URL=http://localhost:11434/v1?key=abc\n"
    );
    const result = readSecretsKeys(configDir);
    expect(result.OPENAI_BASE_URL).toBe(true);
  });
});

// ── detectUserId ────────────────────────────────────────────────────────

describe("detectUserId", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.USER = process.env.USER;
    origEnv.LOGNAME = process.env.LOGNAME;
  });

  afterEach(() => {
    process.env.USER = origEnv.USER;
    process.env.LOGNAME = origEnv.LOGNAME;
  });

  test("prefers USER env var", () => {
    process.env.USER = "testuser";
    process.env.LOGNAME = "loguser";
    expect(detectUserId()).toBe("testuser");
  });

  test("falls back to LOGNAME when USER is undefined", () => {
    delete process.env.USER;
    process.env.LOGNAME = "loguser";
    expect(detectUserId()).toBe("loguser");
  });

  test("skips empty USER to os.userInfo (not LOGNAME) due to ?? semantics", () => {
    // When USER is "" (not undefined), ?? does NOT fall through to LOGNAME.
    // The "" is falsy, so the `if (envUser)` check skips to os.userInfo().
    process.env.USER = "";
    process.env.LOGNAME = "loguser";
    const result = detectUserId();
    // Result should come from os.userInfo(), not LOGNAME
    expect(result).not.toBe("loguser");
    expect(result.length).toBeGreaterThan(0);
  });

  test("falls back to os.userInfo when both env vars are empty", () => {
    process.env.USER = "";
    process.env.LOGNAME = "";
    const result = detectUserId();
    // Should return a non-empty string (either from userInfo or "default_user")
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns non-empty string in all cases", () => {
    // Whatever the environment, we always get a user id
    const result = detectUserId();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── isSetupComplete ─────────────────────────────────────────────────────

describe("isSetupComplete", () => {
  let stateDir: string;
  let configDir: string;

  beforeEach(() => {
    stateDir = trackDir(makeTempDir());
    configDir = trackDir(makeTempDir());
  });

  test("returns true when stack.env has OPENPALM_SETUP_COMPLETE=true", () => {
    const artifactDir = join(stateDir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "stack.env"),
      "# Config\nOPENPALM_SETUP_COMPLETE=true\n"
    );

    expect(isSetupComplete(stateDir, configDir)).toBe(true);
  });

  test("returns false when stack.env has OPENPALM_SETUP_COMPLETE=false", () => {
    const artifactDir = join(stateDir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "stack.env"),
      "OPENPALM_SETUP_COMPLETE=false\n"
    );

    expect(isSetupComplete(stateDir, configDir)).toBe(false);
  });

  test("falls back to secrets.env ADMIN_TOKEN when stack.env missing", () => {
    writeFileSync(join(configDir, "secrets.env"), "ADMIN_TOKEN=my-token\n");
    expect(isSetupComplete(stateDir, configDir)).toBe(true);
  });

  test("returns false when no stack.env and ADMIN_TOKEN is empty", () => {
    writeFileSync(join(configDir, "secrets.env"), "ADMIN_TOKEN=\n");
    expect(isSetupComplete(stateDir, configDir)).toBe(false);
  });

  test("returns false when neither file exists", () => {
    expect(isSetupComplete(stateDir, configDir)).toBe(false);
  });

  test("stack.env takes precedence over secrets.env", () => {
    // stack.env says setup incomplete, but ADMIN_TOKEN is set
    const artifactDir = join(stateDir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "stack.env"),
      "OPENPALM_SETUP_COMPLETE=false\n"
    );
    writeFileSync(join(configDir, "secrets.env"), "ADMIN_TOKEN=my-token\n");

    expect(isSetupComplete(stateDir, configDir)).toBe(false);
  });

  test("handles case-insensitive 'true' value", () => {
    const artifactDir = join(stateDir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "stack.env"),
      "OPENPALM_SETUP_COMPLETE=True\n"
    );

    expect(isSetupComplete(stateDir, configDir)).toBe(true);
  });

  test("skips comments in stack.env", () => {
    const artifactDir = join(stateDir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "stack.env"),
      "# OPENPALM_SETUP_COMPLETE=false\nOPENPALM_SETUP_COMPLETE=true\n"
    );

    expect(isSetupComplete(stateDir, configDir)).toBe(true);
  });
});
