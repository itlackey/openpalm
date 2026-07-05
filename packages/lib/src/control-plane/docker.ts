/** Docker integration — executes docker compose commands via execFile (no shell). */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnvFile } from "./env.js";
import { mapDockerError, parseComposeStderr } from "./compose-errors.js";

export type DockerResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  /**
   * Node's string error code (errno) for a spawn/OS failure, e.g. "ENOENT" when
   * the docker binary is missing. Present ONLY when the underlying error carried
   * a non-numeric `code` — for a normal non-zero process exit `code` holds the
   * numeric exit status and this is absent.
   */
  errorCode?: string;
};

/**
 * Build a {@link DockerResult} from a node:child_process callback.
 *
 * Node's `error.code` is OVERLOADED: for a process that exits non-zero it is the
 * numeric exit status, but for a spawn/OS failure it is a STRING errno
 * ("ENOENT", "EACCES", …). Blindly `Number(error.code)`-ing the string yields
 * NaN silently stored in a `number` field, so callers branching on `result.code`
 * (e.g. `allowExitCodes.includes(result.code)`) get garbage. This normalizes:
 * numeric codes pass through unchanged; a string code surfaces via `errorCode`
 * while `code` falls back to a non-zero sentinel (any error ⇒ non-zero).
 *
 * Pure and exported (package-internal) so the string-code path is unit-testable
 * without spawning docker.
 */
export function toDockerResult(
  error: (Error & { code?: unknown }) | null | undefined,
  stdout: string | Buffer | undefined,
  stderr: string | Buffer | undefined,
): DockerResult {
  const rawCode = error?.code;
  const code = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
  const result: DockerResult = {
    ok: !error,
    stdout: stdout?.toString() ?? "",
    stderr: stderr?.toString() ?? "",
    code,
  };
  if (typeof rawCode === "string") result.errorCode = rawCode;
  return result;
}

// ── Injection seam (DockerClient + FileStore) ────────────────────────────────
//
// docker.ts hard-wires node:child_process (execFile) and node:fs at module
// scope, so the §4.3 compose driver (applyStack) and its health/inspect helpers
// could only be exercised against a real daemon + disk. These two narrow
// interfaces let callers inject fakes — mirroring the DI already in
// ui-supervisor.ts and install-lock.ts. Defaults are the real impls, so every
// existing caller (which omits `deps`) is byte-identical.

/** Options for a single {@link DockerClient.run} invocation. */
export type DockerRunOptions = {
  cwd?: string;
  /** Kill budget in ms; omit for the {@link run} default (120s). */
  timeoutMs?: number;
  /** Extra env layered over process.env for this invocation. */
  env?: Record<string, string>;
};

/**
 * Narrow seam over the docker CLI: one `run(args, opts?)` method mirroring the
 * module-level {@link run} execFile wrapper. Injecting a fake lets applyStack and
 * the inspect/health helpers be unit-tested without spawning docker.
 */
export interface DockerClient {
  run(args: string[], opts?: DockerRunOptions): Promise<DockerResult>;
}

/**
 * Narrow seam over the fs the compose driver touches: `exists` gates the
 * `--env-file` compose args; `read`/`write` are provided for the deploy/lifecycle
 * consumers that share this contract. Injecting a fake removes the disk
 * dependency from unit tests.
 */
export interface FileStore {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, data: string, mode?: number): void;
}

/** Injected dependencies for the compose driver. Defaults to the real impls. */
export interface StackDeps {
  docker: DockerClient;
  files: FileStore;
}

/** Real DockerClient — thin adapter over the execFile-backed {@link run}. */
export const realDockerClient: DockerClient = {
  run: (args, opts) => run(args, opts?.cwd, opts?.timeoutMs, opts?.env),
};

/** Real FileStore — thin adapter over node:fs. */
export const realFileStore: FileStore = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, "utf-8"),
  write: (path, data, mode) =>
    writeFileSync(path, data, mode !== undefined ? { mode } : undefined),
};

/** The default (real) dependency bundle threaded when a caller omits `deps`. */
export const defaultStackDeps: StackDeps = {
  docker: realDockerClient,
  files: realFileStore,
};

/**
 * Execute docker with an argument array — no shell interpolation.
 *
 * Exported (package-internal — not surfaced through the barrel) so the
 * volume-ownership repair subsystem reuses the exact same execFile wrapper
 * instead of re-implementing it.
 */
