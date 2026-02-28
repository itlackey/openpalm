import { describe, test, expect, vi, beforeEach } from "vitest";
import type { DockerResult } from "./docker.js";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock
}));

// docker.ts also imports existsSync; provide a passthrough so other
// exports keep working without pulling in the real fs module.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false)
}));

describe("checkDocker", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  async function runCheckDocker(): Promise<DockerResult> {
    const { checkDocker } = await import("./docker.js");
    return checkDocker();
  }

  test("reports ok when docker info exits cleanly", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: Function) => {
        cb(null, "27.4.1\n", "");
      }
    );
    const result = await runCheckDocker();
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("27.4.1");
  });

  test("reports ok when docker info has warnings but returns version", async () => {
    const err = Object.assign(new Error("exit 1"), { code: 1 });
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: Function) => {
        cb(err, "27.4.1\n", "WARNING: No swap limit support\n");
      }
    );
    const result = await runCheckDocker();
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("27.4.1");
    expect(result.stderr).toContain("WARNING");
  });

  test("reports not ok when docker is unreachable (no stdout)", async () => {
    const err = Object.assign(new Error("exit 1"), { code: 1 });
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: Function) => {
        cb(
          err,
          "",
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n"
        );
      }
    );
    const result = await runCheckDocker();
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Cannot connect");
  });

  test("reports not ok when docker binary is missing (ENOENT)", async () => {
    const err = Object.assign(new Error("spawn docker ENOENT"), {
      code: "ENOENT"
    });
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: Function) => {
        cb(err, "", "");
      }
    );
    const result = await runCheckDocker();
    expect(result.ok).toBe(false);
  });
});
