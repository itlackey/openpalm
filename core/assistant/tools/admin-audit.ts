import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export default tool({
  description: "View the admin audit log. Every admin API action is recorded with timestamp, actor, action, and result. Use this to review what changes have been made to the system.",
  args: {
    limit: tool.schema.number().optional().describe("Maximum number of entries to return. Omit for all entries."),
  },
  async execute(args) {
    const query = args.limit ? `?limit=${args.limit}` : "";
    return adminFetch(`/admin/audit${query}`);
  },
});
