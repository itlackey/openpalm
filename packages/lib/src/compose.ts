import type { ComposeConfig } from "./types.ts";
import { runCompose } from "./compose-runner.ts";

export function buildComposeArgs(config: ComposeConfig): string[] {
  return [
    config.subcommand,
    "--env-file",
    config.envFile,
    "-f",
    config.composeFile,
  ];
}

export async function composeExec(
  config: ComposeConfig,
  args: string[],
  options?: { stream?: boolean; timeout?: number }
): Promise<{ exitCode: number; stdout: string; stderr: string; code: string }> {
  const result = await runCompose(args, {
    bin: config.bin,
    subcommand: config.subcommand,
    envFile: config.envFile,
    composeFile: config.composeFile,
    stream: options?.stream,
    timeoutMs: options?.timeout,
  });

  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, code: result.code };
}

export async function composePull(
  config: ComposeConfig,
  services?: string[]
): Promise<void> {
  const args = ["pull", ...(services ?? [])];
  const result = await composeExec(config, args, { stream: true });

  if (result.exitCode !== 0) {
    throw new Error(`compose pull failed:${result.code}`);
  }
}

export async function composeUp(
  config: ComposeConfig,
  services?: string[],
  options?: {
    detach?: boolean;
    pull?: "always" | "missing" | "never";
    profiles?: string[];
  }
): Promise<void> {
  const args: string[] = [];

  // Add profiles before the up command
  if (options?.profiles) {
    for (const profile of options.profiles) {
      args.push("--profile", profile);
    }
  }

  args.push("up");

  // Add flags after the up command
  const detach = options?.detach ?? true;
  if (detach) {
    args.push("-d");
  }

  if (options?.pull) {
    args.push("--pull", options.pull);
  }

  if (services) {
    args.push(...services);
  }

  const result = await composeExec(config, args, { stream: true });

  if (result.exitCode !== 0) {
    throw new Error(`compose up failed:${result.code}`);
  }
}

export async function composeDown(
  config: ComposeConfig,
  options?: { removeOrphans?: boolean; removeImages?: boolean }
): Promise<void> {
  const args = ["down"];

  const removeOrphans = options?.removeOrphans ?? true;
  if (removeOrphans) {
    args.push("--remove-orphans");
  }

  if (options?.removeImages) {
    args.push("--rmi", "all");
  }

  const result = await composeExec(config, args, { stream: true });

  if (result.exitCode !== 0) {
    throw new Error(`compose down failed:${result.code}`);
  }
}

export async function composeRestart(
  config: ComposeConfig,
  services?: string[]
): Promise<void> {
  const args = ["restart", ...(services ?? [])];
  const result = await composeExec(config, args, { stream: true });

  if (result.exitCode !== 0) {
    throw new Error(`compose restart failed:${result.code}`);
  }
}

export async function composeStop(
  config: ComposeConfig,
  services?: string[]
): Promise<void> {
  const args = ["stop", ...(services ?? [])];
  const result = await composeExec(config, args, { stream: true });

  if (result.exitCode !== 0) {
    throw new Error(`compose stop failed:${result.code}`);
  }
}

export async function composeLogs(
  config: ComposeConfig,
  services?: string[],
  options?: { follow?: boolean; tail?: number }
): Promise<void> {
  const args = ["logs"];

  if (options?.follow) {
    args.push("--follow");
  }

  if (options?.tail !== undefined) {
    args.push("--tail", options.tail.toString());
  }

  if (services) {
    args.push(...services);
  }

  const result = await composeExec(config, args, { stream: true });

  if (result.exitCode !== 0) {
    throw new Error(`compose logs failed:${result.code}`);
  }
}

export async function composePs(config: ComposeConfig): Promise<string> {
  const result = await composeExec(config, ["ps", "-a"]);

  if (result.exitCode !== 0) {
    throw new Error(`compose ps failed:${result.code}`);
  }

  return result.stdout;
}
