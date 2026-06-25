/** Docker integration — executes docker compose commands via execFile (no shell). */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "./env.js";
import { createLogger } from "../logger.js";
import { resolveOperatorIds } from "./operator-ids.js";
import { mapDockerError, parseComposeStderr } from "./compose-errors.js";

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

/** Merge all env files into a single overrides object for process env. */
export function collectComposeEnvOverrides(envFiles?: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const ef of envFiles ?? []) Object.assign(overrides, parseEnvFile(ef));
  return overrides;
}

/** Build common docker compose args: -f ... --project-name ... --env-file ... --profile ... */
export function buildComposeCommandArgs(options: { files: string[]; envFiles?: string[]; profiles?: string[] }): string[] {
  const envOverrides = collectComposeEnvOverrides(options.envFiles);
  const args = ["--project-name", resolveComposeProjectName(envOverrides), ...options.files.flatMap((f) => ["-f", f])];
  for (const ef of options.envFiles ?? []) {
    if (existsSync(ef)) args.push("--env-file", ef);
  }
  for (const p of options.profiles ?? []) args.push("--profile", p);
  return args;
}

/** Build common prefix: compose -f ... --project-name ... --env-file ... --profile ... */
function buildComposeArgs(options: { files: string[]; envFiles?: string[]; profiles?: string[] }): string[] {
  return ["compose", ...buildComposeCommandArgs(options)];
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
  return run(args, undefined, 30_000, collectComposeEnvOverrides(options.envFiles));
}

/**
 * Run compose config preflight validation before any mutation.
 * Skipped when OP_SKIP_COMPOSE_PREFLIGHT is set (tests, CI).
 */
async function runPreflight(options: { files: string[]; envFiles?: string[]; profiles?: string[] }): Promise<void> {
  if (options.files.length === 0 || process.env.OP_SKIP_COMPOSE_PREFLIGHT) return;
  const result = await composePreflight(options);
  if (!result.ok) {
    const project = resolveComposeProjectName(collectComposeEnvOverrides(options.envFiles));
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
  const result = await run(args, undefined, 30_000, collectComposeEnvOverrides(options.envFiles));
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
  return run(args, undefined, composeUpTimeoutMs(), collectComposeEnvOverrides(options.envFiles));
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
    // Remove containers for services NOT in the (profile-resolved) compose set.
    // Needed to clean up a previously-enabled-then-disabled profile-gated addon
    // (e.g. in-stack Ollama): with its profile now inactive, `down` alone leaves
    // its stopped container behind because compose no longer "sees" the service.
    removeOrphans?: boolean;
  }
): Promise<DockerResult> {
  await runPreflight(options);
  if (!existsSync(options.files[0])) {
    return { ok: false, stdout: "", stderr: "Compose file not found", code: 1 };
  }
  const args = buildComposeArgs(options);
  args.push("down");
  if (options.removeVolumes) args.push("-v");
  if (options.removeOrphans) args.push("--remove-orphans");
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
  return run(args, undefined, PULL_TIMEOUT_MS, collectComposeEnvOverrides(options.envFiles));
}

