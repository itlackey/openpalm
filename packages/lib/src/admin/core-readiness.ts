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
};

export async function ensureCoreServicesReady(
  options: EnsureCoreServicesReadyOptions = {},
): Promise<EnsureCoreServicesReadyResult> {
  const runner = options.runner ?? createComposeRunner();
  const targetServices = options.targetServices ?? CoreServices;
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
  if (failedServices.length > 0) {
    return {
      ok: false,
      code: "setup_not_ready",
      checks,
      diagnostics: {
        failedServices,
      },
    };
  }

  return {
    ok: true,
    code: "ready",
    checks,
    diagnostics: {
      failedServices: [],
    },
  };
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
