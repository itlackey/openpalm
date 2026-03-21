import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

const CORE_SERVICES = new Set([
  "memory",
  "assistant",
  "guardian",
  "admin",
]);

function isValidService(service: string): boolean {
  if (CORE_SERVICES.has(service)) return true;
  // Allow channel-* pattern
  if (/^channel-[a-z0-9-]+$/.test(service)) return true;
  return false;
}

export default tool({
  description:
    "Read Docker logs from OpenPalm service containers. Use this to investigate errors, crashes, or unexpected behavior in any service.",
  args: {
    service: tool.schema
      .string()
      .optional()
      .describe(
        "Comma-separated service names (guardian, memory, admin, assistant, channel-*). Omit for all services."
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
    // Validate service names if provided
    if (args.service) {
      const services = args.service.split(",").map((s) => s.trim()).filter(Boolean);
      for (const svc of services) {
        if (!isValidService(svc)) {
          return JSON.stringify({
            error: true,
            message: `Invalid service '${svc}'. Valid: memory, assistant, guardian, admin, or channel-* pattern.`,
          });
        }
      }
    }

    const params = new URLSearchParams();
    if (args.service) params.set("service", args.service);
    params.set("tail", args.tail || "100");
    if (args.since) params.set("since", args.since);

    const query = params.toString();
    return adminFetch(`/admin/logs?${query}`);
  },
});
