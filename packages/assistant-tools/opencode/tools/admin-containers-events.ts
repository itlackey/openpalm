import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export default tool({
  description:
    "Get recent Docker container lifecycle events: starts, stops, restarts, OOM kills, and health check failures. Use this to spot crash loops or unexpected restarts.",
  args: {
    since: tool.schema
      .string()
      .optional()
      .describe('How far back to look (e.g. "1h", "30m", "6h"). Default: "1h"'),
  },
  async execute(args) {
    const since = args.since || "1h";
    return adminFetch(`/admin/containers/events?since=${encodeURIComponent(since)}`);
  },
});
