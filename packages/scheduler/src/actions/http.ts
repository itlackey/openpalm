/**
 * HTTP action executor — makes fetch calls to arbitrary URLs.
 *
 * No auto-auth; headers are passed through from the automation config.
 */
import type { AutomationAction } from "@openpalm/lib";

export async function executeHttpAction(action: AutomationAction): Promise<void> {
  if (!action.url) {
    throw new Error("http action requires a 'url' field");
  }

  const headers: Record<string, string> = { ...action.headers };
  if (action.body) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), action.timeout ?? 30_000);
  try {
    const resp = await fetch(action.url, {
      method: action.method ?? "GET",
      headers,
      body: action.body ? JSON.stringify(action.body) : undefined,
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
