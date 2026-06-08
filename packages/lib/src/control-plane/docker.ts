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

/**
 * Resolve the Docker Compose project name.
 * Honors OP_PROJECT_NAME first for OpenPalm stacks, then COMPOSE_PROJECT_NAME.
 */
export function resolveComposeProjectName(envOverrides: Record<string, string> = {}): string {
  return (
    envOverrides.OP_PROJECT_NAME?.trim() ||
    envOverrides.COMPOSE_PROJECT_NAME?.trim() ||
    process.env.OP_PROJECT_NAME?.trim() ||
    process.env.COMPOSE_PROJECT_NAME?.trim() ||
    "openpalm"
  );
}

/**
 * Result of probing the Docker daemon for an existing compose project that
 * shares our project name.
 *
 * - `exists`   — at least one running container carries the project label.
 * - `isOurs`   — those containers were launched from THIS install's working
 *                dir (compose working_dir label === expectedWorkingDir). When
 *                true the caller should reconcile in place (up --force-recreate).
 *                When false a DIFFERENT OpenPalm install (e.g. dev vs host) owns
 *                the name and the caller must refuse.
 * - `workingDir` — the working_dir label read off the first container, for
 *                error messages. Empty string when unknown.
 */
export type ExistingProject = {
  exists: boolean;
  isOurs: boolean;
  workingDir: string;
};

/**
 * Decide whether a running compose project (identified by its
 * `com.docker.compose.project.working_dir` label) is OURS — i.e. was launched
 * from this install's working dir. An empty/unknown label can't prove foreign,
 * so it counts as ours (reconcile rather than wrongly refuse a redeploy).
 *
 * Pure decision split out from detectExistingProject so the ours-vs-foreign
 * rule is unit-testable without a Docker daemon.
 */
export function isProjectOurs(workingDirLabel: string, expectedWorkingDir: string): boolean {
  const label = workingDirLabel.trim();
  return label === "" || label === expectedWorkingDir;
}

/**
 * Probe the Docker daemon for a running compose project that shares
 * `projectName`. Decides ours-vs-foreign by comparing the project's
 * `com.docker.compose.project.working_dir` label against `expectedWorkingDir`
 * (the install's OP_HOME / compose context).
 *
 * Returns `{ exists:false }` on any docker error (daemon down, no permission) —
 * detection is best-effort and never blocks the caller; a real failure surfaces
 * later through composeUp.
 */
export function detectExistingProject(opts: {
  projectName: string;
  expectedWorkingDir: string;
}): Promise<ExistingProject> {
  const none: ExistingProject = { exists: false, isOurs: false, workingDir: "" };
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["ps", "-q", "--filter", `label=com.docker.compose.project=${opts.projectName}`],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) return resolve(none);
        const ids = stdout.toString().trim().split(/\s+/).filter(Boolean);
        if (ids.length === 0) return resolve(none);
        execFile(
          "docker",
          [
            "inspect",
            "--format",
            '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}',
            ids[0],
          ],
          { timeout: 10_000 },
          (err2, stdout2) => {
            if (err2) return resolve({ exists: true, isOurs: false, workingDir: "" });
            const workingDir = stdout2.toString().trim();
            resolve({ exists: true, isOurs: isProjectOurs(workingDir, opts.expectedWorkingDir), workingDir });
          },
        );
      },
    );
  });
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

/** Build common prefix: compose -f ... --project-name ... --env-file ... --profile ... */
function buildComposeArgs(options: { files: string[]; envFiles?: string[]; profiles?: string[] }): string[] {
  const envOverrides = collectEnvOverrides(options.envFiles);
  const args = ["compose", ...options.files.flatMap((f) => ["-f", f]), "--project-name", resolveComposeProjectName(envOverrides)];
  for (const ef of options.envFiles ?? []) {
    if (existsSync(ef)) args.push("--env-file", ef);
  }
  for (const p of options.profiles ?? []) args.push("--profile", p);
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
  options: { files: string[]; envFiles?: string[]; profiles?: string[] }
): Promise<DockerResult> {
  const args = buildComposeArgs(options);
  args.push("config", "--quiet");
  return run(args, undefined, 30_000, collectEnvOverrides(options.envFiles));
}

