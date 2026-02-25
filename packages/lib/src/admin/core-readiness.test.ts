import { describe, expect, it } from "bun:test";
import { createMockRunner } from "./compose-runner.ts";
import { ensureCoreServicesReady } from "./core-readiness.ts";

describe("ensureCoreServicesReady", () => {
  it("returns ready when all target services are running and healthy or have no healthcheck", async () => {
    const runner = createMockRunner({
      ps: async () => ({
        ok: true,
        stderr: "",
        services: [
          { name: "gateway", status: "running", health: "healthy" },
          { name: "assistant", status: "running", health: null },
        ],
      }),
    });

    const result = await ensureCoreServicesReady({
      runner,
      targetServices: ["gateway", "assistant"],
    });

    expect(result).toEqual({
      ok: true,
      code: "ready",
      checks: [
        { service: "gateway", state: "ready", status: "running", health: "healthy" },
        { service: "assistant", state: "ready", status: "running", health: null },
      ],
      diagnostics: { failedServices: [] },
    });
  });

  it("returns setup_not_ready when a target service is missing", async () => {
    const runner = createMockRunner({
      ps: async () => ({
        ok: true,
        stderr: "",
        services: [{ name: "gateway", status: "running", health: "healthy" }],
      }),
    });

    const result = await ensureCoreServicesReady({
      runner,
      targetServices: ["gateway", "assistant"],
    });

    expect(result.ok).toBeFalse();
    expect(result.code).toBe("setup_not_ready");
    expect(result.diagnostics.failedServices).toEqual([
      {
        service: "assistant",
        state: "not_ready",
        status: "missing",
        health: null,
        reason: "missing",
      },
    ]);
  });

  it("returns setup_not_ready when service is running but health is not healthy", async () => {
    const runner = createMockRunner({
      ps: async () => ({
        ok: true,
        stderr: "",
        services: [{ name: "gateway", status: "running", health: "starting" }],
      }),
    });

    const result = await ensureCoreServicesReady({
      runner,
      targetServices: ["gateway"],
    });

    expect(result.ok).toBeFalse();
    expect(result.code).toBe("setup_not_ready");
    expect(result.diagnostics.failedServices).toEqual([
      {
        service: "gateway",
        state: "not_ready",
        status: "running",
        health: "starting",
        reason: "unhealthy",
      },
    ]);
  });

  it("returns setup_not_ready when service status is not running", async () => {
    const runner = createMockRunner({
      ps: async () => ({
        ok: true,
        stderr: "",
        services: [{ name: "gateway", status: "exited", health: null }],
      }),
    });

    const result = await ensureCoreServicesReady({
      runner,
      targetServices: ["gateway"],
    });

    expect(result.ok).toBeFalse();
    expect(result.code).toBe("setup_not_ready");
    expect(result.diagnostics.failedServices).toEqual([
      {
        service: "gateway",
        state: "not_ready",
        status: "exited",
        health: null,
        reason: "not_running",
      },
    ]);
  });

  it("returns compose_ps_failed when runner.ps fails and surfaces stderr diagnostics", async () => {
    const runner = createMockRunner({
      ps: async () => ({
        ok: false,
        stderr: "docker daemon unreachable",
        services: [],
      }),
    });

    const result = await ensureCoreServicesReady({
      runner,
      targetServices: ["gateway", "assistant"],
    });

    expect(result.ok).toBeFalse();
    expect(result.code).toBe("compose_ps_failed");
    expect(result.diagnostics.composePsStderr).toBe("docker daemon unreachable");
    expect(result.diagnostics.failedServices).toEqual([
      {
        service: "gateway",
        state: "not_ready",
        status: "unknown",
        health: null,
      },
      {
        service: "assistant",
        state: "not_ready",
        status: "unknown",
        health: null,
      },
    ]);
  });

  it("defaults to CoreServices targets when targetServices is omitted", async () => {
    const runner = createMockRunner({
      ps: async () => ({
        ok: true,
        stderr: "",
        services: [],
      }),
    });

    const result = await ensureCoreServicesReady({ runner });
    expect(result.ok).toBeFalse();
    expect(result.code).toBe("setup_not_ready");
    expect(result.checks.length).toBeGreaterThan(0);
  });
});
