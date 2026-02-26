import type { ComposeErrorCode, ComposeRunOptions, ComposeRunResult } from "./types.ts";

const ERROR_MATCHERS: Array<{ pattern: RegExp; code: ComposeErrorCode }> = [
  { pattern: /Cannot connect to the Docker daemon|error during connect|dial unix/i, code: "daemon_unreachable" },
  { pattern: /pull access denied|manifest unknown|failed to fetch/i, code: "image_pull_failed" },
  { pattern: /permission denied|access denied/i, code: "permission_denied" },
  { pattern: /yaml:|invalid compose|unsupported config/i, code: "invalid_compose" },
];

function classifyError(stderr: string): ComposeErrorCode {
  for (const m of ERROR_MATCHERS) {
    if (m.pattern.test(stderr)) return m.code;
  }
  return "unknown";
}

async function readStream(stream: ReadableStream | number | null | undefined, isStreaming: boolean): Promise<string> {
  if (isStreaming || typeof stream === "number" || !stream) return "";
  return new Response(stream).text();
}

export async function runCompose(args: string[], options: ComposeRunOptions): Promise<ComposeRunResult> {
  const cmdArgs: string[] = [];
  if (options.subcommand) cmdArgs.push(options.subcommand);
  if (options.envFile) cmdArgs.push("--env-file", options.envFile);
  cmdArgs.push("-f", options.composeFile, ...args);

  const isStreaming = options.stream ?? false;
  const timeoutMs = options.timeoutMs ?? (isStreaming ? 0 : 30_000);
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  const spawn = options.spawn ?? Bun.spawn;
  const timeoutId = controller ? setTimeout(() => controller.abort("timeout"), timeoutMs) : undefined;

  try {
    const proc = spawn([options.bin, ...cmdArgs], {
      stdout: isStreaming ? "inherit" : "pipe",
      stderr: isStreaming ? "inherit" : "pipe",
      stdin: "inherit",
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      signal: controller?.signal,
    });
    await proc.exited;
    const exitCode = proc.exitCode ?? 1;
    const stdout = await readStream(proc.stdout, isStreaming);
    const stderr = await readStream(proc.stderr, isStreaming);
    return { ok: exitCode === 0, exitCode, stdout, stderr, code: exitCode === 0 ? "unknown" : classifyError(stderr) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = controller?.signal.aborted === true || message.includes("timeout");
    return { ok: false, exitCode: 1, stdout: "", stderr: message, code: isTimeout ? "timeout" : classifyError(message) };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
