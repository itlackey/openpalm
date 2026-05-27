/**
 * health-check — admin variant of the assistant-tools health-check tool.
 *
 * Probes services from the HOST (admin OpenCode runs on the host, not inside
 * the assistant container). Services that are HTTP-published on the host
 * (assistant, ui) are checked via /health. Services that are network-only
 * (guardian — no host port mapping by design) are checked via
 * `docker container inspect`, which reads the same compose healthcheck the
 * container already runs internally.
 */
import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HTTP_TARGETS: Record<string, string> = {
  assistant: process.env.OP_OPENCODE_URL || process.env.OP_ASSISTANT_URL || "http://127.0.0.1:3800",
  ui: process.env.OP_HOST_UI_URL || "http://127.0.0.1:3880",
};

const DOCKER_HEALTH_TARGETS: Record<string, string> = {
  guardian: "openpalm-guardian-1",
};

const ALL = [...Object.keys(HTTP_TARGETS), ...Object.keys(DOCKER_HEALTH_TARGETS)];

async function checkHttp(baseUrl: string): Promise<{ status: string; latencyMs: number }> {
  const start = performance.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: res.ok ? "healthy" : `unhealthy (${res.status})`,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      status: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: Math.round(performance.now() - start),
    };
  }
}

async function checkDockerHealth(container: string): Promise<{ status: string; latencyMs: number }> {
  const start = performance.now();
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["container", "inspect", container, "--format", "{{.State.Health.Status}}"],
      { timeout: 5000 },
    );
    const state = stdout.trim();
    const status =
      state === "healthy"
        ? "healthy"
        : state === ""
          ? "no healthcheck defined"
          : state;
    return { status, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      status: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: Math.round(performance.now() - start),
    };
  }
}

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
    const requested = args.services
      ? args.services.split(",").map((s) => s.trim()).filter(Boolean)
      : ALL;
    const targets = [...new Set(requested)];
    const results: Record<string, { status: string; latencyMs?: number }> = {};
    await Promise.all(
      targets.map(async (svc) => {
        if (svc in HTTP_TARGETS) {
          results[svc] = await checkHttp(HTTP_TARGETS[svc]);
        } else if (svc in DOCKER_HEALTH_TARGETS) {
          results[svc] = await checkDockerHealth(DOCKER_HEALTH_TARGETS[svc]);
        } else {
          results[svc] = { status: "unknown service" };
        }
      }),
    );
    return JSON.stringify(results, null, 2);
  },
});
