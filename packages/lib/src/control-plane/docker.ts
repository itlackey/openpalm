/** Docker integration — executes docker compose commands via execFile (no shell). */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { parseEnvFile } from "./env.js";
import { createLogger } from "../logger.js";

const logger = createLogger("lib:docker");

export type DockerResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

/** Execute docker with an argument array — no shell interpolation. */
function run(
  args: string[],
  cwd?: string,
  timeoutMs = 120_000,
  envOverrides?: Record<string, string>
): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      args,
      { cwd, timeout: timeoutMs, env: { ...process.env, ...envOverrides } },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          code: error?.code ? Number(error.code) : 0
        });
      }
    );
  });
}

/** Resolve the Docker Compose project name. Respects OP_PROJECT_NAME env var. */
export function resolveComposeProjectName(): string {
  return process.env.OP_PROJECT_NAME?.trim() || "openpalm";
}

/** Check if Docker is available */
export async function checkDocker(): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      (error, stdout, stderr) => {
        const stdoutStr = stdout?.toString().trim() ?? "";
        const stderrStr = stderr?.toString() ?? "";
        // docker info may exit non-zero when the daemon reports warnings
        // (e.g. "No swap limit support") even though it is fully functional.
        // Treat Docker as available when stdout contains a version string.
        const available = stdoutStr.length > 0 || !error;
        resolve({
          ok: available,
          stdout: stdoutStr,
          stderr: stderrStr,
          code: error?.code ? Number(error.code) : 0
        });
      }
    );
  });
}

/** Check if docker compose is available */
export async function checkDockerCompose(): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile("docker", ["compose", "version"], (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        code: error?.code ? Number(error.code) : 0
      });
    });
  });
}

/** Build common prefix: compose -f ... --project-name ... --env-file ... */
function buildComposeArgs(options: { files: string[]; envFiles?: string[] }): string[] {
  const args = ["compose", ...options.files.flatMap((f) => ["-f", f]), "--project-name", resolveComposeProjectName()];
  for (const ef of options.envFiles ?? []) {
    if (existsSync(ef)) args.push("--env-file", ef);
  }
  return args;
}

/** Merge all env files into a single overrides object for process env. */
function collectEnvOverrides(envFiles?: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const ef of envFiles ?? []) Object.assign(overrides, parseEnvFile(ef));
  return overrides;
}

/**
 * Run `docker compose config` to validate compose file merge and variable substitution.
 * Must be called before any lifecycle mutation (install/apply/update).
 */
export async function composePreflight(
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  const args = buildComposeArgs(options);
  args.push("config", "--quiet");
  return run(args, undefined, 30_000, collectEnvOverrides(options.envFiles));
}

export async function composeConfigServices(
  options: { files: string[]; envFiles?: string[] }
): Promise<{ ok: boolean; services: string[] }> {
  const args = buildComposeArgs(options);
  args.push("config", "--services");
  const result = await run(args, undefined, 30_000, collectEnvOverrides(options.envFiles));
  if (!result.ok) return { ok: false, services: [] };
  const services = result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  return { ok: true, services };
}

/**
 * Run `docker compose up -d` with the generated compose file(s).
 * Pass `files` to merge multiple compose overlays (e.g. core + addon files).
 */
export async function composeUp(
  options: {
    files: string[];
    profiles?: string[];
    services?: string[];
    envFiles?: string[];
    forceRecreate?: boolean;
    removeOrphans?: boolean;
  }
): Promise<DockerResult> {
  if (!existsSync(options.files[0])) {
    return { ok: false, stdout: "", stderr: "Compose file not found", code: 1 };
  }
  const args = buildComposeArgs(options);
  for (const p of options.profiles ?? []) args.push("--profile", p);
  args.push("up", "-d");
  if (options.forceRecreate) args.push("--force-recreate");
  if (options.removeOrphans) args.push("--remove-orphans");
  if (options.services?.length) args.push(...options.services);
  return run(args, undefined, 300_000, collectEnvOverrides(options.envFiles));
}

/**
 * Run `docker compose down` to stop and remove containers.
 */
