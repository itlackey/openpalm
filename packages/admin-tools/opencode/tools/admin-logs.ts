import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export default tool({
  description:
    "Read Docker logs from OpenPalm service containers. Use this to investigate errors, crashes, or unexpected behavior in any service.",
  args: {
    service: tool.schema
      .string()
      .optional()
      .describe(
        "Comma-separated service names. Core services: guardian, memory, admin, assistant, scheduler. Use the containers list tool or /admin/installed to discover installed addon services. Omit for all services."
      ),
    tail: tool.schema
      .string()
      .optional()
      .describe("Number of log lines to return (default: 100)"),
    since: tool.schema
      .string()
      .optional()
      .describe('Time filter, e.g. "1h", "30m", "2h". Omit for no time filter.'),
  },
  async execute(args) {
    const params = new URLSearchParams();
    if (args.service) params.set("service", args.service);
    params.set("tail", args.tail || "100");
    if (args.since) params.set("since", args.since);

    const query = params.toString();
    return adminFetch(`/admin/logs?${query}`);
  },
});