export function run(
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
        resolve(toDockerResult(error, stdout, stderr));
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
export async function detectExistingProject(opts: {
  projectName: string;
  expectedWorkingDir: string;
}): Promise<ExistingProject> {
  const none: ExistingProject = { exists: false, isOurs: false, workingDir: "" };
  const ps = await run(
    ["ps", "-q", "--filter", `label=com.docker.compose.project=${opts.projectName}`],
    undefined,
    10_000,
  );
  if (!ps.ok) return none;
  const ids = ps.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) return none;
  const inspect = await run(
    [
      "inspect",
      "--format",
      '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}',
      ids[0],
    ],
    undefined,
    10_000,
  );
  if (!inspect.ok) return { exists: true, isOurs: false, workingDir: "" };
  const workingDir = inspect.stdout.trim();
  return { exists: true, isOurs: isProjectOurs(workingDir, opts.expectedWorkingDir), workingDir };
}

/** Check if Docker is available */
export async function checkDocker(): Promise<DockerResult> {
  // No timeout (0) — `docker info` was historically unbounded here.
  const result = await run(["info", "--format", "{{.ServerVersion}}"], undefined, 0);
  const stdout = result.stdout.trim();
  // docker info may exit non-zero when the daemon reports warnings
  // (e.g. "No swap limit support") even though it is fully functional.
  // Treat Docker as available when stdout contains a version string.
  const available = stdout.length > 0 || result.ok;
  return { ok: available, stdout, stderr: result.stderr, code: result.code };
}

/** Check if docker compose is available */
export async function checkDockerCompose(): Promise<DockerResult> {
  // No timeout (0) — historically unbounded here.
  return run(["compose", "version"], undefined, 0);
}

/** Merge all env files into a single overrides object for process env. */
export function collectComposeEnvOverrides(envFiles?: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const ef of envFiles ?? []) Object.assign(overrides, parseEnvFile(ef));
  return overrides;
}

/** Build common docker compose args: -f ... --project-name ... --env-file ... --profile ... */
export function buildComposeCommandArgs(
  options: { files: string[]; envFiles?: string[]; profiles?: string[] },
  files: FileStore = realFileStore,
): string[] {
  const envOverrides = collectComposeEnvOverrides(options.envFiles);
  const args = ["--project-name", resolveComposeProjectName(envOverrides), ...options.files.flatMap((f) => ["-f", f])];
  for (const ef of options.envFiles ?? []) {
    if (files.exists(ef)) args.push("--env-file", ef);
  }
  for (const p of options.profiles ?? []) args.push("--profile", p);
  return args;
}

