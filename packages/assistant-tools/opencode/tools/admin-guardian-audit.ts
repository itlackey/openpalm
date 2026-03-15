import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export default tool({
  description:
    "Read the guardian's security audit log. Shows HMAC verification results, rate limiting events, and replay detection. Use this to investigate authentication failures or suspicious traffic patterns.",
  args: {
    limit: tool.schema
      .string()
      .optional()
      .describe("Maximum number of entries to return (default: 50)"),
  },
  async execute(args) {
    const limit = args.limit || "50";
    return adminFetch(`/admin/audit?source=guardian&limit=${encodeURIComponent(limit)}`);
  },
});
