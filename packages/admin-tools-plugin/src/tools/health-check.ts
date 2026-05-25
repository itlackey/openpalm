/**
 * health-check — admin variant of the assistant-tools health-check tool.
 *
 * Pings well-known internal service endpoints from the admin OpenCode
 * (running on the host, not in the assistant container). Reads URLs from
 * env with localhost defaults that match the dev-setup.sh ports.
 */
import { tool } from "@opencode-ai/plugin";

const DEFAULTS: Record<string, string> = {
  guardian: process.env.OP_GUARDIAN_URL || "http://127.0.0.1:8180",
  assistant: process.env.OP_OPENCODE_URL || process.env.OP_ASSISTANT_URL || "http://127.0.0.1:3800",
  ui: process.env.OP_HOST_UI_URL || "http://127.0.0.1:3880",
};

export default tool({
  description:
    "Check the health of OpenPalm services from the host. Specify a " +
    "comma-separated subset (guardian, assistant, ui) or omit for all.",
  args: {
    services: tool.schema
      .string()
      .optional()
      .describe("Comma-separated subset: guardian, assistant, ui. Defaults to all."),
  },
  async execute(args) {
    const ALL = Object.keys(DEFAULTS);
    const requested = args.services
      ? args.services.split(",").map((s) => s.trim()).filter(Boolean)
      : ALL;
    const targets = [...new Set(requested)];
    const results: Record<string, { status: string; latencyMs?: number }> = {};
    await Promise.all(
      targets.map(async (svc) => {
        const baseUrl = DEFAULTS[svc];
        if (!baseUrl) { results[svc] = { status: "unknown service" }; return; }
        const start = performance.now();
        try {
          const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          results[svc] = {
            status: res.ok ? "healthy" : `unhealthy (${res.status})`,
            latencyMs: Math.round(performance.now() - start),
          };
        } catch (err) {
          results[svc] = { status: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
        }
      }),
    );
    return JSON.stringify(results, null, 2);
  },
});
