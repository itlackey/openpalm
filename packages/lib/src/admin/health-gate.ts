import { readFileSync } from "node:fs";
import YAML from "yaml";
import { type ComposeRunner, createComposeRunner, type ServiceHealthState } from "./compose-runner.ts";

export type ServiceHealthConfig = {
  service: string;
  timeoutMs: number;
  requiresHealthcheck: boolean;
};

export type HealthGateResult = {
  ok: boolean;
  service: string;
  last?: ServiceHealthState;
  error?: string;
};

export function resolveServiceHealthConfig(composeFilePath: string, service: string): ServiceHealthConfig {
  const raw = readFileSync(composeFilePath, "utf8");
  const doc = YAML.parse(raw) as Record<string, unknown>;
  const services = (doc.services ?? {}) as Record<string, Record<string, unknown>>;
  const entry = services[service] ?? {};
  const healthcheck = (entry.healthcheck ?? null) as Record<string, unknown> | null;
  if (!healthcheck) {
    return { service, timeoutMs: 30_000, requiresHealthcheck: false };
  }
  if (process.env.OPENPALM_HEALTH_GATE_TIMEOUT_MS) {
    const override = Number(process.env.OPENPALM_HEALTH_GATE_TIMEOUT_MS);
    if (Number.isFinite(override) && override > 0) {
      return { service, timeoutMs: override, requiresHealthcheck: true };
    }
  }
  const interval = parseDurationMs(healthcheck.interval, 10_000);
  const retries = typeof healthcheck.retries === "number" ? healthcheck.retries : 3;
  const startPeriod = parseDurationMs(healthcheck.start_period, 0);
  const timeoutMs = startPeriod + interval * Math.max(retries, 1);
  return { service, timeoutMs, requiresHealthcheck: true };
}

function parseDurationMs(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return fallback;
  const match = /^([0-9]+)(ms|s|m)?$/.exec(value.trim());
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  if (unit === "ms") return amount;
  if (unit === "m") return amount * 60_000;
  return amount * 1000;
}

export async function pollUntilHealthy(config: ServiceHealthConfig, runner?: ComposeRunner): Promise<HealthGateResult> {
  const r = runner ?? createComposeRunner();
  const deadline = Date.now() + config.timeoutMs;
  let last: ServiceHealthState | undefined;
  while (Date.now() < deadline) {
    const result = await r.ps();
    if (!result.ok) {
      return { ok: false, service: config.service, error: result.stderr };
    }
    last = result.services.find((svc) => svc.name === config.service);
    if (last) {
      const running = last.status === "running" || last.status === "running (healthy)";
      if (config.requiresHealthcheck) {
        if (running && last.health === "healthy") return { ok: true, service: config.service, last };
      } else if (running) {
        return { ok: true, service: config.service, last };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, service: config.service, last, error: "health_gate_timeout" };
}
