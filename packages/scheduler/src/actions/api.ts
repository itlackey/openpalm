/**
 * API action executor — calls the admin API.
 *
 * Gracefully skips if admin is absent (connection refused / DNS failure).
 * This allows the scheduler to run independently when admin is not deployed.
 */
import type { AutomationAction } from "@openpalm/lib";
import { createLogger, SAFE_PATH_RE } from "@openpalm/lib";

const logger = createLogger("scheduler:api");

export async function executeApiAction(
  action: AutomationAction,
  adminToken: string,
): Promise<void> {
  if (!action.path || !SAFE_PATH_RE.test(action.path) || action.path.includes("..")) {
    logger.warn("rejecting unsafe action path", { path: action.path });
    return;
  }

  const adminUrl = process.env.OP_ADMIN_API_URL || "http://admin:8100";
  const url = `${adminUrl}${action.path}`;
  const { "x-admin-token": _dropped, "authorization": _dropped2, ...safeHeaders } = action.headers ?? {};
  const headers: Record<string, string> = {
    ...safeHeaders,
    "x-admin-token": adminToken,
    "x-requested-by": "automation",
  };
  if (action.body) {
    headers["content-type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), action.timeout ?? 30_000);
  try {
    const resp = await fetch(url, {
      method: action.method ?? "GET",
      headers,
      body: action.body ? JSON.stringify(action.body) : undefined,
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
  } catch (err) {
    // Gracefully skip when admin is absent (connection refused, DNS failure)
    const msg = String(err);
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("fetch failed") ||
      msg.includes("ConnectionRefused") ||
      msg.includes("Unable to connect")
    ) {
      logger.info("admin not reachable, skipping api action", {
        path: action.path,
        reason: msg,
      });
      return;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
