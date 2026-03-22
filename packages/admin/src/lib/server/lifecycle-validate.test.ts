/**
 * Tests for validateProposedState() in lifecycle.ts.
 * Mocks node:child_process to avoid requiring the varlock binary.
 *
 * validateProposedState() co-locates schema + env files in a temp directory
 * (varlock discovers .env.schema alongside --path), then makes two execFile
 * calls:
 *   1. user.env validation   (vault/user/user.env + vault/user.env.schema)
 *   2. system.env validation (vault/stack/stack.env + vault/system.env.schema)
 */
import { describe, test, expect, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn()
}));

import { validateProposedState } from "./control-plane.js";
import { makeTestState, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

/** Seed the schema and env files that validateProposedState expects. */
function seedValidationFiles(state: { vaultDir: string }): void {
  mkdirSync(join(state.vaultDir, "user"), { recursive: true });
  mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
  writeFileSync(join(state.vaultDir, "user", "user.env.schema"), "# test schema\nADMIN_TOKEN=\n");
  writeFileSync(join(state.vaultDir, "user", "user.env"), "ADMIN_TOKEN=test\n");
  writeFileSync(join(state.vaultDir, "stack", "stack.env.schema"), "# test schema\nPORT=\n");
  writeFileSync(join(state.vaultDir, "stack", "stack.env"), "PORT=8100\n");
}

// Helper: mock all execFile calls to succeed.
function mockExecFileSuccess(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(childProcess.execFile).mockImplementation((...args: any[]) => {
    const cb = args[args.length - 1];
    cb(null, "", "");
    return {} as ReturnType<typeof childProcess.execFile>;
  });
}

// Helper: mock first call to fail with the given stderr, second call to succeed.
function mockExecFileFirstFails(stderr: string): void {
  let callCount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(childProcess.execFile).mockImplementation((...args: any[]) => {
    const cb = args[args.length - 1];
    callCount++;
    if (callCount === 1) {
      const err = Object.assign(new Error("validation failed"), { stderr });
      cb(err, "", "");
    } else {
      cb(null, "", "");
    }
    return {} as ReturnType<typeof childProcess.execFile>;
  });
}

// Helper: mock all execFile calls to fail with the given stderr.
function mockExecFileAllFail(stderr: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(childProcess.execFile).mockImplementation((...args: any[]) => {
    const cb = args[args.length - 1];
    const err = Object.assign(new Error("validation failed"), { stderr });
    cb(err, "", "");
    return {} as ReturnType<typeof childProcess.execFile>;
  });
}

describe("validateProposedState", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  test("returns { ok: true } when both varlock calls succeed", async () => {
    mockExecFileSuccess();

    const state = makeTestState();
    trackDir(state.homeDir);
    seedValidationFiles(state);

    const result = await validateProposedState(state);
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test("returns { ok: false } with parsed errors and warnings when user.env validation fails", async () => {
    mockExecFileFirstFails("ERROR: ADMIN_TOKEN is required but not set\nWARN: OPENAI_BASE_URL is not a valid URL\n");

    const state = makeTestState();
    trackDir(state.homeDir);
    seedValidationFiles(state);

    const result = await validateProposedState(state);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("ERROR");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("WARN");
  });

  test("handles validation failure with empty stderr", async () => {
    mockExecFileAllFail("");

    const state = makeTestState();
    trackDir(state.homeDir);
    seedValidationFiles(state);

    const result = await validateProposedState(state);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("uses --path with a temp directory for both validation calls", async () => {
    const capturedArgs: string[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(childProcess.execFile).mockImplementation((...args: any[]) => {
      const positionalArgs = args[1]; // second argument is the args array
      capturedArgs.push([...positionalArgs]);
      const cb = args[args.length - 1];
      cb(null, "", "");
      return {} as ReturnType<typeof childProcess.execFile>;
    });

    const state = makeTestState();
    trackDir(state.homeDir);
    seedValidationFiles(state);

    await validateProposedState(state);

    // Both calls should use "load" with "--path" pointing to a temp directory
    expect(capturedArgs).toHaveLength(2);
    for (const args of capturedArgs) {
      expect(args[0]).toBe("load");
      expect(args[1]).toBe("--path");
      expect(args[2]).toMatch(/varlock-.*\/$/);
    }
  });

  test("sanitizes API key patterns in varlock error output", async () => {
    // Uses a fake key that matches the sk-* pattern structurally but is clearly test data.
    // NOTE: the pre-commit hook pattern-scan is intentionally excluded from test files.
    const fakeKey = ["sk-", "FAKE".repeat(5), "0000"].join("");
    const secretStderr = `ERROR: value '${fakeKey}' is invalid\n`;
    mockExecFileFirstFails(secretStderr);

    const state = makeTestState();
    trackDir(state.homeDir);
    seedValidationFiles(state);

    const result = await validateProposedState(state);
    expect(result.errors[0]).not.toContain(fakeKey);
    expect(result.errors[0]).toContain("[REDACTED]");
  });
});
