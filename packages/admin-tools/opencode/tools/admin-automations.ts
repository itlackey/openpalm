import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

/**
 * Automation tools.
 *
 * The scheduler now runs as a co-process inside the assistant container and
 * has no HTTP API. All three tools go through the admin API, which writes
 * trigger sentinels and reads scheduler.log on disk.
 */

export const list = tool({
  description:
    "List configured automations (name, schedule, enabled, action type, fileName). Reads from config/automations/ via the admin API.",
  async execute() {
    return adminFetch("/admin/automations");
  },
});

export const trigger = tool({
  description:
    "Manually trigger an automation by its fileName. The admin API drops a sentinel file under ${OP_HOME}/data/scheduler/triggers/<name>.run; the scheduler co-process watches that directory and fires the matching automation immediately.",
  args: {
    name: tool.schema
      .string()
      .describe("The fileName of the automation to trigger (e.g. 'daily-summary.yml')"),
  },
  async execute(args) {
    return adminFetch(`/admin/automations/${encodeURIComponent(args.name)}/run`, {
      method: "POST",
    });
  },
});

export const log = tool({
  description:
    "Retrieve recent scheduler log lines for a specific automation by its fileName. Reads ${OP_HOME}/logs/scheduler.log via the admin API and filters to lines mentioning the automation.",
  args: {
    name: tool.schema
      .string()
      .describe("The fileName of the automation to get logs for (e.g. 'daily-summary.yml')"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Maximum number of log entries to return (default 50, max 500)"),
  },
  async execute(args) {
    const qs = args.limit !== undefined ? `?limit=${encodeURIComponent(args.limit)}` : "";
    return adminFetch(`/admin/automations/${encodeURIComponent(args.name)}/log${qs}`);
  },
});
