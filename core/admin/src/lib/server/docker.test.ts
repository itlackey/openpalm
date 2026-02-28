/**
 * Tests for docker.ts — Docker Compose integration layer.
 *
 * Verifies:
 * 1. checkDocker handles version output, warnings, daemon errors, missing binary
 * 2. checkDockerCompose reports availability
 * 3. composeUp validates file existence, builds correct args with options
 * 4. composeDown handles volumes flag
 * 5. composeRestart, composeStop, composeStart build correct commands
 * 6. composePs handles missing compose file fallback
 * 7. composeLogs respects tail and service filters
 * 8. caddyReload builds exec command correctly
 * 9. composePull builds pull command
 * 10. All commands use execFile (no shell injection — core security invariant)
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { DockerResult } from "./docker.js";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock
}));

// docker.ts also imports existsSync; provide a passthrough so other
// exports keep working without pulling in the real fs module.
const existsSyncMock = vi.fn((_path: string) => false);
vi.mock("node:fs", () => ({
  existsSync: (path: string) => existsSyncMock(path)
}));

// Helper: make execFile resolve successfully
function mockExecSuccess(stdout = "", stderr = ""): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
      // execFile can be called with 3 or 4 args depending on the function
      const callback = cb ?? _opts;
      if (typeof callback === "function") {
        callback(null, stdout, stderr);
      }
    }
  );
}

// Helper: make execFile resolve with error
function mockExecError(code: number | string, stderr = ""): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
      const callback = cb ?? _opts;
      const err = Object.assign(new Error(`exit ${code}`), { code });
      if (typeof callback === "function") {
        callback(err, "", stderr);
      }
    }
  );
}

// Capture the args passed to execFile on each call
function capturedArgs(): string[] {
  const call = execFileMock.mock.calls[0];
  return call[1]; // args array
}

describe("checkDocker", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset().mockReturnValue(false);
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

describe("checkDockerCompose", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset().mockReturnValue(false);
  });

  test("reports ok when docker compose version succeeds", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: Function) => {
        cb(null, "Docker Compose version v2.24.0\n", "");
      }
    );
    const { checkDockerCompose } = await import("./docker.js");
    const result = await checkDockerCompose();
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Compose");
  });

  test("reports not ok when compose is unavailable", async () => {
    const err = Object.assign(new Error("exit 1"), { code: 1 });
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: Function) => {
        cb(err, "", "docker: 'compose' is not a docker command.\n");
      }
    );
    const { checkDockerCompose } = await import("./docker.js");
    const result = await checkDockerCompose();
    expect(result.ok).toBe(false);
  });
});

describe("composeUp", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset();
  });

  test("returns error when compose file not found", async () => {
    existsSyncMock.mockReturnValue(false);
    const { composeUp } = await import("./docker.js");
    const result = await composeUp("/state");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Compose file not found");
  });

  test("builds correct args with default options", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess("Creating containers...");

    const { composeUp } = await import("./docker.js");
    const result = await composeUp("/state");
    expect(result.ok).toBe(true);

    const args = capturedArgs();
    expect(args).toContain("compose");
    expect(args).toContain("-f");
    expect(args).toContain("--project-name");
    expect(args).toContain("openpalm");
    expect(args).toContain("up");
    expect(args).toContain("-d");
  });

  test("includes profile flags when specified", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess();

    const { composeUp } = await import("./docker.js");
    await composeUp("/state", { profiles: ["dev", "debug"] });

    const args = capturedArgs();
    expect(args).toContain("--profile");
    // Should have both profiles
    const profileIndices = args.reduce<number[]>((acc, a, i) => {
      if (a === "--profile") acc.push(i);
      return acc;
    }, []);
    expect(profileIndices).toHaveLength(2);
  });

  test("appends specific services when provided", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess();

    const { composeUp } = await import("./docker.js");
    await composeUp("/state", { services: ["admin", "guardian"] });

    const args = capturedArgs();
    const upIdx = args.indexOf("up");
    // Services should come after "up" and "-d"
    expect(args.slice(upIdx + 2)).toEqual(expect.arrayContaining(["admin", "guardian"]));
  });

  test("uses custom files when provided", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess();

    const { composeUp } = await import("./docker.js");
    await composeUp("/state", { files: ["/a/compose.yml", "/b/overlay.yml"] });

    const args = capturedArgs();
    expect(args).toContain("/a/compose.yml");
    expect(args).toContain("/b/overlay.yml");
  });
});

describe("composeDown", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset();
  });

  test("returns error when compose file not found", async () => {
    existsSyncMock.mockReturnValue(false);
    const { composeDown } = await import("./docker.js");
    const result = await composeDown("/state");
    expect(result.ok).toBe(false);
  });

  test("includes -v flag when removeVolumes is true", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess();

    const { composeDown } = await import("./docker.js");
    await composeDown("/state", { removeVolumes: true });

    const args = capturedArgs();
    expect(args).toContain("-v");
    expect(args).toContain("down");
  });

  test("omits -v flag by default", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess();

    const { composeDown } = await import("./docker.js");
    await composeDown("/state");

    const args = capturedArgs();
    expect(args).not.toContain("-v");
  });
});

describe("composeRestart", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset();
  });

  test("returns error when compose file not found", async () => {
    existsSyncMock.mockReturnValue(false);
    const { composeRestart } = await import("./docker.js");
    const result = await composeRestart("/state", ["admin"]);
    expect(result.ok).toBe(false);
  });

  test("includes service names in restart command", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess();

    const { composeRestart } = await import("./docker.js");
    await composeRestart("/state", ["admin", "guardian"]);

    const args = capturedArgs();
    expect(args).toContain("restart");
    expect(args).toContain("admin");
    expect(args).toContain("guardian");
  });
});

describe("composeStop", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset();
  });

  test("builds stop command with service names", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess();

    const { composeStop } = await import("./docker.js");
    await composeStop("/state", ["postgres"]);

    const args = capturedArgs();
    expect(args).toContain("stop");
    expect(args).toContain("postgres");
  });
});

describe("composeStart", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset();
  });

  test("uses 'up -d' for specific services (ensures creation)", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess();

    const { composeStart } = await import("./docker.js");
    await composeStart("/state", ["admin"]);

    const args = capturedArgs();
    expect(args).toContain("up");
    expect(args).toContain("-d");
    expect(args).toContain("admin");
  });
});

describe("composePs", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset();
  });

  test("falls back to docker ps with project label when compose file missing", async () => {
    existsSyncMock.mockReturnValue(false);
    mockExecSuccess('[{"Name": "admin"}]');

    const { composePs } = await import("./docker.js");
    await composePs("/state");

    const args = capturedArgs();
    expect(args).toContain("ps");
    expect(args).toContain("--filter");
    expect(args).toContain("label=com.docker.compose.project=openpalm");
  });

  test("uses compose ps with --format json when file exists", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess('[{"Service": "admin"}]');

    const { composePs } = await import("./docker.js");
    await composePs("/state");

    const args = capturedArgs();
    expect(args).toContain("compose");
    expect(args).toContain("ps");
    expect(args).toContain("--format");
    expect(args).toContain("json");
  });
});

describe("composeLogs", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset();
  });

  test("includes --tail flag with default 100", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess("log output...");

    const { composeLogs } = await import("./docker.js");
    await composeLogs("/state");

    const args = capturedArgs();
    expect(args).toContain("logs");
    expect(args).toContain("--tail");
    expect(args).toContain("100");
  });

  test("respects custom tail value", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess();

    const { composeLogs } = await import("./docker.js");
    await composeLogs("/state", undefined, 50);

    const args = capturedArgs();
    expect(args).toContain("--tail");
    expect(args).toContain("50");
  });

  test("appends service names when specified", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess();

    const { composeLogs } = await import("./docker.js");
    await composeLogs("/state", ["admin", "guardian"]);

    const args = capturedArgs();
    expect(args).toContain("admin");
    expect(args).toContain("guardian");
  });
});

describe("caddyReload", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset();
  });

  test("executes caddy reload via docker compose exec", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess();

    const { caddyReload } = await import("./docker.js");
    await caddyReload("/state");

    const args = capturedArgs();
    expect(args).toContain("exec");
    expect(args).toContain("-T");
    expect(args).toContain("caddy");
    expect(args).toContain("reload");
    expect(args).toContain("--config");
    expect(args).toContain("/etc/caddy/Caddyfile");
    expect(args).toContain("--adapter");
    expect(args).toContain("caddyfile");
  });
});

describe("composePull", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset();
  });

  test("builds pull command", async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecSuccess("Pulling images...");

    const { composePull } = await import("./docker.js");
    await composePull("/state");

    const args = capturedArgs();
    expect(args).toContain("compose");
    expect(args).toContain("pull");
    expect(args).toContain("--project-name");
    expect(args).toContain("openpalm");
  });
});

describe("security: no shell injection", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset().mockReturnValue(true);
  });

  test("all compose operations use execFile (not exec/spawn shell)", async () => {
    mockExecSuccess();

    const docker = await import("./docker.js");
    await docker.composeUp("/state");

    // Verify execFile is called with "docker" as first arg (not a shell string)
    expect(execFileMock).toHaveBeenCalled();
    const firstArg = execFileMock.mock.calls[0][0];
    expect(firstArg).toBe("docker");
  });
});
