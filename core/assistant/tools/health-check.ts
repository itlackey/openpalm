import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Check health of core OpenPalm services. Specify comma-separated service names: guardian, openmemory, admin. Defaults to all.",
  args: {
    services: tool.schema.string().optional().describe("Comma-separated service names to check (guardian, openmemory, admin). Defaults to all."),
  },
  async execute(args) {
    const ALL = ["guardian", "openmemory", "admin"];
    const targets = args.services ? args.services.split(",").map(s => s.trim()).filter(Boolean) : ALL;
    const portMap: Record<string, number> = { guardian: 8080, openmemory: 8765, admin: 8100 };
    const results: Record<string, { status: string; latencyMs?: number }> = {};
    await Promise.all(
      targets.map(async (svc) => {
        const port = portMap[svc];
        if (!port) { results[svc] = { status: "unknown service" }; return; }
        const start = performance.now();
        try {
          const res = await fetch(`http://${svc}:${port}/health`, { signal: AbortSignal.timeout(5000) });
          results[svc] = { status: res.ok ? "healthy" : `unhealthy (${res.status})`, latencyMs: Math.round(performance.now() - start) };
        } catch (err) {
          results[svc] = { status: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
        }
      })
    );
    return JSON.stringify(results, null, 2);
  },
});
