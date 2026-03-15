import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export default tool({
  description:
    "Test inter-service network connectivity. Returns a connectivity matrix showing which services can reach which, with latency measurements. Use this to diagnose DNS or network isolation issues.",
  async execute() {
    return adminFetch("/admin/network/check", {
      signal: AbortSignal.timeout(30_000),
    });
  },
});
