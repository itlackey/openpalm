/**
 * compose.up — bring up the OpenPalm stack (or a single service).
 *
 * Wraps `docker compose up -d [<service>]` via execFile (no shell interpolation,
 * per repo "no shell strings" rule). No audit wrapping — OpenCode logs every
 * tool invocation natively (D6a).
 */
import { tool } from "@opencode-ai/plugin";
import { runCapture } from "./_exec.js";

export default tool({
  description:
    "Bring up the OpenPalm Docker Compose stack (or a single service). " +
    "Equivalent to `docker compose up -d [<service>]`. Returns combined stdout+stderr.",
  args: {
    service: tool.schema
      .string()
      .optional()
      .describe("Optional service name to start. Omit to bring up the whole stack."),
  },
  async execute(args) {
    const dockerArgs = ["compose", "up", "-d"];
    if (args.service) dockerArgs.push(args.service);
    const { stdout, stderr, code } = await runCapture("docker", dockerArgs);
    return JSON.stringify({
      ok: code === 0,
      command: `docker ${dockerArgs.join(" ")}`,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: code,
    }, null, 2);
  },
});
