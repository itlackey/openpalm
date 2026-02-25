import { describe, expect, it } from "bun:test";
import { createMockRunner } from "./compose-runner.ts";
import { ensureCoreServicesReady } from "./core-readiness.ts";

const ProbeEnvVars = [
  "OPENPALM_ADMIN_API_URL",
  "GATEWAY_URL",
  "OPENPALM_ASSISTANT_URL",
  "OPENMEMORY_URL",
] as const;

async function withProbeEnv(
  overrides: Partial<Record<(typeof ProbeEnvVars)[number], string>>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const name of ProbeEnvVars) {
    previous.set(name, process.env[name]);
    const next = overrides[name];
    if (next === undefined) {
      delete process.env[name];
      continue;
    }
    process.env[name] = next;
  }

  try {
    await run();
  } finally {
    for (const name of ProbeEnvVars) {
      const value = previous.get(name);
      if (value === undefined) {
        delete process.env[name];
        continue;
      }
      process.env[name] = value;
    }
  }
}

const healthyProbeFetch = async () => {
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true };
    },
  } as Response;
};

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
      fetchImpl: healthyProbeFetch,
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
      fetchImpl: healthyProbeFetch,
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
    expect(result.diagnostics.composePsStderr).toBe("");
    expect(result.diagnostics.failedServiceLogs).toEqual({
      gateway: "",
    });
  });

  it("collects failed service logs and preserves raw compose ps stderr", async () => {
    const runner = createMockRunner({
      ps: async () => ({
        ok: true,
        stderr: "compose warning: stale orphan",
        services: [{ name: "gateway", status: "running", health: "starting" }],
      }),
      logs: async (service) => {
        if (service === "gateway") {
          return { ok: true, stdout: "gateway-log-line", stderr: "" };
        }
        return { ok: false, stdout: "", stderr: "service_not_allowed" };
      },
    });

    const result = await ensureCoreServicesReady({
      runner,
      targetServices: ["gateway"],
      maxAttempts: 1,
      fetchImpl: healthyProbeFetch,
    });

    expect(result.ok).toBeFalse();
    expect(result.code).toBe("setup_not_ready");
    expect(result.diagnostics.composePsStderr).toBe("compose warning: stale orphan");
    expect(result.diagnostics.failedServiceLogs).toEqual({
      gateway: "gateway-log-line",
    });
  });

  it("retains latest non-empty compose ps stderr across retries", async () => {
    let psCalls = 0;
    const runner = createMockRunner({
      ps: async () => {
        psCalls += 1;
        if (psCalls === 1) {
          return {
            ok: true,
            stderr: "compose warning: first attempt had partial timeout",
            services: [{ name: "gateway", status: "running", health: "starting" }],
          };
        }
        return {
          ok: true,
          stderr: "",
          services: [{ name: "gateway", status: "running", health: "starting" }],
        };
      },
      logs: async () => ({
        ok: true,
        stdout: "gateway-late-log",
        stderr: "",
      }),
    });

    const result = await ensureCoreServicesReady({
      runner,
      targetServices: ["gateway"],
      maxAttempts: 3,
      pollIntervalMs: 0,
      sleep: async () => {},
      fetchImpl: healthyProbeFetch,
    });

    expect(result.ok).toBeFalse();
    expect(result.code).toBe("setup_not_ready");
    expect(result.diagnostics.composePsStderr).toBe(
      "compose warning: first attempt had partial timeout",
    );
    expect(result.diagnostics.failedServiceLogs).toEqual({
      gateway: "gateway-late-log",
    });
  });

  it("surfaces log collection failures in diagnostics", async () => {
    const runner = createMockRunner({
      ps: async () => ({
        ok: true,
        stderr: "",
        services: [{ name: "openmemory", status: "running", health: "starting" }],
      }),
      logs: async () => ({
        ok: false,
        stdout: "",
        stderr: "permission_denied",
      }),
    });

    const result = await ensureCoreServicesReady({
      runner,
      targetServices: ["openmemory"],
      maxAttempts: 1,
      fetchImpl: healthyProbeFetch,
    });

    expect(result.ok).toBeFalse();
    expect(result.code).toBe("setup_not_ready");
    expect(result.diagnostics.failedServiceLogs).toEqual({
      openmemory: "log_fetch_failed:permission_denied",
    });
  });

  it("uses explicit fallback detail when log collection fails without stderr", async () => {
    const runner = createMockRunner({
      ps: async () => ({
        ok: true,
        stderr: "compose warning: timeout while inspecting health",
        services: [{ name: "gateway", status: "running", health: "starting" }],
      }),
      logs: async () => ({
        ok: false,
        stdout: "",
        stderr: "",
      }),
    });

    const result = await ensureCoreServicesReady({
      runner,
      targetServices: ["gateway"],
      maxAttempts: 1,
      fetchImpl: healthyProbeFetch,
    });

    expect(result.ok).toBeFalse();
    expect(result.code).toBe("setup_not_ready");
    expect(result.diagnostics.composePsStderr).toBe("compose warning: timeout while inspecting health");
    expect(result.diagnostics.failedServiceLogs).toEqual({
      gateway: "log_fetch_failed:log_collection_failed",
    });
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

  it("requires HTTP readiness probes for admin, gateway, assistant, and openmemory", async () => {
    await withProbeEnv(
      {
        OPENPALM_ADMIN_API_URL: "http://admin-proxy:18100/",
        GATEWAY_URL: "http://gateway-proxy:18080/",
        OPENPALM_ASSISTANT_URL: "http://assistant-proxy:14096/",
        OPENMEMORY_URL: "http://openmemory-proxy:18765/",
      },
      async () => {
        const runner = createMockRunner({
          ps: async () => ({
            ok: true,
            stderr: "",
            services: [
              { name: "admin", status: "running", health: "healthy" },
              { name: "gateway", status: "running", health: "healthy" },
              { name: "assistant", status: "running", health: "healthy" },
              { name: "openmemory", status: "running", health: "healthy" },
            ],
          }),
        });

        const urls: string[] = [];
        const fetchImpl = async (input: RequestInfo | URL) => {
          const url = String(input);
          urls.push(url);
          return {
            ok: true,
            status: 200,
            async json() {
              return { ok: true };
            },
          } as Response;
        };

        const result = await ensureCoreServicesReady({
          runner,
          targetServices: ["admin", "gateway", "assistant", "openmemory"],
          maxAttempts: 1,
          fetchImpl,
        });

        expect(result.ok).toBeTrue();
        expect(result.code).toBe("ready");
        expect(urls).toEqual([
          "http://admin-proxy:18100/health",
          "http://gateway-proxy:18080/health",
          "http://assistant-proxy:14096/",
          "http://openmemory-proxy:18765/api/v1/config/",
        ]);
      },
    );
  });

  it("marks probe failures not_ready with actionable URL and error details", async () => {
    await withProbeEnv(
      {
        OPENPALM_ADMIN_API_URL: "http://admin:8100",
        GATEWAY_URL: "http://gateway:8080",
        OPENPALM_ASSISTANT_URL: "http://assistant:4096",
        OPENMEMORY_URL: "http://openmemory:8765",
      },
      async () => {
        const runner = createMockRunner({
          ps: async () => ({
            ok: true,
            stderr: "",
            services: [
              { name: "admin", status: "running", health: "healthy" },
              { name: "gateway", status: "running", health: "healthy" },
              { name: "assistant", status: "running", health: "healthy" },
              { name: "openmemory", status: "running", health: "healthy" },
            ],
          }),
        });

        const fetchImpl = async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "http://gateway:8080/health") {
            return {
              ok: false,
              status: 503,
              async json() {
                return {};
              },
            } as Response;
          }
          if (url === "http://openmemory:8765/api/v1/config/") {
            throw new Error("connect ECONNREFUSED");
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return { ok: true };
            },
          } as Response;
        };

        const result = await ensureCoreServicesReady({
          runner,
          targetServices: ["admin", "gateway", "assistant", "openmemory"],
          maxAttempts: 1,
          fetchImpl,
        });

        expect(result.ok).toBeFalse();
        expect(result.code).toBe("setup_not_ready");
        expect(result.diagnostics.failedServices).toEqual([
          {
            service: "gateway",
            state: "not_ready",
            status: "running",
            health: "healthy",
            reason: "http_probe_failed",
            probeUrl: "http://gateway:8080/health",
            probeError: "status 503",
          },
          {
            service: "openmemory",
            state: "not_ready",
            status: "running",
            health: "healthy",
            reason: "http_probe_failed",
            probeUrl: "http://openmemory:8765/api/v1/config/",
            probeError: "connect ECONNREFUSED",
          },
        ]);
      },
    );
  });
});