export async function composePull(
  options: { files: string[]; envFiles?: string[]; profiles?: string[] }
): Promise<DockerResult> {
  await runPreflight(options);
  const args = buildComposeArgs(options);
  args.push("pull");
  return run(args, undefined, PULL_TIMEOUT_MS, collectComposeEnvOverrides(options.envFiles));
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
 * Execute a command inside a running compose service without allocating a TTY.
 */
export async function composeExec(
  service: string,
  command: string[],
  options: { files: string[]; envFiles?: string[]; profiles?: string[]; timeoutMs?: number },
): Promise<DockerResult> {
  await runPreflight(options);
  const primaryFile = options.files[0];
  if (!existsSync(primaryFile)) {
    return { ok: false, stdout: '', stderr: 'Compose file not found', code: 1 };
  }

  const args = buildComposeArgs(options);
  args.push('exec', '-T', service, ...command);
  return run(args, undefined, options.timeoutMs ?? 120_000, collectComposeEnvOverrides(options.envFiles));
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
 * Fix root-owned bind-mount directories under OP_HOME by running a temporary
 * Docker container as root to chown them back to the operator UID:GID.
 *
 * Needed because the guardian container historically ran as root (no `user:`
 * directive), leaving data/guardian and data/logs owned by root on the host.
 * The host process cannot chown root-owned files without being root itself,
 * so we delegate to Docker — which has root access via the daemon.
 *
 * No-op on Windows or when no directories need fixing.
 */
export async function repairRootOwnedBindMounts(homeDir: string): Promise<void> {
  if (process.platform === 'win32') return;

  const candidates = [
    join(homeDir, 'data', 'guardian'),
    join(homeDir, 'data', 'logs'),
  ];

  const rootOwned = candidates.filter((dir) => {
    try {
      return existsSync(dir) && statSync(dir).uid === 0;
    } catch {
      return false;
    }
  });

  if (rootOwned.length === 0) return;

  const ids = resolveOperatorIds(homeDir);
  if (!ids) return;

  const volumeArgs = rootOwned.flatMap((dir, i) => ['-v', `${dir}:/chown_target_${i}`]);
  const targets = rootOwned.map((_, i) => `/chown_target_${i}`).join(' ');

  logger.info(`Repairing root-owned bind mounts: ${rootOwned.map(d => d.split('/').slice(-2).join('/')).join(', ')}`);
  const result = await run([
    'run', '--rm',
    ...volumeArgs,
    'alpine',
    'sh', '-c', `chown -R ${ids.uid}:${ids.gid} ${targets}`,
  ], undefined, 30_000);

  if (!result.ok) {
    logger.warn(`Could not repair root-owned bind mounts: ${result.stderr.trim()}`);
  }
}

/**
 * Full runtime image info for a single container (§5 truthful state).
 *
 * - `digest`      — {{.Image}}: the sha256 the container was CREATED FROM.
 * - `tag`         — {{.Config.Image}}: the human tag (e.g. openpalm/assistant:latest).
 * - `healthStatus`— {{.State.Health.Status}}: "healthy"|"unhealthy"|"starting"|"" (no healthcheck).
 * - `state`       — "running"|"stopped"|"not_installed".
 *
 * Stopped containers still have a known image; absent containers are "not_installed".
 */
export type ContainerImageInfo = {
  digest: string;
  tag: string;
  healthStatus: string;
  state: "running" | "stopped" | "not_installed";
};

/**
 * Inspect a single container by name and return its full image + health info.
 * "not_installed" when the container does not exist; "stopped" when it exists but is not running.
 */
export function inspectContainerImage(containerName: string): Promise<ContainerImageInfo> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      [
        "inspect",
        "--format",
        "{{.State.Status}}\t{{.Image}}\t{{.Config.Image}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}",
        containerName,
      ],
      { timeout: 10_000 },
      (error, stdout) => {
        if (error) {
          // Container does not exist (exit code 1, "No such object")
          resolve({ digest: "", tag: "", healthStatus: "", state: "not_installed" });
          return;
        }
        const [rawState = "", digest = "", tag = "", healthStatus = ""] = (stdout ?? "")
          .toString()
          .trim()
          .split("\t");
        const state = rawState === "running" ? "running" : "stopped";
        resolve({ digest, tag, healthStatus, state });
      }
    );
  });
}

/**
 * Return the running image info for every container in a compose project (§5 truthful state).
 *
 * Keys are compose service names; values are ContainerImageInfo.
 * Services that have no container (not created yet) are returned with state "not_installed".
 * Services that exist but are stopped say "stopped".
 *
 * This is the canonical "what is actually running" data source — never env-file pins.
 */
