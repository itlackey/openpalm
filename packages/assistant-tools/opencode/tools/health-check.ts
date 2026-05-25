import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Check health of core OpenPalm services. Specify comma-separated service names: guardian. Defaults to all core services (no admin).",
  args: {
    services: tool.schema.string().optional().describe("Comma-separated service names to check (currently: guardian). Defaults to all core services."),
  },
  async execute(args) {
    const ALL = ["guardian"];
    const requested = args.services
      ? args.services.split(",").map((service) => service.trim()).filter(Boolean)
      : ALL;
    const targets = [...new Set(requested)];
    // Guardian is always on assistant_net at the service-name alias.
    // No env override: the URL is deterministic inside the compose project.
    const urlMap: Record<string, string> = {
      guardian: "http://guardian:8080",
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
