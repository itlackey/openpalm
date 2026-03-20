/**
 * Docker integration — executes real docker compose commands.
 *
 * This module shells out to `docker compose` for lifecycle operations.
 * It reads compose files from the config directory (config/components/)
 * and uses them for all operations.
 *
 * Security: All commands use execFile with argument arrays to prevent
 * command injection. No user input is ever interpolated into shell strings.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export type DockerResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

/**
 * Parse a dotenv file into a key-value map.
 * Handles `KEY=value` lines; ignores comments and blank lines.
 */
function parseEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      let trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      trimmed = trimmed.replace(/^export\s+/, '');
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
    }
  } catch {
    // File not readable — skip
  }
  return vars;
}

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

/** Get the compose file path from config directory */
function composeFile(configDir: string): string {
  return `${configDir}/components/core.yml`;
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

/**
 * Build the `-f file1 -f file2 ...` args for docker compose.
 * Returns a flat array like ["-f", "path1", "-f", "path2"].
 */
function composeFileArgs(configDir: string, files?: string[]): string[] {
  const fileList = files ?? [composeFile(configDir)];
  return fileList.flatMap((f) => ["-f", f]);
}

/**
 * Append `--env-file <path>` args for each existing env file.
 * Files that do not exist are silently skipped.
 */
function pushEnvFileArgs(args: string[], envFiles?: string[]): void {
  for (const ef of envFiles ?? []) {
    if (existsSync(ef)) args.push("--env-file", ef);
  }
}

/**
 * Build the common prefix args for all docker compose commands:
 *   docker compose -f <file> ... --project-name openpalm [--env-file ...]
 */
function buildComposeArgs(configDir: string, options: { files?: string[]; envFiles?: string[] } = {}): string[] {
  const args = ["compose", ...composeFileArgs(configDir, options.files), "--project-name", "openpalm"];
  pushEnvFileArgs(args, options.envFiles);
  return args;
}

/**
 * Run `docker compose up -d` with the generated compose file(s).
 * Pass `files` to merge multiple compose overlays (e.g. core + channel files).
 */
export async function composeUp(
  configDir: string,
  options: {
    files?: string[];
    profiles?: string[];
    services?: string[];
    envFiles?: string[];
    forceRecreate?: boolean;
    removeOrphans?: boolean;
  } = {}
): Promise<DockerResult> {
  const primaryFile = options.files?.[0] ?? composeFile(configDir);
  if (!existsSync(primaryFile)) {
    return {
      ok: false,
      stdout: "",
      stderr: "Compose file not found",
      code: 1
    };
  }

  const args = buildComposeArgs(configDir, options);

  if (options.profiles) {
    for (const p of options.profiles) {
      args.push("--profile", p);
    }
  }

  args.push("up", "-d");

  if (options.forceRecreate) {
    args.push("--force-recreate");
  }

  if (options.removeOrphans) {
    args.push("--remove-orphans");
  }

  if (options.services && options.services.length > 0) {
    args.push(...options.services);
  }

  // Merge env file values into the process environment so Docker Compose
  // resolves ${VAR} from fresh env files, not stale admin process env.
  // Process env takes precedence over --env-file in Docker Compose,
  // so we must override it explicitly.
  const envOverrides: Record<string, string> = {};
  for (const ef of options.envFiles ?? []) {
    Object.assign(envOverrides, parseEnvFile(ef));
  }

  return run(args, configDir, 300_000, envOverrides);
}

/**
 * Run `docker compose down` to stop and remove containers.
 */
export async function composeDown(
  configDir: string,
  options: {
    files?: string[];
    profiles?: string[];
    removeVolumes?: boolean;
    envFiles?: string[];
  } = {}
): Promise<DockerResult> {
  const primaryFile = options.files?.[0] ?? composeFile(configDir);
  if (!existsSync(primaryFile)) {
    return {
      ok: false,
      stdout: "",
      stderr: "Compose file not found",
      code: 1
    };
  }

  const args = buildComposeArgs(configDir, options);

  if (options.profiles) {
    for (const p of options.profiles) {
      args.push("--profile", p);
    }
  }

  args.push("down");

  if (options.removeVolumes) {
    args.push("-v");
  }

  return run(args, configDir);
}

/**
 * Restart specific services.
 */
export async function composeRestart(
  configDir: string,
  services: string[],
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const primaryFile = options.files?.[0] ?? composeFile(configDir);
  if (!existsSync(primaryFile)) {
    return {
      ok: false,
      stdout: "",
      stderr: "Compose file not found",
      code: 1
    };
  }

  const args = buildComposeArgs(configDir, options);
  args.push("restart", ...services);

  return run(args, configDir);
}

/**
 * Stop specific services.
 */
export async function composeStop(
  configDir: string,
  services: string[],
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const args = buildComposeArgs(configDir, options);
  args.push("stop", ...services);

  return run(args, configDir);
}

/**
 * Start specific services (must already be created).
 */
export async function composeStart(
  configDir: string,
  services: string[],
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const args = buildComposeArgs(configDir, options);
  // Use up -d for specific services to ensure they're created
  args.push("up", "-d", ...services);

  return run(args, configDir);
}

/**
 * Get the status of all containers in the project.
 */
export async function composePs(
  configDir: string,
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const primaryFile = options.files?.[0] ?? composeFile(configDir);
  if (!existsSync(primaryFile)) {
    // If no compose file, just list containers with the project label
    return run(
      [
        "ps",
        "--filter",
        "label=com.docker.compose.project=openpalm",
        "--format",
        "json"
      ],
      configDir
    );
  }

  const args = buildComposeArgs(configDir, options);
  args.push("ps", "--format", "json");

  return run(args, configDir);
}

/**
 * Get logs for specific services or all services.
 */
export async function composeLogs(
  configDir: string,
  services?: string[],
  tail = 100,
  options: { files?: string[]; envFiles?: string[]; since?: string } = {}
): Promise<DockerResult> {
  const args = buildComposeArgs(configDir, options);
  args.push("logs", "--tail", String(tail));

  if (options.since) {
    args.push("--since", options.since);
  }

  if (services && services.length > 0) {
    args.push(...services);
  }

  return run(args, configDir);
}

/**
 * Reload Caddy configuration by restarting the container.
 */
export async function caddyReload(
  configDir: string,
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  return composeRestart(configDir, ["caddy"], options);
}

/**
 * Pull image for a single service.
 */
export async function composePullService(
  configDir: string,
  service: string,
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const args = buildComposeArgs(configDir, options);
  args.push("pull", service);

  const envOverrides: Record<string, string> = {};
  for (const ef of options.envFiles ?? []) {
    Object.assign(envOverrides, parseEnvFile(ef));
  }

  return run(args, configDir, 300_000, envOverrides);
}

/**
 * Pull latest images for all services.
 */
export async function composePull(
  configDir: string,
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const args = buildComposeArgs(configDir, options);
  args.push("pull");

  const envOverrides: Record<string, string> = {};
  for (const ef of options.envFiles ?? []) {
    Object.assign(envOverrides, parseEnvFile(ef));
  }

  return run(args, configDir, 300_000, envOverrides);
}

/**
 * Get resource usage stats for all containers in the project.
 */
export async function composeStats(
  configDir: string,
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const args = buildComposeArgs(configDir, options);
  args.push("stats", "--no-stream", "--format", "json");

  return run(args, configDir);
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
  configDir: string,
  options: { files?: string[]; envFiles?: string[] } = {}
): void {
  const args = buildComposeArgs(configDir, options);
  args.push("--profile", "admin", "up", "-d", "--force-recreate", "--remove-orphans", "admin");

  const envOverrides: Record<string, string> = {};
  for (const ef of options.envFiles ?? []) {
    Object.assign(envOverrides, parseEnvFile(ef));
  }

  try {
    const child = spawn("docker", args, {
      cwd: configDir,
      stdio: "ignore",
      detached: true,
      env: { ...process.env, ...envOverrides }
    });
    child.on("error", (err) => {
      console.error("[selfRecreateAdmin] spawn error:", err.message);
    });
    child.unref();
  } catch (err) {
    console.error("[selfRecreateAdmin] failed to spawn:", err instanceof Error ? err.message : err);
  }
}
