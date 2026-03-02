import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export const list = tool({
  description: "List configured automations, scheduler status, and recent execution logs for each automation.",
  async execute() {
    return adminFetch("/admin/automations");
  },
});
