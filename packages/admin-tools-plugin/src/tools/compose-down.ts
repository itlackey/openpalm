/**
 * compose.down — stop the OpenPalm stack (or a single service).
 *
 * Wraps `docker compose down [<service>]` via execFile. No audit wrapping
 * (OpenCode logs tool invocations natively, D6a).
 */
import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";

function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === "number"
        ? Number((err as NodeJS.ErrnoException).code)
        : (err ? 1 : 0);
      resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code });
    });
  });
}

export default tool({
  description:
    "Stop and remove the OpenPalm Docker Compose stack (or a single service). " +
    "Equivalent to `docker compose down [<service>]`.",
  args: {
    service: tool.schema
      .string()
      .optional()
      .describe("Optional service name to stop. Omit to take down the whole stack."),
  },
  async execute(args) {
    const dockerArgs = ["compose", "down"];
    if (args.service) dockerArgs.push(args.service);
    const { stdout, stderr, code } = await run("docker", dockerArgs);
    return JSON.stringify({
      ok: code === 0,
      command: `docker ${dockerArgs.join(" ")}`,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: code,
    }, null, 2);
  },
});