/**
 * Run compose config preflight validation before any mutation.
 * Skipped when OP_SKIP_COMPOSE_PREFLIGHT is set (tests, CI).
 */
async function runPreflight(options: { files: string[]; envFiles?: string[]; profiles?: string[] }): Promise<void> {
  if (options.files.length === 0 || process.env.OP_SKIP_COMPOSE_PREFLIGHT) return;
  const result = await composePreflight(options);
  if (!result.ok) {
    const project = resolveComposeProjectName(collectEnvOverrides(options.envFiles));
    const fileArgs = options.files.map((f) => `-f ${f}`).join(" ");
    const envArgs = (options.envFiles ?? []).map((f) => `--env-file ${f}`).join(" ");
    const profileArgs = (options.profiles ?? []).map((p) => `--profile ${p}`).join(" ");
    throw new Error(
      `Compose preflight failed: ${result.stderr}\n` +
      `Resolved command: docker compose ${fileArgs} --project-name ${project} ${envArgs} ${profileArgs} config --quiet`
    );
  }
}

export async function composeConfigServices(
  options: { files: string[]; envFiles?: string[]; profiles?: string[] }
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
  await runPreflight(options);
  if (!existsSync(options.files[0])) {
    return { ok: false, stdout: "", stderr: "Compose file not found", code: 1 };
  }
  const args = buildComposeArgs(options);
  args.push("up", "-d");
  if (options.forceRecreate) args.push("--force-recreate");
  if (options.removeOrphans) args.push("--remove-orphans");
  if (options.services?.length) args.push(...options.services);
  return run(args, undefined, composeUpTimeoutMs(), collectEnvOverrides(options.envFiles));
}

/**
 * Timeout budget for `compose up`. A first install extracts multi-GB images
 * (voice CUDA ~7.6 GB) onto slow disks; the previous hard 5-minute cap
 * SIGTERM-killed the start mid-extraction and surfaced as an empty/opaque
 * error. Default 30 min, override with OP_COMPOSE_UP_TIMEOUT_MS. Kept bounded
 * (never removed) so a genuinely hung start still eventually fails.
 */
function composeUpTimeoutMs(): number {
  const raw = process.env.OP_COMPOSE_UP_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 30 * 60_000;
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
  await runPreflight(options);
  if (!existsSync(options.files[0])) {
    return { ok: false, stdout: "", stderr: "Compose file not found", code: 1 };
  }
  const args = buildComposeArgs(options);
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
  await runPreflight(options);
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
  await runPreflight(options);
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
  await runPreflight(options);
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

// 60-minute pull timeout. Voice addon ships a ~2.4 GB image (CPU) /
// ~7.6 GB (CUDA); on a 1-2 Mbps home connection these legitimately take
// 30+ minutes. The previous 5-min cap silently killed pulls mid-stream
// on first install, surfacing as an opaque "pull failed". The wizard's
// retry layer wraps this, so an actually-hung pull is bounded by the
// outer retry budget; this just gives any progressing pull room to
// finish on slow connections.
const PULL_TIMEOUT_MS = 60 * 60_000;

/**
 * Pull image for a single service.
 */
export async function composePullService(
  service: string,
  options: { files: string[]; envFiles?: string[]; profiles?: string[] }
): Promise<DockerResult> {
  await runPreflight(options);
  const args = buildComposeArgs(options);
  args.push("pull", service);
  return run(args, undefined, PULL_TIMEOUT_MS, collectEnvOverrides(options.envFiles));
}

export async function composePull(
  options: { files: string[]; envFiles?: string[]; profiles?: string[] }
): Promise<DockerResult> {
  await runPreflight(options);
  const args = buildComposeArgs(options);
  args.push("pull");
  return run(args, undefined, PULL_TIMEOUT_MS, collectEnvOverrides(options.envFiles));
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
 * Query Docker for a container's running state by name.
 * Returns "running" or "stopped". Falls back to "unknown" on error.
 */
export function inspectContainerStatus(
  containerName: string
): Promise<"running" | "stopped" | "unknown"> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["inspect", "--format", "{{.State.Status}}", containerName],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve("unknown");
          return;
        }
        const status = (stdout ?? "").toString().trim();
        resolve(status === "running" ? "running" : "stopped");
      }
    );
  });
}
