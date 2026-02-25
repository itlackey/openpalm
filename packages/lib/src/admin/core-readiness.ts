import type {
  CoreServiceReadinessCheck,
  EnsureCoreServicesReadyResult,
} from "../types.ts";
import {
  CoreServices,
  createComposeRunner,
  type ComposeRunner,
  type ServiceHealthState,
} from "./compose-runner.ts";

export type EnsureCoreServicesReadyOptions = {
  runner?: ComposeRunner;
  targetServices?: readonly string[];
  maxAttempts?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export async function ensureCoreServicesReady(
  options: EnsureCoreServicesReadyOptions = {},
): Promise<EnsureCoreServicesReadyResult> {
  const runner = options.runner ?? createComposeRunner();
  const targetServices = options.targetServices ?? CoreServices;
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
  const pollIntervalMs = normalizePollIntervalMs(options.pollIntervalMs);
  const sleep = options.sleep ?? defaultSleep;

  let lastChecks: CoreServiceReadinessCheck[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const psResult = await runner.ps();

    if (!psResult.ok) {
      const failedServices = targetServices.map((service) => ({
        service,
        state: "not_ready" as const,
        status: "unknown",
        health: null,
      }));
      return {
        ok: false,
        code: "compose_ps_failed",
        checks: failedServices,
        diagnostics: {
          composePsStderr: psResult.stderr,
          failedServices,
        },
      };
    }

    const checks = buildReadinessChecks(psResult.services, targetServices);
    const failedServices = checks.filter((service) => service.state === "not_ready");
    if (failedServices.length === 0) {
      return {
        ok: true,
        code: "ready",
        checks,
        diagnostics: {
          failedServices: [],
        },
      };
    }

    lastChecks = checks;
    if (attempt < maxAttempts - 1) {
      await sleep(pollIntervalMs);
    }
  }

  return {
    ok: false,
    code: "setup_not_ready",
    checks: lastChecks,
    diagnostics: {
      failedServices: lastChecks.filter((service) => service.state === "not_ready"),
    },
  };
}

function normalizeMaxAttempts(value?: number): number {
  if (!Number.isFinite(value)) return 12;
  return Math.max(1, Math.floor(value as number));
}

function normalizePollIntervalMs(value?: number): number {
  if (!Number.isFinite(value)) return 1_000;
  return Math.max(0, Math.floor(value as number));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildReadinessChecks(
  services: ServiceHealthState[],
  targetServices: readonly string[],
): CoreServiceReadinessCheck[] {
  const byName = new Map<string, ServiceHealthState>(
    services.map((service) => [service.name, service]),
  );

  return targetServices.map((serviceName) => {
    const service = byName.get(serviceName);
    if (!service) {
      return {
        service: serviceName,
        state: "not_ready",
        status: "missing",
        health: null,
        reason: "missing",
      };
    }

    const isRunning = service.status.toLowerCase().includes("running");
    if (!isRunning) {
      return {
        service: serviceName,
        state: "not_ready",
        status: service.status,
        health: service.health ?? null,
        reason: "not_running",
      };
    }

    const hasHealthcheck = typeof service.health === "string" && service.health.length > 0;
    if (hasHealthcheck && service.health !== "healthy") {
      return {
        service: serviceName,
        state: "not_ready",
        status: service.status,
        health: service.health,
        reason: "unhealthy",
      };
    }

    return {
      service: serviceName,
      state: "ready",
      status: service.status,
      health: service.health ?? null,
    };
  });
}
