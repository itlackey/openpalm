/**
 * Thin wrappers around `docker compose` invocations used by the CLI.
 *
 * Both spawn `docker compose` directly via `Bun.spawn` (no shell). The
 * inherit-stdio variant is used for interactive operations (logs, ps);
 * the capture variant returns stdout for parsing (e.g. `ps --format json`).
 *
 * Compose file/env-file resolution lives in `@openpalm/lib`'s
 * `buildComposeCliArgs` — callers prepend that result before sub-args.
 */

/**
 * Runs a `docker compose` command with inherited stdio. Throws on non-zero exit.
 */
export async function runDockerCompose(args: string[]): Promise<void> {
  const proc = Bun.spawn(['docker', 'compose', ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed with exit code ${code}`);
  }
}

/**
 * Runs a `docker compose` command and captures stdout as a string.
 * Throws on non-zero exit.
 */
export async function runDockerComposeCapture(args: string[]): Promise<string> {
  const proc = Bun.spawn(['docker', 'compose', ...args], {
    stdout: 'pipe',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const output = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed with exit code ${code}`);
  }
  return output;
}
