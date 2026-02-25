/**
 * Shared helper to parse `docker compose ps --format json` output and
 * compute missing or unhealthy core services.
 *
 * Reusable across E2E tests that need to verify post-setup container state.
 */

export type ContainerState = {
  name: string;
  service: string;
  status: string;
  health: string;
};

export type CoreHealthResult = {
  ok: boolean;
  running: string[];
  missing: string[];
  unhealthy: string[];
};

const CORE_SERVICES = ["admin", "gateway", "assistant", "openmemory"];

export function parseCoreHealth(
  psJsonOutput: string,
  targetServices: string[] = CORE_SERVICES,
): CoreHealthResult {
  const containers: ContainerState[] = [];
  const trimmed = psJsonOutput.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      running: [],
      missing: [...targetServices],
      unhealthy: [],
    };
  }

  // docker compose ps --format json can return NDJSON (one object per line)
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l || !l.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(l) as Record<string, unknown>;
      containers.push({
        name: String(parsed.Name ?? parsed.name ?? ""),
        service: String(parsed.Service ?? parsed.service ?? ""),
        status: String(parsed.Status ?? parsed.status ?? ""),
        health: String(parsed.Health ?? parsed.health ?? ""),
      });
    } catch {
      // skip unparseable lines
    }
  }

  const serviceMap = new Map<string, ContainerState>();
  for (const c of containers) {
    serviceMap.set(c.service, c);
  }

  const running: string[] = [];
  const missing: string[] = [];
  const unhealthy: string[] = [];

  for (const svc of targetServices) {
    const container = serviceMap.get(svc);
    if (!container) {
      missing.push(svc);
      continue;
    }
    const isRunning = container.status.toLowerCase().includes("running");
    if (!isRunning) {
      unhealthy.push(svc);
      continue;
    }
    const hasHealthcheck = container.health.length > 0 && container.health !== "N/A";
    if (hasHealthcheck && container.health.toLowerCase() !== "healthy") {
      unhealthy.push(svc);
      continue;
    }
    running.push(svc);
  }

  return {
    ok: missing.length === 0 && unhealthy.length === 0,
    running,
    missing,
    unhealthy,
  };
}
