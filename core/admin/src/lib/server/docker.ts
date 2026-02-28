/**
 * Docker integration — executes real docker compose commands.
 *
 * This module shells out to `docker compose` for lifecycle operations.
 * It reads the generated docker-compose.yml from the state directory
 * and uses it for all operations.
 *
 * Security: All commands use execFile with argument arrays to prevent
 * command injection. No user input is ever interpolated into shell strings.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

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
  timeoutMs = 120_000
): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      args,
      { cwd, timeout: timeoutMs, env: { ...process.env } },
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

/** Get the compose file path from state directory */
function composeFile(stateDir: string): string {
  return `${stateDir}/artifacts/docker-compose.yml`;
}

/** Check if Docker is available */
export async function checkDocker(): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
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
function composeFileArgs(stateDir: string, files?: string[]): string[] {
  const fileList = files ?? [composeFile(stateDir)];
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
 * Run `docker compose up -d` with the generated compose file(s).
 * Pass `files` to merge multiple compose overlays (e.g. core + channel files).
 */
export async function composeUp(
  stateDir: string,
  options: {
    files?: string[];
    profiles?: string[];
    services?: string[];
    envFiles?: string[];
  } = {}
): Promise<DockerResult> {
  const primaryFile = options.files?.[0] ?? composeFile(stateDir);
  if (!existsSync(primaryFile)) {
    return {
      ok: false,
      stdout: "",
      stderr: "Compose file not found",
      code: 1
    };
  }

  const args = [
    "compose",
    ...composeFileArgs(stateDir, options.files),
    "--project-name",
    "openpalm"
  ];

  pushEnvFileArgs(args, options.envFiles);

  if (options.profiles) {
    for (const p of options.profiles) {
      args.push("--profile", p);
    }
  }

  args.push("up", "-d");

  if (options.services && options.services.length > 0) {
    args.push(...options.services);
  }

  return run(args, stateDir, 300_000);
}

/**
 * Run `docker compose down` to stop and remove containers.
 */
export async function composeDown(
  stateDir: string,
  options: {
    files?: string[];
    removeVolumes?: boolean;
    envFiles?: string[];
  } = {}
): Promise<DockerResult> {
  const primaryFile = options.files?.[0] ?? composeFile(stateDir);
  if (!existsSync(primaryFile)) {
    return {
      ok: false,
      stdout: "",
      stderr: "Compose file not found",
      code: 1
    };
  }

  const args = [
    "compose",
    ...composeFileArgs(stateDir, options.files),
    "--project-name",
    "openpalm"
  ];

  pushEnvFileArgs(args, options.envFiles);

  args.push("down");

  if (options.removeVolumes) {
    args.push("-v");
  }

  return run(args, stateDir);
}

/**
 * Restart specific services.
 */
export async function composeRestart(
  stateDir: string,
  services: string[],
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const primaryFile = options.files?.[0] ?? composeFile(stateDir);
  if (!existsSync(primaryFile)) {
    return {
      ok: false,
      stdout: "",
      stderr: "Compose file not found",
      code: 1
    };
  }

  const args = [
    "compose",
    ...composeFileArgs(stateDir, options.files),
    "--project-name",
    "openpalm"
  ];

  pushEnvFileArgs(args, options.envFiles);

  args.push("restart", ...services);

  return run(args, stateDir);
}

/**
 * Stop specific services.
 */
export async function composeStop(
  stateDir: string,
  services: string[],
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const args = [
    "compose",
    ...composeFileArgs(stateDir, options.files),
    "--project-name",
    "openpalm"
  ];

  pushEnvFileArgs(args, options.envFiles);

  args.push("stop", ...services);

  return run(args, stateDir);
}

/**
 * Start specific services (must already be created).
 */
export async function composeStart(
  stateDir: string,
  services: string[],
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const args = [
    "compose",
    ...composeFileArgs(stateDir, options.files),
    "--project-name",
    "openpalm"
  ];

  pushEnvFileArgs(args, options.envFiles);

  // Use up -d for specific services to ensure they're created
  args.push("up", "-d", ...services);

  return run(args, stateDir);
}

/**
 * Get the status of all containers in the project.
 */
export async function composePs(
  stateDir: string,
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const primaryFile = options.files?.[0] ?? composeFile(stateDir);
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
      stateDir
    );
  }

  const args = [
    "compose",
    ...composeFileArgs(stateDir, options.files),
    "--project-name",
    "openpalm"
  ];

  pushEnvFileArgs(args, options.envFiles);

  args.push("ps", "--format", "json");

  return run(args, stateDir);
}

/**
 * Get logs for specific services or all services.
 */
export async function composeLogs(
  stateDir: string,
  services?: string[],
  tail = 100,
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const args = [
    "compose",
    ...composeFileArgs(stateDir, options.files),
    "--project-name",
    "openpalm"
  ];

  pushEnvFileArgs(args, options.envFiles);

  args.push("logs", "--tail", String(tail));

  if (services && services.length > 0) {
    args.push(...services);
  }

  return run(args, stateDir);
}

/**
 * Reload Caddy configuration without restarting.
 * Uses `docker compose exec` to trigger a graceful config reload.
 */
export async function caddyReload(
  stateDir: string,
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const args = [
    "compose",
    ...composeFileArgs(stateDir, options.files),
    "--project-name",
    "openpalm"
  ];

  pushEnvFileArgs(args, options.envFiles);

  args.push(
    "exec",
    "-T",
    "caddy",
    "caddy",
    "reload",
    "--config",
    "/etc/caddy/Caddyfile",
    "--adapter",
    "caddyfile"
  );

  return run(args, stateDir);
}

/**
 * Pull latest images for all services.
 */
export async function composePull(
  stateDir: string,
  options: { files?: string[]; envFiles?: string[] } = {}
): Promise<DockerResult> {
  const args = [
    "compose",
    ...composeFileArgs(stateDir, options.files),
    "--project-name",
    "openpalm"
  ];

  pushEnvFileArgs(args, options.envFiles);

  args.push("pull");

  return run(args, stateDir, 300_000);
}
