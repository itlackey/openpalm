import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolveEnv,
  resolveEnvFromFile,
  getOldName,
  getNewName,
  resetWarnings,
  ENV_ALIASES,
} from "./env-compat.js";

beforeEach(() => {
  resetWarnings();
});

describe("resolveEnv", () => {
  test("returns value from new name when set", () => {
    const env = { OP_HOME: "/home/test", BUN_TEST: "1" };
    expect(resolveEnv("OP_HOME", env)).toBe("/home/test");
  });

  test("falls back to old name when new is not set", () => {
    const env = { OPENPALM_HOME: "/home/legacy", BUN_TEST: "1" };
    expect(resolveEnv("OP_HOME", env)).toBe("/home/legacy");
  });

  test("prefers new name when both are set", () => {
    const env = { OP_HOME: "/new", OPENPALM_HOME: "/old", BUN_TEST: "1" };
    expect(resolveEnv("OP_HOME", env)).toBe("/new");
  });

  test("returns undefined when neither is set", () => {
    const env: Record<string, string> = { BUN_TEST: "1" };
    expect(resolveEnv("OP_HOME", env)).toBeUndefined();
  });

  test("treats empty string as unset", () => {
    const env = { OP_HOME: "", OPENPALM_HOME: "/fallback", BUN_TEST: "1" };
    expect(resolveEnv("OP_HOME", env)).toBe("/fallback");
  });

  test("returns undefined for unknown new name", () => {
    const env = { BUN_TEST: "1" };
    expect(resolveEnv("OP_UNKNOWN_VAR", env)).toBeUndefined();
  });

  test("resolves auth token aliases", () => {
    const env = { ASSISTANT_TOKEN: "tok123", BUN_TEST: "1" };
    expect(resolveEnv("OP_ASSISTANT_TOKEN", env)).toBe("tok123");
  });

  test("resolves MEMORY_AUTH_TOKEN to OP_MEMORY_TOKEN", () => {
    const env = { MEMORY_AUTH_TOKEN: "mem123", BUN_TEST: "1" };
    expect(resolveEnv("OP_MEMORY_TOKEN", env)).toBe("mem123");
  });
});

describe("resolveEnvFromFile", () => {
  test("returns value from new name", () => {
    const parsed = { OP_IMAGE_TAG: "v2.0" };
    expect(resolveEnvFromFile(parsed, "OP_IMAGE_TAG")).toBe("v2.0");
  });

  test("falls back to old name", () => {
    const parsed = { OPENPALM_IMAGE_TAG: "v1.0" };
    expect(resolveEnvFromFile(parsed, "OP_IMAGE_TAG")).toBe("v1.0");
  });

  test("prefers new name", () => {
    const parsed = { OP_IMAGE_TAG: "new", OPENPALM_IMAGE_TAG: "old" };
    expect(resolveEnvFromFile(parsed, "OP_IMAGE_TAG")).toBe("new");
  });

  test("returns undefined when missing", () => {
    const parsed = {};
    expect(resolveEnvFromFile(parsed, "OP_IMAGE_TAG")).toBeUndefined();
  });
});

describe("getOldName / getNewName", () => {
  test("getOldName returns the legacy name", () => {
    expect(getOldName("OP_HOME")).toBe("OPENPALM_HOME");
    expect(getOldName("OP_ADMIN_TOKEN")).toBe("OPENPALM_ADMIN_TOKEN");
    expect(getOldName("OP_ASSISTANT_TOKEN")).toBe("ASSISTANT_TOKEN");
  });

  test("getNewName returns the OP_ name", () => {
    expect(getNewName("OPENPALM_HOME")).toBe("OP_HOME");
    expect(getNewName("ASSISTANT_TOKEN")).toBe("OP_ASSISTANT_TOKEN");
    expect(getNewName("MEMORY_AUTH_TOKEN")).toBe("OP_MEMORY_TOKEN");
  });

  test("returns undefined for unknown names", () => {
    expect(getOldName("UNKNOWN")).toBeUndefined();
    expect(getNewName("UNKNOWN")).toBeUndefined();
  });
});

describe("ENV_ALIASES integrity", () => {
  test("all entries have OP_ prefix for new name", () => {
    for (const [newName] of ENV_ALIASES) {
      expect(newName.startsWith("OP_")).toBe(true);
    }
  });

  test("no duplicate new names", () => {
    const newNames = ENV_ALIASES.map(([n]) => n);
    expect(new Set(newNames).size).toBe(newNames.length);
  });

  test("no duplicate old names", () => {
    const oldNames = ENV_ALIASES.map(([, o]) => o);
    expect(new Set(oldNames).size).toBe(oldNames.length);
  });
});