export async function composeDown(
  options: {
    files: string[];
    profiles?: string[];
    removeVolumes?: boolean;
    envFiles?: string[];
  }
): Promise<DockerResult> {
  if (!existsSync(options.files[0])) {
    return { ok: false, stdout: "", stderr: "Compose file not found", code: 1 };
  }
  const args = buildComposeArgs(options);
  for (const p of options.profiles ?? []) args.push("--profile", p);
  args.push("down");
  if (options.removeVolumes) args.push("-v");
  return run(args, undefined);
}

/**
 * Restart specific services.
 */
export async function composeRestart(
  services: string[],
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  const primaryFile = options.files[0];
  if (!existsSync(primaryFile)) {
    return {
      ok: false,
      stdout: "",
      stderr: "Compose file not found",
      code: 1
    };
  }

  const args = buildComposeArgs(options);
  args.push("restart", ...services);

  return run(args, undefined);
}

/**
 * Stop specific services.
 */
export async function composeStop(
  services: string[],
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  const args = buildComposeArgs(options);
  args.push("stop", ...services);

  return run(args, undefined);
}

/**
 * Start specific services (must already be created).
 */
export async function composeStart(
  services: string[],
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  const args = buildComposeArgs(options);
  // Use up -d for specific services to ensure they're created
  args.push("up", "-d", ...services);

  return run(args, undefined);
}

/**
 * Get the status of all containers in the project.
 */
export async function composePs(
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  const primaryFile = options.files[0];
  if (!existsSync(primaryFile)) {
    // If no compose file, just list containers with the project label
    return run(
      [
        "ps",
        "--filter",
        `label=com.docker.compose.project=${resolveComposeProjectName()}`,
        "--format",
        "json"
      ],
      undefined
    );
  }

  const args = buildComposeArgs(options);
  args.push("ps", "--format", "json");

  return run(args, undefined);
}

/**
 * Get logs for specific services or all services.
 */
export async function composeLogs(
  services: string[] | undefined,
  tail: number,
  options: { files: string[]; envFiles?: string[]; since?: string }
): Promise<DockerResult> {
  const args = buildComposeArgs(options);
  args.push("logs", "--tail", String(tail));

  if (options.since) {
    args.push("--since", options.since);
  }

  if (services && services.length > 0) {
    args.push(...services);
  }

  return run(args, undefined);
}

/**
 * Pull image for a single service.
 */
export async function composePullService(
  service: string,
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  const args = buildComposeArgs(options);
  args.push("pull", service);
  return run(args, undefined, 300_000, collectEnvOverrides(options.envFiles));
}

export async function composePull(
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  const args = buildComposeArgs(options);
  args.push("pull");
  return run(args, undefined, 300_000, collectEnvOverrides(options.envFiles));
}

/**
 * Get resource usage stats for all containers in the project.
 */
export async function composeStats(
  options: { files: string[]; envFiles?: string[] }
): Promise<DockerResult> {
  const args = buildComposeArgs(options);
  args.push("stats", "--no-stream", "--format", "json");

  return run(args, undefined);
}

/**
 * Get recent Docker events for the compose project.
 */
export async function getDockerEvents(
  projectName: string,
  since = "1h"
): Promise<DockerResult> {
  const args = [
    "events",
    "--filter", `label=com.docker.compose.project=${projectName}`,
    "--since", since,
    "--until", "now",
    "--format", "json"
  ];

  return run(args, undefined, 15_000);
}

/**
 * Fire-and-forget recreation of the admin container.
 */
export function selfRecreateAdmin(
  options: { files: string[]; envFiles?: string[] }
): void {
  const args = buildComposeArgs(options);
  args.push("--profile", "admin", "up", "-d", "--force-recreate", "--remove-orphans", "admin");
  try {
    const child = spawn("docker", args, {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, ...collectEnvOverrides(options.envFiles) }
    });
    child.on("error", (err) => {
      logger.error("selfRecreateAdmin spawn error", { error: err.message });
    });
    child.unref();
  } catch (err) {
    logger.error("selfRecreateAdmin failed to spawn", { error: err instanceof Error ? err.message : String(err) });
  }
}
