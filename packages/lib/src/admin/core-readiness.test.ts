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
      maxAttempts: 1,
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
      maxAttempts: 1,
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
      maxAttempts: 1,
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

  it("retries until ready within maxAttempts and sleeps between attempts", async () => {
    let psCalls = 0;
    const sleepCalls: number[] = [];
    const runner = createMockRunner({
      ps: async () => {
        psCalls += 1;
        if (psCalls === 1) {
          return {
            ok: true,
            stderr: "",
            services: [{ name: "gateway", status: "running", health: "starting" }],
          };
        }
        return {
          ok: true,
          stderr: "",
          services: [{ name: "gateway", status: "running", health: "healthy" }],
        };
      },
    });

    const result = await ensureCoreServicesReady({
      runner,
      targetServices: ["gateway"],
      maxAttempts: 3,
      pollIntervalMs: 7,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(result.ok).toBeTrue();
    expect(result.code).toBe("ready");
    expect(psCalls).toBe(2);
    expect(sleepCalls).toEqual([7]);
  });

  it("returns setup_not_ready after maxAttempts when still not ready", async () => {
    let psCalls = 0;
    const sleepCalls: number[] = [];
    const runner = createMockRunner({
      ps: async () => {
        psCalls += 1;
        return {
          ok: true,
          stderr: "",
          services: [{ name: "gateway", status: "running", health: "starting" }],
        };
      },
    });

    const result = await ensureCoreServicesReady({
      runner,
      targetServices: ["gateway"],
      maxAttempts: 3,
      pollIntervalMs: 5,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(result.ok).toBeFalse();
    expect(result.code).toBe("setup_not_ready");
    expect(psCalls).toBe(3);
    expect(sleepCalls).toEqual([5, 5]);
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

  it("coerces maxAttempts lower bound to one attempt", async () => {
    let psCalls = 0;
    const sleepCalls: number[] = [];
    const runner = createMockRunner({
      ps: async () => {
        psCalls += 1;
        return {
          ok: true,
          stderr: "",
          services: [{ name: "gateway", status: "running", health: "starting" }],
        };
      },
    });

    const result = await ensureCoreServicesReady({
      runner,
      targetServices: ["gateway"],
      maxAttempts: 0,
      pollIntervalMs: 11,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(result.ok).toBeFalse();
    expect(result.code).toBe("setup_not_ready");
    expect(psCalls).toBe(1);
    expect(sleepCalls).toEqual([]);
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

    const result = await ensureCoreServicesReady({ runner, maxAttempts: 1 });
    expect(result.ok).toBeFalse();
    expect(result.code).toBe("setup_not_ready");
    expect(result.checks.length).toBeGreaterThan(0);
  });
});
