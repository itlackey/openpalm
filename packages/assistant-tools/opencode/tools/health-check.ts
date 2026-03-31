import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Check health of core OpenPalm services. Specify comma-separated service names: guardian, memory. Defaults to all core services (no admin).",
  args: {
    services: tool.schema.string().optional().describe("Comma-separated service names to check (guardian, memory). Defaults to all core services."),
  },
  async execute(args) {
    const ALL = ["guardian", "memory"];
    const requested = args.services
      ? args.services.split(",").map((service) => service.trim()).filter(Boolean)
      : ALL;
    const targets = [...new Set(requested)];
    const urlMap: Record<string, string> = {
      guardian: process.env.GUARDIAN_URL || "http://guardian:8080",
      memory: process.env.MEMORY_API_URL || "http://memory:8765",
    };
    const results: Record<string, { status: string; latencyMs?: number }> = {};
    await Promise.all(
      targets.map(async (svc) => {
        const baseUrl = urlMap[svc];
        if (!baseUrl) { results[svc] = { status: "unknown service" }; return; }
        const start = performance.now();
        try {
          const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
          results[svc] = { status: res.ok ? "healthy" : `unhealthy (${res.status})`, latencyMs: Math.round(performance.now() - start) };
        } catch (err) {
          results[svc] = { status: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
        }
      })
    );
    return JSON.stringify(results, null, 2);
  },
});
