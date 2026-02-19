import { z } from "zod";

const SERVICES = ["gateway", "openmemory", "admin"] as const;

export default {
  description: "Check health of core OpenPalm services",
  parameters: z.object({
    services: z
      .array(z.enum(SERVICES))
      .optional()
      .describe("Services to check. Defaults to all core services."),
  }),
  async execute(params: { services?: (typeof SERVICES)[number][] }) {
    const targets = params.services ?? [...SERVICES];
    const portMap: Record<string, number> = {
      gateway: 4097,
      openmemory: 8765,
      admin: 3111,
    };
    const results: Record<string, { status: string; latencyMs?: number }> = {};
    await Promise.all(
      targets.map(async (svc) => {
        const start = performance.now();
        try {
          const res = await fetch(`http://${svc}:${portMap[svc]}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          results[svc] = {
            status: res.ok ? "healthy" : `unhealthy (${res.status})`,
            latencyMs: Math.round(performance.now() - start),
          };
        } catch (err) {
          results[svc] = {
            status: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      })
    );
    return results;
  },
};
