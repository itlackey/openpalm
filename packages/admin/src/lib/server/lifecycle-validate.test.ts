/**
 * Tests for validateEnvironment() in lifecycle.ts.
 * Mocks node:child_process to avoid requiring the varlock binary.
 */
import { describe, test, expect, afterEach, vi } from "vitest";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn()
}));

import { validateEnvironment } from "./lifecycle.js";
import { makeTestState, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

// Helper to set up execFile mock behavior
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockExecFile(behavior: (cb: any) => void): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(childProcess.execFile).mockImplementation((...args: any[]) => {
    const cb = args[args.length - 1];
    behavior(cb);
    return {} as ReturnType<typeof childProcess.execFile>;
  });
}

describe("validateEnvironment", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  test("returns { ok: true } when varlock exits successfully", async () => {
    mockExecFile((cb) => cb(null, "", ""));

    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const result = await validateEnvironment(state);
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test("returns { ok: false } with parsed errors and warnings on varlock failure", async () => {
    mockExecFile((cb) => {
      const err = Object.assign(new Error("validation failed"), {
        stderr: "ERROR: ADMIN_TOKEN is required but not set\nWARN: OPENAI_BASE_URL is not a valid URL\n"
      });
      cb(err, "", "");
    });

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

  test("returns { ok: false } gracefully on execFile timeout", async () => {
    mockExecFile((cb) => {
      const err = Object.assign(new Error("Command timed out"), {
        code: "ETIMEDOUT",
        stderr: ""
      });
      cb(err, "", "");
    });

    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const result = await validateEnvironment(state);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("uses correct schema and env paths from state", async () => {
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

    expect(capturedArgs[0]).toContain("--schema");
    expect(capturedArgs[0]).toContain(`${state.dataDir}/secrets.env.schema`);
    expect(capturedArgs[0]).toContain("--env-file");
    expect(capturedArgs[0]).toContain(`${state.configDir}/secrets.env`);
    expect(capturedArgs[0]).toContain("--quiet");
  });
});
