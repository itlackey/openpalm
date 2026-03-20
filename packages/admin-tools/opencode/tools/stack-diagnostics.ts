import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

const ADMIN_TOKEN = process.env.OP_ASSISTANT_TOKEN || process.env.OP_ADMIN_TOKEN || "";

interface ServiceHealth {
  status: string;
  latencyMs?: number;
  error?: string;
}

interface DiagnosticReport {
  serviceHealth: Record<string, ServiceHealth>;
  containers: unknown;
  configValidation: unknown;
  connectionStatus: unknown;
  guardianAudit: unknown;
  adminAudit: unknown;
  guardianStats: unknown;
}

async function fetchServiceHealth(
  name: string,
  url: string
): Promise<[string, ServiceHealth]> {
  const start = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const latencyMs = Math.round(performance.now() - start);
    if (res.ok) {
      return [name, { status: "healthy", latencyMs }];
    }
    return [name, { status: `unhealthy (${res.status})`, latencyMs }];
  } catch (err) {
    return [
      name,
      { status: "unreachable", error: err instanceof Error ? err.message : String(err) },
    ];
  }
}

async function safeJsonFetch(url: string, timeout = 5_000): Promise<unknown> {
  try {
    const res = await fetch(url, {
      headers: {
        "x-admin-token": ADMIN_TOKEN,
        "x-requested-by": "assistant",
      },
      signal: AbortSignal.timeout(timeout),
    });
    return res.json();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function safeAdminFetch(path: string): Promise<unknown> {
  try {
    const raw = await adminFetch(path);
    return JSON.parse(raw);
  } catch {
    return { error: "Failed to parse response" };
  }
}

function summarizeReport(report: DiagnosticReport): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  // Only show unhealthy services
  const unhealthy: Record<string, ServiceHealth> = {};
  for (const [name, health] of Object.entries(report.serviceHealth)) {
    if (health.status !== "healthy") {
      unhealthy[name] = health;
    }
  }
  if (Object.keys(unhealthy).length > 0) {
    summary.unhealthyServices = unhealthy;
  } else {
    summary.serviceHealth = "all healthy";
  }

  // Show containers that aren't running
  if (Array.isArray(report.containers)) {
    const notRunning = (report.containers as Array<Record<string, unknown>>).filter(
      (c) => c.state !== "running"
    );
    if (notRunning.length > 0) {
      summary.stoppedContainers = notRunning;
    } else {
      summary.containers = `${report.containers.length} containers all running`;
    }
  } else {
    summary.containers = report.containers;
  }

  // Config issues
  const config = report.configValidation as Record<string, unknown> | null;
  if (config && Array.isArray(config.errors) && config.errors.length > 0) {
    summary.configErrors = config.errors;
  }
  if (config && Array.isArray(config.warnings) && config.warnings.length > 0) {
    summary.configWarnings = config.warnings;
  }

  // Connection status
  const conn = report.connectionStatus as Record<string, unknown> | null;
  if (conn && conn.complete === false) {
    summary.connectionIssues = conn;
  } else {
    summary.connectionStatus = "configured";
  }

  // Guardian audit — show failures only
  if (Array.isArray(report.guardianAudit)) {
    const failures = (report.guardianAudit as Array<Record<string, unknown>>).filter(
      (e) => e.result === "failure" || e.result === "rejected" || e.result === "rate_limited"
    );
    if (failures.length > 0) {
      summary.recentSecurityFailures = failures.slice(0, 5);
    }
  }

  // Guardian stats
  if (report.guardianStats && typeof report.guardianStats === "object") {
    const stats = report.guardianStats as Record<string, unknown>;
    if (!stats.error) {
      summary.guardianStats = stats;
    }
  }

  if (Object.keys(summary).length === 0) {
    return { status: "all systems operational" };
  }

  return summary;
}

export default tool({
  description:
    "Run a comprehensive diagnostic check across all OpenPalm services. Checks service health, container status, config validation, connection status, security events, and guardian metrics in parallel. Use this as a first step when troubleshooting any issue.",
  args: {
    verbose: tool.schema
      .string()
      .optional()
      .describe('"true" for full details. Default is summary showing only issues.'),
  },
  async execute(args) {
    const verbose = args.verbose === "true";

    // Run all checks in parallel
    const [
      guardianHealth,
      memoryHealth,
      adminHealth,
      containersRaw,
      configRaw,
      connectionRaw,
      guardianAuditRaw,
      adminAuditRaw,
      guardianStats,
    ] = await Promise.all([
      fetchServiceHealth("guardian", "http://guardian:8080/health"),
      fetchServiceHealth("memory", "http://memory:8765/health"),
      fetchServiceHealth("admin", "http://admin:8100/health"),
      safeAdminFetch("/admin/containers/list"),
      safeAdminFetch("/admin/config/validate"),
      safeAdminFetch("/admin/connections/status"),
      safeAdminFetch("/admin/audit?source=guardian&limit=20"),
      safeAdminFetch("/admin/audit?limit=20"),
      safeJsonFetch("http://guardian:8080/stats"),
    ]);

    const report: DiagnosticReport = {
      serviceHealth: Object.fromEntries([guardianHealth, memoryHealth, adminHealth]),
      containers: containersRaw,
      configValidation: configRaw,
      connectionStatus: connectionRaw,
      guardianAudit: guardianAuditRaw,
      adminAudit: adminAuditRaw,
      guardianStats,
    };

    if (verbose) {
      return JSON.stringify(report, null, 2);
    }

    return JSON.stringify(summarizeReport(report), null, 2);
  },
});
