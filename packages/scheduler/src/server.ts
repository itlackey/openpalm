/**
 * OpenPalm Scheduler Sidecar — lightweight Bun HTTP server.
 *
 * Reads automations from config/automations/ and runs them on
 * cron schedules. Provides a REST API for health checks, automation
 * listing, execution logs, and manual triggers.
 *
 * Port: 8090 (configurable via PORT env)
 */
import { timingSafeEqual, createHash } from "node:crypto";
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
const OP_HOME = process.env.OP_HOME ?? "";
const CONFIG_DIR = OP_HOME ? `${OP_HOME}/config` : "";
const ADMIN_TOKEN = process.env.OP_ADMIN_TOKEN ?? "";

if (!CONFIG_DIR) {
  logger.error("OP_HOME is required");
  process.exit(1);
}

if (!ADMIN_TOKEN) {
  logger.warn("OP_ADMIN_TOKEN is not set — authenticated endpoints will reject all requests");
}

// ── Timing-safe token comparison ─────────────────────────────────────

function safeTokenCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!a || !b) return false;
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

// ── Auth Helper ──────────────────────────────────────────────────────

function requireAuth(req: Request): boolean {
  if (!ADMIN_TOKEN) return false; // No token configured = fail closed
  const token =
    req.headers.get("x-admin-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  return safeTokenCompare(token, ADMIN_TOKEN);
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
  // POST /automations/:name/run (authenticated)
  if (path.startsWith("/automations/")) {
    const segments = path.split("/").filter(Boolean); // ["automations", ...name parts..., action]
    // Expect at least 3 segments: "automations", <name>, <action>
    if (segments.length >= 3) {
      const action = segments[segments.length - 1]; // last segment is the action
      const name = segments.slice(1, -1).join("/"); // everything between "automations" and action

      if (method === "GET" && action === "log" && name) {
        if (!requireAuth(req)) {
          return json(401, { error: "unauthorized" });
        }
        const logs = getExecutionLog(name);
        return json(200, { fileName: name, logs });
      }

      if (method === "POST" && action === "run" && name) {
        if (!requireAuth(req)) {
          return json(401, { error: "unauthorized" });
        }
        return triggerAutomation(name, ADMIN_TOKEN).then((result) => {
          if (result.ok) {
            return json(200, { ok: true, fileName: name });
          }
          return json(404, { ok: false, error: result.error });
        });
      }
    }
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