export async function getRunningImages(options: {
  files: string[];
  envFiles?: string[];
  profiles?: string[];
}): Promise<Record<string, ContainerImageInfo>> {
  // Get the list of service names from `compose ps --format json`
  const psArgs = buildComposeArgs(options);
  psArgs.push("ps", "--format", "json", "--all");
  const psResult = await run(psArgs, undefined, 15_000, collectComposeEnvOverrides(options.envFiles));

  const out: Record<string, ContainerImageInfo> = {};

  if (!psResult.ok || !psResult.stdout.trim()) {
    return out;
  }

  // compose ps --format json may output one JSON object per line or a JSON array
  const lines = psResult.stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let entry: { Service?: string; Name?: string } | undefined;
    try { entry = JSON.parse(line); } catch { continue; }
    const service = entry?.Service ?? entry?.Name ?? "";
    if (!service) continue;
    // Inspect by container name (Name field) or fall back to service
    const containerName = (entry as { Name?: string }).Name ?? service;
    out[service] = await inspectContainerImage(containerName);
  }

  return out;
}

// ── Health-wait ─────────────────────────────────────────────────────────────

/** Default health-wait parameters. Override via OP_HEALTH_WAIT_TIMEOUT_MS. */
const HEALTH_WAIT_DEFAULTS = { timeoutMs: 120_000, pollMs: 3_000 } as const;

function healthWaitTimeoutMs(): number {
  const raw = process.env.OP_HEALTH_WAIT_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : HEALTH_WAIT_DEFAULTS.timeoutMs;
}

/**
 * Poll `docker inspect` on `containerName` until its State.Health.Status is
 * "healthy" (or the container has no healthcheck, in which case "running" is
 * sufficient). Returns true on success; false on timeout with a log message.
 *
 * Containers with no healthcheck (`healthStatus === ""`) are declared healthy
 * immediately once they are in state "running" — compose started them, they
 * haven't crashed, that's the best signal we have.
 */
