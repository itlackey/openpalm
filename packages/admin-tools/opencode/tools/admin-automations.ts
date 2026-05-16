import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

/**
 * Automation tools.
 *
 * Automations are AKM markdown task files in stash/tasks/*.md.
 * The OS cron daemon (inside the assistant container) handles scheduling.
 * All three tools go through the admin API.
 */

export const list = tool({
  description:
    "List configured automations (name, schedule, enabled, action type). Reads from stash/tasks/*.md via the admin API.",
  async execute() {
    return adminFetch("/admin/automations");
  },
});

export const trigger = tool({
  description:
    "Manually trigger an automation by its task ID. The admin API runs `akm tasks run <name>` directly; logs appear in cache/akm/tasks/logs/<name>/.",
  args: {
    name: tool.schema
      .string()
      .describe("The task ID of the automation to trigger (e.g. 'health-check')"),
  },
  async execute(args) {
    return adminFetch(`/admin/automations/${encodeURIComponent(args.name)}/run`, {
      method: "POST",
    });
  },
});

export const log = tool({
  description:
    "Retrieve recent execution log lines for a specific automation. Reads from cache/akm/tasks/logs/<name>/ via the admin API.",
  args: {
    name: tool.schema
      .string()
      .describe("The task ID of the automation to get logs for (e.g. 'health-check')"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Maximum number of log lines to return (default 50, max 500)"),
  },
  async execute(args) {
    const qs = args.limit !== undefined ? `?limit=${encodeURIComponent(args.limit)}` : "";
    return adminFetch(`/admin/automations/${encodeURIComponent(args.name)}/log${qs}`);
  },
});
