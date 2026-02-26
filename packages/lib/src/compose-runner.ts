import type { ComposeErrorCode, ComposeRunOptions, ComposeRunResult, SpawnFn } from "./types.ts";

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

async function readStream(stream: ReadableStream | number | null | undefined, isStreaming: boolean): Promise<string> {
  if (isStreaming || typeof stream === "number" || !stream) return "";
  return new Response(stream).text();
}

async function runComposeOnce(args: string[], options: ComposeRunOptions): Promise<ComposeRunResult> {
  const composeArgs = buildComposeArgs(options, args);
  const stream = options.stream ?? false;
  const timeoutMs = options.timeoutMs ?? (stream ? 0 : 30_000);
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  const spawn = options.spawn ?? Bun.spawn;
  const timeoutId = controller ? setTimeout(() => controller.abort("timeout"), timeoutMs) : undefined;

  let proc: ReturnType<SpawnFn> | undefined;
  try {
    proc = spawn([options.bin, ...composeArgs], {
      stdout: stream ? "inherit" : "pipe",
      stderr: stream ? "inherit" : "pipe",
      stdin: "inherit",
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      signal: controller?.signal,
    });
    await proc.exited;
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = controller?.signal.aborted === true || message.includes("timeout");
    return { ok: false, exitCode: 1, stdout: "", stderr: message, code: isTimeout ? "timeout" : classifyError(message).code };
  }

  if (timeoutId) clearTimeout(timeoutId);
  const exitCode = proc.exitCode ?? 1;
  const stdout = await readStream(proc.stdout, stream);
  const stderr = await readStream(proc.stderr, stream);
  if (exitCode === 0) return { ok: true, exitCode, stdout, stderr, code: "unknown" };
  return { ok: false, exitCode, stdout, stderr, code: classifyError(stderr).code };
}

export async function runCompose(args: string[], options: ComposeRunOptions): Promise<ComposeRunResult> {
  const retries = options.retries ?? 2;
  let attempt = 0;
  while (true) {
    const result = await runComposeOnce(args, options);
    if (result.ok || result.code === "timeout") return result;
    const { retryable } = classifyError(result.stderr);
    if (!retryable || attempt >= retries) return result;
    attempt += 1;
  }
}
