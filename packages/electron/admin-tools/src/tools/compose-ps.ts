/**
 * compose.ps — list compose services + their state in structured form.
 *
 * Uses `docker compose ps --format json` (one JSON document per line as of
 * recent compose versions). Parses each line so the model gets a clean array.
 */
import { tool } from "@opencode-ai/plugin";
import { runCapture } from "./_exec.js";

export function parsePsOutput(stdout: string): Array<Record<string, unknown>> {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  // Two compose flavors: JSON array (older) or NDJSON (newer).
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  const services: Array<Record<string, unknown>> = [];
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try { services.push(JSON.parse(l)); } catch { /* skip malformed line */ }
  }
  return services;
}

export default tool({
  description:
    "List Docker Compose services for the OpenPalm stack. Returns a JSON " +
    "array of services (name, state, status, ports). Equivalent to " +
    "`docker compose ps --format json`.",
  args: {},
  async execute() {
    const { stdout, stderr, code } = await runCapture("docker", ["compose", "ps", "--format", "json"]);
    if (code !== 0) {
      return JSON.stringify({ ok: false, exitCode: code, stderr: stderr.trim() }, null, 2);
    }
    return JSON.stringify({ ok: true, services: parsePsOutput(stdout) }, null, 2);
  },
});
