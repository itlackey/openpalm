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
  fetchImpl?: FetchLike;
  probeTimeoutMs?: number;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type HttpProbeConfig = {
  url: string;
  expectJson?: boolean;
};

type HttpProbeFailure = {
  service: string;
  url: string;
  error: string;
};

const DefaultProbeTimeoutMs = 3_000;

export async function ensureCoreServicesReady(
  options: EnsureCoreServicesReadyOptions = {},
): Promise<EnsureCoreServicesReadyResult> {
  const runner = options.runner ?? createComposeRunner();
  const targetServices = options.targetServices ?? CoreServices;
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
  const pollIntervalMs = normalizePollIntervalMs(options.pollIntervalMs);
  const sleep = options.sleep ?? defaultSleep;
  const fetchImpl = options.fetchImpl ?? fetch;
  const probeTimeoutMs = normalizeProbeTimeoutMs(options.probeTimeoutMs);

  let lastChecks: CoreServiceReadinessCheck[] = [];
  let lastComposePsStderr = "";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const psResult = await runner.ps();
    if (psResult.stderr) {
      lastComposePsStderr = psResult.stderr;
    }

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
    const composeFailedServices = checks.filter((service) => service.state === "not_ready");
    if (composeFailedServices.length > 0) {
      lastChecks = checks;
      if (attempt < maxAttempts - 1) {
        await sleep(pollIntervalMs);
      }
      continue;
    }

    const probeFailures = await runHttpReadinessProbes(
      targetServices,
      fetchImpl,
      probeTimeoutMs,
    );
    const checksWithProbes = applyProbeFailuresToChecks(checks, probeFailures);
    const failedServices = checksWithProbes.filter((service) => service.state === "not_ready");
    if (failedServices.length === 0) {
      return {
        ok: true,
        code: "ready",
        checks: checksWithProbes,
        diagnostics: {
          failedServices: [],
        },
      };
    }

    lastChecks = checksWithProbes;
    if (attempt < maxAttempts - 1) {
      await sleep(pollIntervalMs);
    }
  }

  const failedServices = lastChecks.filter((service) => service.state === "not_ready");
  const failedServiceLogs = await collectFailedServiceLogs(runner, failedServices);

  return {
    ok: false,
    code: "setup_not_ready",
    checks: lastChecks,
    diagnostics: {
      composePsStderr: lastComposePsStderr,
      failedServices,
      failedServiceLogs,
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

function normalizeProbeTimeoutMs(value?: number): number {
  if (!Number.isFinite(value)) return DefaultProbeTimeoutMs;
  return Math.max(1, Math.floor(value as number));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function collectFailedServiceLogs(
  runner: ComposeRunner,
  failedServices: CoreServiceReadinessCheck[],
): Promise<Record<string, string>> {
  const names = Array.from(
    new Set(
      failedServices
        .map((service) => service.service)
        .filter((service) => service.length > 0),
    ),
  );

  const entries = await Promise.all(
    names.map(async (service) => {
      const result = await runner.logs(service, 200);
      if (result.ok) {
        return [service, result.stdout] as const;
      }
      const detail = result.stderr || "log_collection_failed";
      return [service, `log_fetch_failed:${detail}`] as const;
    }),
  );

  return Object.fromEntries(entries);
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

function probeConfigForService(service: string): HttpProbeConfig | null {
  if (service === "admin") {
    return {
      url: `${trimTrailingSlash(envValue("OPENPALM_ADMIN_API_URL") ?? "http://admin:8100")}/health`,
      expectJson: true,
    };
  }
  if (service === "gateway") {
    return {
      url: `${trimTrailingSlash(envValue("GATEWAY_URL") ?? "http://gateway:8080")}/health`,
      expectJson: true,
    };
  }
  if (service === "assistant") {
    return {
      url: `${trimTrailingSlash(envValue("OPENPALM_ASSISTANT_URL") ?? "http://assistant:4096")}/`,
      expectJson: false,
    };
  }
  if (service === "openmemory") {
    return {
      url: `${trimTrailingSlash(envValue("OPENMEMORY_URL") ?? "http://openmemory:8765")}/api/v1/config/`,
      expectJson: true,
    };
  }
  return null;
}

async function runHttpReadinessProbes(
  targetServices: readonly string[],
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<HttpProbeFailure[]> {
  const probeTargets = targetServices
    .map((service) => ({ service, config: probeConfigForService(service) }))
    .filter((entry): entry is { service: string; config: HttpProbeConfig } => entry.config !== null);

  const probeResults = await Promise.all(
    probeTargets.map(async ({ service, config }) => {
      const probe = await runHttpProbe(config, fetchImpl, timeoutMs);
      if (probe.ok) return null;
      return {
        service,
        url: config.url,
        error: probe.error,
      };
    }),
  );

  return probeResults.filter((result): result is HttpProbeFailure => result !== null);
}

async function runHttpProbe(
  config: HttpProbeConfig,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(config.url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, error: `status ${response.status}` };
    }

    if (!config.expectJson) {
      return { ok: true };
    }

    const body = await response.json() as { ok?: boolean };
    if (body.ok === false) {
      return { ok: false, error: "body.ok false" };
    }

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function applyProbeFailuresToChecks(
  checks: CoreServiceReadinessCheck[],
  probeFailures: HttpProbeFailure[],
): CoreServiceReadinessCheck[] {
  if (probeFailures.length === 0) {
    return checks;
  }

  const failuresByService = new Map<string, HttpProbeFailure>(
    probeFailures.map((failure) => [failure.service, failure]),
  );

  return checks.map((check) => {
    const failure = failuresByService.get(check.service);
    if (!failure) {
      return check;
    }
    return {
      ...check,
      state: "not_ready",
      reason: "http_probe_failed",
      probeUrl: failure.url,
      probeError: failure.error,
    };
  });
}

function envValue(name: string): string | undefined {
  const bunEnv = (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun?.env;
  return bunEnv?.[name] ?? process.env[name];
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
