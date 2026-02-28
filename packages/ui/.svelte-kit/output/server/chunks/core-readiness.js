import { createComposeRunner, CoreServices } from "./compose-runner.js";
const DefaultProbeTimeoutMs = 3e3;
async function ensureCoreServicesReady(options = {}) {
  const runner = options.runner ?? createComposeRunner();
  const targetServices = options.targetServices ?? CoreServices;
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
  const pollIntervalMs = normalizePollIntervalMs(options.pollIntervalMs);
  const sleep = options.sleep ?? defaultSleep;
  const fetchImpl = options.fetchImpl ?? fetch;
  const probeTimeoutMs = normalizeProbeTimeoutMs(options.probeTimeoutMs);
  let lastChecks = [];
  let lastComposePsStderr = "";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const psResult = await runner.ps();
    if (psResult.stderr) {
      lastComposePsStderr = psResult.stderr;
    }
    if (!psResult.ok) {
      const failedServices3 = targetServices.map((service) => ({
        service,
        state: "not_ready",
        status: "unknown",
        health: null
      }));
      return {
        ok: false,
        code: "compose_ps_failed",
        checks: failedServices3,
        diagnostics: {
          composePsStderr: psResult.stderr,
          failedServices: failedServices3
        }
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
      probeTimeoutMs
    );
    const checksWithProbes = applyProbeFailuresToChecks(checks, probeFailures);
    const failedServices2 = checksWithProbes.filter((service) => service.state === "not_ready");
    if (failedServices2.length === 0) {
      return {
        ok: true,
        code: "ready",
        checks: checksWithProbes,
        diagnostics: {
          failedServices: []
        }
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
      failedServiceLogs
    }
  };
}
function normalizeMaxAttempts(value) {
  if (!Number.isFinite(value)) return 12;
  return Math.max(1, Math.floor(value));
}
function normalizePollIntervalMs(value) {
  if (!Number.isFinite(value)) return 1e3;
  return Math.max(0, Math.floor(value));
}
function normalizeProbeTimeoutMs(value) {
  if (!Number.isFinite(value)) return DefaultProbeTimeoutMs;
  return Math.max(1, Math.floor(value));
}
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
async function collectFailedServiceLogs(runner, failedServices) {
  const names = Array.from(
    new Set(
      failedServices.map((service) => service.service).filter((service) => service.length > 0)
    )
  );
  const entries = await Promise.all(
    names.map(async (service) => {
      const result = await runner.logs(service, 200);
      if (result.ok) {
        return [service, result.stdout];
      }
      const detail = result.stderr || "log_collection_failed";
      return [service, `log_fetch_failed:${detail}`];
    })
  );
  return Object.fromEntries(entries);
}
function buildReadinessChecks(services, targetServices) {
  const byName = new Map(
    services.map((service) => [service.name, service])
  );
  return targetServices.map((serviceName) => {
    const service = byName.get(serviceName);
    if (!service) {
      return {
        service: serviceName,
        state: "not_ready",
        status: "missing",
        health: null,
        reason: "missing"
      };
    }
    const isRunning = service.status.toLowerCase().includes("running");
    if (!isRunning) {
      return {
        service: serviceName,
        state: "not_ready",
        status: service.status,
        health: service.health ?? null,
        reason: "not_running"
      };
    }
    const hasHealthcheck = typeof service.health === "string" && service.health.length > 0;
    if (hasHealthcheck && service.health !== "healthy") {
      return {
        service: serviceName,
        state: "not_ready",
        status: service.status,
        health: service.health,
        reason: "unhealthy"
      };
    }
    return {
      service: serviceName,
      state: "ready",
      status: service.status,
      health: service.health ?? null
    };
  });
}
function probeConfigForService(service) {
  if (service === "admin") {
    return {
      url: `${trimTrailingSlash(envValue("OPENPALM_ADMIN_API_URL") ?? "http://admin:8100")}/health`,
      expectJson: true
    };
  }
  if (service === "gateway") {
    return {
      url: `${trimTrailingSlash(envValue("GATEWAY_URL") ?? "http://gateway:8080")}/health`,
      expectJson: true
    };
  }
  if (service === "assistant") {
    return {
      url: `${trimTrailingSlash(envValue("OPENPALM_ASSISTANT_URL") ?? "http://assistant:4096")}/`,
      expectJson: false
    };
  }
  if (service === "openmemory") {
    return {
      url: `${trimTrailingSlash(envValue("OPENMEMORY_URL") ?? "http://openmemory:8765")}/api/v1/config/`,
      expectJson: true
    };
  }
  return null;
}
async function runHttpReadinessProbes(targetServices, fetchImpl, timeoutMs) {
  const probeTargets = targetServices.map((service) => ({ service, config: probeConfigForService(service) })).filter((entry) => entry.config !== null);
  const probeResults = await Promise.all(
    probeTargets.map(async ({ service, config }) => {
      const probe = await runHttpProbe(config, fetchImpl, timeoutMs);
      if (probe.ok) return null;
      return {
        service,
        url: config.url,
        error: probe.error
      };
    })
  );
  return probeResults.filter((result) => result !== null);
}
async function runHttpProbe(config, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(config.url, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      return { ok: false, error: `status ${response.status}` };
    }
    if (!config.expectJson) {
      return { ok: true };
    }
    const body = await response.json();
    if (body.ok === false) {
      return { ok: false, error: "body.ok false" };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
function applyProbeFailuresToChecks(checks, probeFailures) {
  if (probeFailures.length === 0) {
    return checks;
  }
  const failuresByService = new Map(
    probeFailures.map((failure) => [failure.service, failure])
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
      probeError: failure.error
    };
  });
}
function envValue(name) {
  const bunEnv = globalThis.Bun?.env;
  return bunEnv?.[name] ?? process.env[name];
}
function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
export {
  ensureCoreServicesReady
};
