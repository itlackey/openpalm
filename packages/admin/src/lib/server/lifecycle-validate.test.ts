/**
 * Tests for validateEnvironment() in lifecycle.ts.
 * Mocks node:child_process to avoid requiring the varlock binary.
 *
 * validateEnvironment() makes two execFile calls:
 *   1. secrets.env validation (CONFIG_HOME/secrets.env against DATA_HOME/secrets.env.schema)
 *   2. stack.env validation  (STATE_HOME/artifacts/stack.env against DATA_HOME/stack.env.schema)
 */
import { describe, test, expect, afterEach, vi } from "vitest";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn()
}));

import { validateEnvironment } from "./lifecycle.js";
import { makeTestState, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

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

describe("validateEnvironment", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  test("returns { ok: true } when both varlock calls succeed", async () => {
    mockExecFileSuccess();

    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const result = await validateEnvironment(state);
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test("returns { ok: false } with parsed errors and warnings when secrets.env validation fails", async () => {
    mockExecFileFirstFails("ERROR: ADMIN_TOKEN is required but not set\nWARN: OPENAI_BASE_URL is not a valid URL\n");

    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const result = await validateEnvironment(state);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("ERROR");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("WARN");
  });

  test("returns { ok: false } gracefully on execFile timeout (empty stderr)", async () => {
    mockExecFileAllFail("");

    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const result = await validateEnvironment(state);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("uses correct schema and env paths for both validation calls", async () => {
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
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    await validateEnvironment(state);

    // First call: secrets.env validation
    expect(capturedArgs[0]).toContain("--schema");
    expect(capturedArgs[0]).toContain(`${state.dataDir}/secrets.env.schema`);
    expect(capturedArgs[0]).toContain("--env-file");
    expect(capturedArgs[0]).toContain(`${state.configDir}/secrets.env`);
    expect(capturedArgs[0]).toContain("--quiet");

    // Second call: stack.env validation
    expect(capturedArgs[1]).toContain("--schema");
    expect(capturedArgs[1]).toContain(`${state.dataDir}/stack.env.schema`);
    expect(capturedArgs[1]).toContain("--env-file");
    expect(capturedArgs[1]).toContain(`${state.stateDir}/artifacts/stack.env`);
    expect(capturedArgs[1]).toContain("--quiet");
  });

  test("sanitizes API key patterns in varlock error output", async () => {
    // Uses a fake key that matches the sk-* pattern structurally but is clearly test data.
    // NOTE: the pre-commit hook pattern-scan is intentionally excluded from test files.
    const fakeKey = ["sk-", "FAKE".repeat(5), "0000"].join("");
    const secretStderr = `ERROR: value '${fakeKey}' is invalid\n`;
    mockExecFileFirstFails(secretStderr);

    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const result = await validateEnvironment(state);
    expect(result.errors[0]).not.toContain(fakeKey);
    expect(result.errors[0]).toContain("[REDACTED]");
  });
});
