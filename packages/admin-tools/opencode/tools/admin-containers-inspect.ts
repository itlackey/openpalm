import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export default tool({
  description:
    "Get container resource usage stats: CPU%, memory usage, network I/O, and PID count per container. Use this to identify resource-hungry or leaking containers.",
  async execute() {
    return adminFetch("/admin/containers/stats", {
      signal: AbortSignal.timeout(15_000),
    });
  },
});
