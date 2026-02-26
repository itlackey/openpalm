import type { ComposeConfig, SpawnFn } from "./types.ts";
import { runCompose } from "./compose-runner.ts";

export async function composeExec(
  config: ComposeConfig,
  args: string[],
  options?: { stream?: boolean; timeout?: number; spawn?: SpawnFn }
): Promise<{ exitCode: number; stdout: string; stderr: string; code: string }> {
  const result = await runCompose(args, {
    bin: config.bin,
    subcommand: config.subcommand,
    envFile: config.envFile,
    composeFile: config.composeFile,
    stream: options?.stream,
    timeoutMs: options?.timeout,
    spawn: options?.spawn,
  });

  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, code: result.code };
}

async function execOrThrow(config: ComposeConfig, command: string, args: string[], stream = true): Promise<void> {
  const result = await composeExec(config, args, { stream });
  if (result.exitCode !== 0) throw new Error(`compose ${command} failed:${result.code}`);
}

export async function composePull(config: ComposeConfig, services?: string[]): Promise<void> {
  await execOrThrow(config, "pull", ["pull", ...(services ?? [])]);
}

export async function composeUp(
  config: ComposeConfig,
  services?: string[],
  options?: { detach?: boolean; pull?: "always" | "missing" | "never" }
): Promise<void> {
  const args = ["up"];
  if (options?.detach ?? true) args.push("-d");
  if (options?.pull) args.push("--pull", options.pull);
  if (services) args.push(...services);
  await execOrThrow(config, "up", args);
}

export async function composeDown(
  config: ComposeConfig,
  options?: { removeOrphans?: boolean; removeImages?: boolean }
): Promise<void> {
  const args = ["down"];
  if (options?.removeOrphans ?? true) args.push("--remove-orphans");
  if (options?.removeImages) args.push("--rmi", "all");
  await execOrThrow(config, "down", args);
}

export async function composeRestart(config: ComposeConfig, services?: string[]): Promise<void> {
  await execOrThrow(config, "restart", ["restart", ...(services ?? [])]);
}

export async function composeStop(config: ComposeConfig, services?: string[]): Promise<void> {
  await execOrThrow(config, "stop", ["stop", ...(services ?? [])]);
}

export async function composeLogs(
  config: ComposeConfig,
  services?: string[],
  options?: { follow?: boolean; tail?: number }
): Promise<void> {
  const args = ["logs"];
  if (options?.follow) args.push("--follow");
  if (options?.tail !== undefined) args.push("--tail", options.tail.toString());
  if (services) args.push(...services);
  await execOrThrow(config, "logs", args);
}

export async function composePs(config: ComposeConfig): Promise<string> {
  const result = await composeExec(config, ["ps", "-a"]);
  if (result.exitCode !== 0) throw new Error(`compose ps failed:${result.code}`);
  return result.stdout;
}
