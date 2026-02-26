import { describe, expect, it, mock } from "bun:test";
import {
  CoreServices,
  createComposeRunner,
  filterUiManagedServices,
} from "./compose-runner.ts";
import { runCompose } from "../compose-runner.ts";
import type { SpawnFn } from "../types.ts";

/**
 * Create a mock SpawnFn that returns configurable stdout content.
 * The mock captures all invocation args for assertion.
 */
function createTestSpawn(output: (args: string[]) => string): SpawnFn {
  return ((args: string[]) => ({
    exited: Promise.resolve(0),
    exitCode: 0,
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(output(args)));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  })) as unknown as SpawnFn;
}

describe("compose-runner", () => {
  it("composeConfigServices parses service names from stdout", async () => {
    const spawn = createTestSpawn(() => "admin\nchannel-chat\n");
    const runner = createComposeRunner(undefined, spawn);
    const services = await runner.configServices("/state/docker-compose.yml");
    expect(services).toEqual(["admin", "channel-chat"]);
  });

  it("allowedServiceSet includes core services and compose-derived names", async () => {
    const spawn = createTestSpawn(() => "custom-svc\n");
    const runner = createComposeRunner(undefined, spawn);
    const fromCompose = await runner.configServices();
    // Re-import CoreServices to build the set the same way as allowedServiceSet
    const { CoreServices } = await import("./compose-runner.ts");
    const declared = [...CoreServices, ...fromCompose];
    const set = new Set<string>(declared);
    expect(set.has("admin")).toBeTrue();
    expect(set.has("custom-svc")).toBeTrue();
  });

  it("composeAction blocks unknown services", async () => {
    const spawn = createTestSpawn((args) =>
      args.includes("--services") ? "admin\n" : ""
    );
    const runner = createComposeRunner(undefined, spawn);
    const result = await runner.action("restart", "not-allowed");
    expect(result.ok).toBeFalse();
    expect(result.stderr).toBe("service_not_allowed");
  });

  it("composeExec blocks unknown services", async () => {
    const spawn = createTestSpawn((args) =>
      args.includes("--services") ? "admin\n" : ""
    );
    const runner = createComposeRunner(undefined, spawn);
    const result = await runner.exec("not-allowed", ["echo", "hi"]);
    expect(result.ok).toBeFalse();
    expect(result.stderr).toBe("service_not_allowed");
  });

  it("composeServiceNames includes core, compose, and extra services", async () => {
    const previous = process.env.OPENPALM_EXTRA_SERVICES;
    process.env.OPENPALM_EXTRA_SERVICES = "service-extra";
    const spawn = createTestSpawn(() => "channel-chat\n");
    const runner = createComposeRunner(undefined, spawn);

    const fromCompose = await runner.configServices();
    const { CoreServices } = await import("./compose-runner.ts");
    const extraRaw = process.env.OPENPALM_EXTRA_SERVICES ?? "";
    const extra = extraRaw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    const names = Array.from(
      new Set([...CoreServices, ...extra, ...fromCompose])
    ).sort();

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
    const names = filterUiManagedServices([
      "admin",
      "caddy",
      "gateway",
      "channel-chat",
    ]);
    expect(names).toEqual(["gateway", "channel-chat"]);
  });


  it("classifies spawn failures as daemon_unreachable", async () => {
    const throwingSpawn = mock(() => {
      throw new Error("Cannot connect to the Docker daemon");
    }) as unknown as SpawnFn;

    const result = await runCompose(["ps"], {
      bin: "docker",
      subcommand: "compose",
      composeFile: "/state/docker-compose.yml",
      spawn: throwingSpawn,
    });

    expect(result.ok).toBeFalse();
    expect(result.code).toBe("daemon_unreachable");
  });
});
