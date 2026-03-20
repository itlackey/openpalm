/**
 * OpenPalm Scheduler Sidecar — lightweight Bun HTTP server.
 *
 * Reads automations from config/automations/ and runs them on
 * cron schedules. Provides a REST API for health checks, automation
 * listing, execution logs, and manual triggers.
 *
 * Port: 8090 (configurable via PORT env)
 */
import { createLogger } from "@openpalm/lib";
import { loadAutomations } from "@openpalm/lib";
import {
  startScheduler,
  stopScheduler,
  startWatching,
  stopWatching,
  getSchedulerStatus,
  getLoadedAutomations,
  getExecutionLog,
  getAllExecutionLogs,
  triggerAutomation,
} from "./scheduler.js";

const logger = createLogger("scheduler:server");

const PORT = parseInt(process.env.PORT ?? "8090", 10);
const OPENPALM_HOME = process.env.OPENPALM_HOME ?? "";
const CONFIG_DIR = OPENPALM_HOME ? `${OPENPALM_HOME}/config` : (process.env.OPENPALM_CONFIG_HOME ?? "");
const ADMIN_TOKEN = process.env.OPENPALM_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "";

if (!CONFIG_DIR) {
  logger.error("OPENPALM_HOME (or OPENPALM_CONFIG_HOME) is required");
  process.exit(1);
}

if (!ADMIN_TOKEN) {
  logger.warn("OPENPALM_ADMIN_TOKEN is not set — authenticated endpoints will reject all requests");
}

// ── Auth Helper ──────────────────────────────────────────────────────

function requireAuth(req: Request): boolean {
  if (!ADMIN_TOKEN) return false; // No token configured = fail closed
  const token =
    req.headers.get("x-admin-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return token === ADMIN_TOKEN;
}

// ── JSON Response Helper ──────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── Route Handling ───────────────────────────────────────────────────

function handleRequest(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // GET /health
  if (method === "GET" && path === "/health") {
    const status = getSchedulerStatus();
    return json(200, {
      status: "ok",
      service: "scheduler",
      jobCount: status.jobCount,
      uptime: process.uptime(),
    });
  }

  // GET /automations (authenticated — exposes automation topology)
  if (method === "GET" && path === "/automations") {
    if (!requireAuth(req)) {
      return json(401, { error: "unauthorized" });
    }
    const status = getSchedulerStatus();
    const allLogs = getAllExecutionLogs();
    const automations = loadAutomations(CONFIG_DIR).map((c) => ({
      name: c.name,
      description: c.description,
      schedule: c.schedule,
      timezone: c.timezone,
      enabled: c.enabled,
      action: {
        type: c.action.type,
        method: c.action.method,
        path: c.action.path,
        url: c.action.url,
        content: c.action.content,
        agent: c.action.agent,
      },
      on_failure: c.on_failure,
      fileName: c.fileName,
      nextRun:
        status.jobs.find((j) => j.fileName === c.fileName)?.nextRun ?? null,
      logs: allLogs[c.fileName] ?? [],
    }));

    return json(200, { automations, scheduler: status });
  }

  // GET /automations/:name/log (authenticated — exposes execution details)
  if (method === "GET" && path.startsWith("/automations/") && path.endsWith("/log")) {
    if (!requireAuth(req)) {
      return json(401, { error: "unauthorized" });
    }
    const name = path.slice("/automations/".length, -"/log".length);
    if (!name) {
      return json(400, { error: "missing automation name" });
    }
    const logs = getExecutionLog(name);
    return json(200, { fileName: name, logs });
  }

  // POST /automations/:name/run (authenticated)
  if (method === "POST" && path.startsWith("/automations/") && path.endsWith("/run")) {
    if (!requireAuth(req)) {
      return json(401, { error: "unauthorized" });
    }
    const name = path.slice("/automations/".length, -"/run".length);
    if (!name) {
      return json(400, { error: "missing automation name" });
    }
    return triggerAutomation(name, ADMIN_TOKEN).then((result) => {
      if (result.ok) {
        return json(200, { ok: true, fileName: name });
      }
      return json(404, { ok: false, error: result.error });
    });
  }

  return json(404, { error: "not found" });
}

// ── Server Startup ───────────────────────────────────────────────────

logger.info("starting scheduler sidecar", {
  port: PORT,
  configDir: CONFIG_DIR,
});

// Start the automation scheduler
startScheduler(CONFIG_DIR, ADMIN_TOKEN);

// Watch for automation file changes (no restart required)
startWatching(CONFIG_DIR, ADMIN_TOKEN);

// Start HTTP server
const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

logger.info(`scheduler HTTP server listening on port ${server.port}`);

// Graceful shutdown
function shutdown(): void {
  logger.info("shutting down scheduler");
  stopWatching();
  stopScheduler();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