export async function waitForContainerHealthy(
  containerName: string,
  timeoutMs = healthWaitTimeoutMs(),
  pollMs = HEALTH_WAIT_DEFAULTS.pollMs,
): Promise<{ healthy: boolean; timedOut: boolean; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await inspectContainerImage(containerName);
    if (info.state === "not_installed") {
      return { healthy: false, timedOut: false, reason: `container ${containerName} does not exist` };
    }
    if (info.state === "stopped") {
      // Container exited — fail immediately rather than burning the full timeout.
      return { healthy: false, timedOut: false, reason: `container ${containerName} exited` };
    }
    if (info.state === "running") {
      // No healthcheck → running is good enough
      if (!info.healthStatus || info.healthStatus === "healthy") {
        return { healthy: true, timedOut: false, reason: "healthy" };
      }
      if (info.healthStatus === "unhealthy") {
        return { healthy: false, timedOut: false, reason: `container ${containerName} is unhealthy` };
      }
      // "starting" — keep polling
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const elapsed = Math.round(timeoutMs / 1000);
  return {
    healthy: false,
    timedOut: true,
    reason: `container ${containerName} did not become healthy within ${elapsed}s`,
  };
}

// ── applyStack — the single compose driver (§4.3) ───────────────────────────

export type ApplyStackScope =
  | { kind: "service"; service: string }
  | { kind: "all" };

export type ApplyStackResult = {
  ok: boolean;
  /** Services that were successfully brought up. */
  started: string[];
  /** Per-service failures from compose stderr. */
  failed: { service: string; reason: string }[];
  /** Top-level error string (when compose itself fails and no per-service parse). */
  error?: string;
};

/**
 * The SINGLE Docker Compose driver for update (§4.3).
 *
 * pull-before-up, always. Pull failure is FATAL — never silently falls through
 * to a stale local image. Active profiles are always passed (§4.3 "profiles on
 * every command"). Success = running AND healthy (waitForContainerHealthy).
 *
 * scope = { kind:"service", service:"assistant" }  →  pull <svc> + up --force-recreate --no-deps <svc>
 * scope = { kind:"all" }                           →  pull + up --remove-orphans
 *
 * Callers (install and update endpoints) pass the resolved ComposeOptions so
 * this function never builds them itself — profiles are already resolved.
 */
export async function applyStack(
  scope: ApplyStackScope,
  options: { files: string[]; envFiles?: string[]; profiles?: string[] },
): Promise<ApplyStackResult> {
  const envOverrides = collectComposeEnvOverrides(options.envFiles);
  const base = buildComposeArgs(options);

  // ── 1. Pull the whole target set FIRST (§4.3 "Pull the whole target set first") ──
  const pullArgs = [...base, "pull"];
  if (scope.kind === "service") pullArgs.push(scope.service);

  const pullResult = await run(pullArgs, undefined, PULL_TIMEOUT_MS, envOverrides);
  if (!pullResult.ok) {
    // Pull failure is FATAL (§6, constitution §8 "never swallowed").
    // Route through mapDockerError so the user sees a named, friendly message
    // (rate_limited / manifest_unknown / network_error / image_auth) instead of
    // raw daemon stderr.
    const mapped = mapDockerError(pullResult.stderr || "image pull failed");
    return {
      ok: false,
      started: [],
      failed: [{ service: scope.kind === "service" ? scope.service : "stack", reason: mapped.message }],
      error: mapped.message,
    };
  }

  // ── 2. Compose up ────────────────────────────────────────────────────────
  const upArgs = [...base, "up", "-d"];
  if (scope.kind === "service") {
    upArgs.push("--force-recreate", "--no-deps", scope.service);
  } else {
    upArgs.push("--remove-orphans");
  }

  const upResult = await run(upArgs, undefined, composeUpTimeoutMs(), envOverrides);

  // ── 3. Parse per-service failures from stderr ─────────────────────────────
  if (!upResult.ok) {
    const failed = parseComposeStderr(upResult.stderr);
    if (failed.length === 0) {
      // No per-service parse succeeded — map the full stderr to a named friendly message (§6).
      const mapped = mapDockerError(upResult.stderr || `docker compose exited with code ${upResult.code}`);
      return {
        ok: false,
        started: [],
        failed: [{ service: scope.kind === "service" ? scope.service : "stack", reason: mapped.message }],
        error: mapped.message,
      };
    }
    // Per-service failures parsed: map each reason through mapDockerError so
    // individual service failures also surface friendly named messages (§6).
    const friendlyFailed = failed.map((f) => ({
      service: f.service,
      reason: mapDockerError(f.reason).message,
    }));
    const topLevelMapped = mapDockerError(upResult.stderr);
    return { ok: false, started: [], failed: friendlyFailed, error: topLevelMapped.message };
  }

  // ── 4. Success = running AND healthy (§4.3) ───────────────────────────────
  const targetServices =
    scope.kind === "service"
      ? [scope.service]
      : await (async () => {
          const configArgs = [...base, "config", "--services"];
          const r = await run(configArgs, undefined, 15_000, envOverrides);
          return r.ok ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
        })();

  const started: string[] = [];
  const failed: { service: string; reason: string }[] = [];

  for (const svc of targetServices) {
    // Get the container name from compose ps
    const psArgs = [...base, "ps", "-q", svc];
    const psResult = await run(psArgs, undefined, 10_000, envOverrides);
    const containerId = psResult.stdout.trim();
    if (!containerId) {
      failed.push({ service: svc, reason: `container for service ${svc} not found after up` });
      continue;
    }
    const wait = await waitForContainerHealthy(containerId);
    if (wait.healthy) {
      started.push(svc);
    } else {
      failed.push({ service: svc, reason: wait.reason });
    }
  }

  return {
    ok: failed.length === 0,
    started,
    failed,
    ...(failed.length > 0 ? { error: failed.map((f) => f.reason).join("; ") } : {}),
  };
}
