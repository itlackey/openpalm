import type { ComposeErrorCode, ComposeRunOptions, ComposeRunResult } from "./types.ts";

export type { ComposeErrorCode, ComposeRunOptions, ComposeRunResult };

const transientErrorMatchers: Array<{ pattern: RegExp; code: ComposeErrorCode; retryable: boolean }> = [
  { pattern: /Cannot connect to the Docker daemon|error during connect|dial unix/i, code: "daemon_unreachable", retryable: true },
  { pattern: /pull access denied|manifest unknown|failed to fetch/i, code: "image_pull_failed", retryable: true },
  { pattern: /permission denied|access denied/i, code: "permission_denied", retryable: false },
  { pattern: /yaml:|invalid compose|unsupported config/i, code: "invalid_compose", retryable: false },
];

function classifyError(stderr: string): { code: ComposeErrorCode; retryable: boolean } {
  for (const matcher of transientErrorMatchers) {
    if (matcher.pattern.test(stderr)) return { code: matcher.code, retryable: matcher.retryable };
  }
  return { code: "unknown", retryable: false };
}

function buildComposeArgs(options: ComposeRunOptions, args: string[]): string[] {
  const base: string[] = [];
  if (options.subcommand) base.push(options.subcommand);
  if (options.envFile) base.push("--env-file", options.envFile);
  base.push("-f", options.composeFile);
  return [...base, ...args];
}

async function runComposeOnce(args: string[], options: ComposeRunOptions): Promise<ComposeRunResult> {
  const composeArgs = buildComposeArgs(options, args);
  const stream = options.stream ?? false;
  const timeoutMs = options.timeoutMs ?? (stream ? 0 : 30_000);
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
    stdout: stream ? "inherit" : "pipe",
    stderr: stream ? "inherit" : "pipe",
    stdin: "inherit",
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    signal: controller?.signal,
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (controller && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);
  }

  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    proc = Bun.spawn([options.bin, ...composeArgs], spawnOptions);
    await proc.exited;
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = controller?.signal.aborted === true || message.includes("timeout");
    const classified = classifyError(message);
    const code: ComposeErrorCode = isTimeout ? "timeout" : classified.code;
    return { ok: false, exitCode: 1, stdout: "", stderr: message, code };
  }

  if (timeoutId) clearTimeout(timeoutId);

  const exitCode = proc.exitCode ?? 1;
  const stdoutStream = proc.stdout;
  const stderrStream = proc.stderr;
  const stdout = stream || typeof stdoutStream === "number" || !stdoutStream
    ? ""
    : await new Response(stdoutStream).text();
  const stderr = stream || typeof stderrStream === "number" || !stderrStream
    ? ""
    : await new Response(stderrStream).text();
  if (exitCode === 0) return { ok: true, exitCode, stdout, stderr, code: "unknown" };

  const classified = classifyError(stderr);
  return { ok: false, exitCode, stdout, stderr, code: classified.code };
}

export async function runCompose(args: string[], options: ComposeRunOptions): Promise<ComposeRunResult> {
  const retries = options.retries ?? 2;
  let attempt = 0;
  while (true) {
    const result = await runComposeOnce(args, options);
    if (result.ok) return result;
    if (result.code === "timeout") return result;
    const classified = classifyError(result.stderr);
    if (classified.code !== "unknown") result.code = classified.code;
    if (!classified.retryable || attempt >= retries) return result;
    attempt += 1;
  }
}
