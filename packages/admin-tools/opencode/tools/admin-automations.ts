import { tool } from "@opencode-ai/plugin";
import { adminFetch, buildAdminHeaders } from "./lib.ts";

const SCHEDULER_URL = process.env.OP_SCHEDULER_URL || "http://scheduler:8090";

const MISSING_ASSISTANT_TOKEN = JSON.stringify({
  error: true,
  message: 'Missing OP_ASSISTANT_TOKEN. Admin-token fallback is disabled for assistant/admin-tools contexts.',
});

export const list = tool({
  description: "List configured automations (name, schedule, enabled, action type, fileName). For live scheduler status and execution logs, query the scheduler sidecar at http://scheduler:8090/automations.",
  async execute() {
    return adminFetch("/admin/automations");
  },
});

export const trigger = tool({
  description:
    "Manually trigger an automation by its fileName. Sends a POST to the scheduler sidecar to execute the automation immediately, outside its normal cron schedule.",
  args: {
    name: tool.schema
      .string()
      .describe("The fileName of the automation to trigger (e.g. 'daily-summary.yml')"),
  },
  async execute(args) {
    const headers = buildAdminHeaders();
    if (!headers) return MISSING_ASSISTANT_TOKEN;

    try {
      const res = await fetch(`${SCHEDULER_URL}/automations/${encodeURIComponent(args.name)}/run`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.text();
      if (!res.ok) return JSON.stringify({ error: true, status: res.status, body });
      return body;
    } catch (err) {
      return JSON.stringify({
        error: true,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

export const log = tool({
  description:
    "Retrieve execution history for a specific automation by its fileName. Returns recent execution log entries (timestamp, success/failure, duration, errors).",
  args: {
    name: tool.schema
      .string()
      .describe("The fileName of the automation to get logs for (e.g. 'daily-summary.yml')"),
  },
  async execute(args) {
    const headers = buildAdminHeaders();
    if (!headers) return MISSING_ASSISTANT_TOKEN;

    try {
      const res = await fetch(`${SCHEDULER_URL}/automations/${encodeURIComponent(args.name)}/log`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();
      if (!res.ok) return JSON.stringify({ error: true, status: res.status, body });
      return body;
    } catch (err) {
      return JSON.stringify({
        error: true,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
