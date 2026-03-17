import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export const list = tool({
  description: "List configured automations (name, schedule, enabled, action type, fileName). For live scheduler status and execution logs, query the scheduler sidecar at http://scheduler:8090/automations.",
  async execute() {
    return adminFetch("/admin/automations");
  },
});
