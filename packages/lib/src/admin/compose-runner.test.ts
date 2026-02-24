import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import {
  allowedServiceSet,
  composeAction,
  composeConfigServices,
  composeExec,
  composeServiceNames,
  filterUiManagedServices,
} from "./compose-runner.ts";
import { runCompose } from "../compose-runner.ts";

describe("compose-runner", () => {
  let originalSpawn: typeof Bun.spawn;
  let spawnOutput: (args: string[]) => string;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    spawnOutput = () => "";
    const spawnMock = mock((args: string[]) => ({
      exited: Promise.resolve(0),
      exitCode: 0,
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(spawnOutput(args)));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    }));
    Bun.spawn = spawnMock as unknown as typeof Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    mock.restore();
  });

  it("composeConfigServices parses service names from stdout", async () => {
    spawnOutput = () => "admin\nchannel-chat\n";

    const services = await composeConfigServices("/state/docker-compose.yml");
    expect(services).toEqual(["admin", "channel-chat"]);
  });

  it("allowedServiceSet includes core services and compose-derived names", async () => {
    spawnOutput = () => "custom-svc\n";

    const set = await allowedServiceSet();
    expect(set.has("admin")).toBeTrue();
    expect(set.has("custom-svc")).toBeTrue();
  });

  it("composeAction blocks unknown services", async () => {
    spawnOutput = (args) => (args.includes("--services") ? "admin\n" : "");

    const result = await composeAction("restart", "not-allowed");
    expect(result.ok).toBeFalse();
    expect(result.stderr).toBe("service_not_allowed");
  });

  it("composeExec blocks unknown services", async () => {
    spawnOutput = (args) => (args.includes("--services") ? "admin\n" : "");

    const result = await composeExec("not-allowed", ["echo", "hi"]);
    expect(result.ok).toBeFalse();
    expect(result.stderr).toBe("service_not_allowed");
  });

  it("composeServiceNames includes core, compose, and extra services", async () => {
    const previous = process.env.OPENPALM_EXTRA_SERVICES;
    process.env.OPENPALM_EXTRA_SERVICES = "service-extra";
    spawnOutput = () => "channel-chat\n";

    const names = await composeServiceNames();
    expect(names).toContain("admin");
    expect(names).toContain("channel-chat");
    expect(names).toContain("service-extra");

    if (previous === undefined) {
      delete process.env.OPENPALM_EXTRA_SERVICES;
    } else {
      process.env.OPENPALM_EXTRA_SERVICES = previous;
    }
  });

  it("filterUiManagedServices excludes admin and caddy", () => {
    const names = filterUiManagedServices(["admin", "caddy", "gateway", "channel-chat"]);
    expect(names).toEqual(["gateway", "channel-chat"]);
  });

  it("classifies spawn failures as daemon_unreachable", async () => {
    const spawnMock = mock(() => {
      throw new Error("Cannot connect to the Docker daemon");
    });
    Bun.spawn = spawnMock as unknown as typeof Bun.spawn;

    const result = await runCompose(["ps"], {
      bin: "docker",
      subcommand: "compose",
      composeFile: "/state/docker-compose.yml",
    });

    expect(result.ok).toBeFalse();
    expect(result.code).toBe("daemon_unreachable");
  });
});