/** Build common prefix: compose -f ... --project-name ... --env-file ... --profile ... */
function buildComposeArgs(
  options: { files: string[]; envFiles?: string[]; profiles?: string[] },
  files: FileStore = realFileStore,
): string[] {
  return ["compose", ...buildComposeCommandArgs(options, files)];
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
 * Build the human-facing error message for a failed compose preflight
 * (`docker compose config --quiet`). SINGLE SOURCE OF TRUTH: lib's own
 * {@link runPreflight} and the CLI's compose path both call this so the two
 * never diverge again.
 *
 * The message includes, in order:
 *   - the raw preflight stderr,
 *   - the resolved `docker compose … config --quiet` command (WITH `--profile`
 *     args) so the failure is reproducible,
 *   - the file / env-file / project breakdown,
 *   - repair guidance when the failure looks like a missing secret/asset file.
 *     A missing secret means OP_HOME is incomplete — usually a home behind the
 *     running platform (secrets are written only by install/update, not
 *     self-healed on a plain command) — so we point the user at `openpalm
 *     update` instead of leaving them with a raw compose "file not found".
 */
export function buildComposePreflightError(
  options: { files: string[]; envFiles?: string[]; profiles?: string[] },
  stderr: string,
): string {
  const project = resolveComposeProjectName(collectComposeEnvOverrides(options.envFiles));
  const files = options.files;
  const envFiles = options.envFiles ?? [];
  const profiles = options.profiles ?? [];
  const fileArgs = files.map((f) => `-f ${f}`).join(" ");
  const envArgs = envFiles.map((f) => `--env-file ${f}`).join(" ");
  const profileArgs = profiles.map((p) => `--profile ${p}`).join(" ");
  const resolvedCommand = [
    "docker compose",
    fileArgs,
    `--project-name ${project}`,
    envArgs,
    profileArgs,
    "config --quiet",
  ].filter(Boolean).join(" ");

  const looksLikeMissingFile = /secret/i.test(stderr)
    && /(not found|no such file|does not exist|cannot find)/i.test(stderr);
  const guidance = looksLikeMissingFile
    ? "\n\nThis usually means your OpenPalm home is missing files. Run `openpalm update` to repair it, then try again."
    : "";

  return (
    `Compose preflight failed: ${stderr}\n` +
    `Resolved command: ${resolvedCommand}\n` +
    `Files: ${files.join(", ")}\n` +
    `Env files: ${envFiles.filter(existsSync).join(", ")}\n` +
    `Profiles: ${profiles.join(", ") || "(none)"}\n` +
    `Project: ${project}` +
    guidance
  );
}

/**
 * Run compose config preflight validation before any mutation.
 * Skipped when OP_SKIP_COMPOSE_PREFLIGHT is set (tests, CI).
 */
async function runPreflight(options: { files: string[]; envFiles?: string[]; profiles?: string[] }): Promise<void> {
  if (options.files.length === 0 || process.env.OP_SKIP_COMPOSE_PREFLIGHT) return;
  const result = await composePreflight(options);
  if (!result.ok) {
    throw new Error(buildComposePreflightError(options, result.stderr));
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
 *
 * Exported so interactive callers that stream stdio (the CLI's `up` path via
 * {@link runComposeStreaming}) apply the SAME budget as the capturing
 * {@link composeUp} — the two must not diverge.
 */
export function composeUpTimeoutMs(): number {
  const raw = process.env.OP_COMPOSE_UP_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 30 * 60_000;
}

/**
 * Run `docker compose <args>` streaming stdio to the parent (interactive).
 *
 * The capturing {@link run} helper is wrong for user-facing CLI commands (`up`,
 * `logs`, `down`): those need live progress/log output on the terminal. This is
 * the ONE stdio-inheriting compose runner — the CLI shares it instead of
 * re-implementing the spawn. Node-compatible (`node:child_process` spawn), so it
 * works under both Bun and Node.
 *
 * Rejects on a spawn error or non-zero exit. `timeoutMs`, when set, SIGTERM-kills
 * a run that exceeds the budget (pass {@link composeUpTimeoutMs} for `up`, which
 * may extract multi-GB images on a first install); omit it for interactive
 * follows like `logs -f` that legitimately run unbounded.
 */
export function runComposeStreaming(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", ...args], { stdio: "inherit" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => { child.kill("SIGTERM"); }, opts.timeoutMs);
    }
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`docker compose ${args.join(" ")} failed with exit code ${code}`));
    });
  });
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
export async function inspectContainerImage(
  containerName: string,
  deps: StackDeps = defaultStackDeps,
): Promise<ContainerImageInfo> {
  const result = await deps.docker.run(
    [
      "inspect",
      "--format",
      "{{.State.Status}}\t{{.Image}}\t{{.Config.Image}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}",
      containerName,
    ],
    { timeoutMs: 10_000 },
  );
  if (!result.ok) {
    // Container does not exist (exit code 1, "No such object")
    return { digest: "", tag: "", healthStatus: "", state: "not_installed" };
  }
  const [rawState = "", digest = "", tag = "", healthStatus = ""] = result.stdout
    .trim()
    .split("\t");
  const state = rawState === "running" ? "running" : "stopped";
  return { digest, tag, healthStatus, state };
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
  deps: StackDeps = defaultStackDeps,
): Promise<{ healthy: boolean; timedOut: boolean; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await inspectContainerImage(containerName, deps);
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
  deps: StackDeps = defaultStackDeps,
): Promise<ApplyStackResult> {
  const { docker, files } = deps;
  const envOverrides = collectComposeEnvOverrides(options.envFiles);
  const base = buildComposeArgs(options, files);

  // ── 1. Pull the whole target set FIRST (§4.3 "Pull the whole target set first") ──
  const pullArgs = [...base, "pull"];
  if (scope.kind === "service") pullArgs.push(scope.service);

  const pullResult = await docker.run(pullArgs, { timeoutMs: PULL_TIMEOUT_MS, env: envOverrides });
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
  // --force-recreate is REQUIRED on both scopes: a container whose managed
  // compose config is unchanged would otherwise stay on its old image even
  // after a fresh pull landed a new one (#450 — portal containers silently
  // stayed stale across an update).
  const upArgs = [...base, "up", "-d", "--force-recreate"];
  if (scope.kind === "service") {
    upArgs.push("--no-deps", scope.service);
  } else {
    upArgs.push("--remove-orphans");
  }

  const upResult = await docker.run(upArgs, { timeoutMs: composeUpTimeoutMs(), env: envOverrides });

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
          const r = await docker.run(configArgs, { timeoutMs: 15_000, env: envOverrides });
          return r.ok ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
        })();

  const started: string[] = [];
  const failed: { service: string; reason: string }[] = [];

  for (const svc of targetServices) {
    // Get the container name from compose ps
    const psArgs = [...base, "ps", "-q", svc];
    const psResult = await docker.run(psArgs, { timeoutMs: 10_000, env: envOverrides });
    const containerId = psResult.stdout.trim();
    if (!containerId) {
      failed.push({ service: svc, reason: `container for service ${svc} not found after up` });
      continue;
    }
    const wait = await waitForContainerHealthy(containerId, undefined, undefined, deps);
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
