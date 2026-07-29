/** Docker integration — executes docker compose commands via execFile (no shell). */
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { parseEnvFile } from "./env.js";
import { mapDockerError } from "./compose-errors.js";

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

/** Injectable command runner used by the focused Compose tests. */
export type DockerRunOptions = {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
};

export interface DockerClient {
  run(args: string[], opts?: DockerRunOptions): Promise<DockerResult>;
}

export interface StackDeps {
  docker: DockerClient;
  fileExists(path: string): boolean;
}

export const realDockerClient: DockerClient = {
  run: (args, opts) => run(args, opts?.cwd, opts?.timeoutMs, opts?.env),
};

export const defaultStackDeps: StackDeps = {
  docker: realDockerClient,
  fileExists: existsSync,
};

/**
 * Resolve the container-engine binary name/path to exec (F2). Defaults to
 * `"docker"`; set `OP_DOCKER_BIN` to point at a Docker-compatible engine
 * (e.g. a `podman` binary or shim) instead. Every exec site in this module
 * (and the sibling host-probe modules) routes through this instead of
 * hardcoding `"docker"`, so switching engines is a single env var — argv is
 * already array-based, so only the program name changes.
 */
export function dockerBin(): string {
  return process.env.OP_DOCKER_BIN?.trim() || "docker";
}

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
      dockerBin(),
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
  error?: string;
};

/**
 * Decide whether a running compose project (identified by its
 * `com.docker.compose.project.working_dir` label) is OURS — i.e. was launched
 * from this install's working dir. An empty/unknown label proves nothing, so it
 * must not authorize destructive project operations.
 *
 * Pure decision split out from detectExistingProject so the ours-vs-foreign
 * rule is unit-testable without a Docker daemon.
 */
export function isProjectOurs(workingDirLabel: string, expectedWorkingDir: string): boolean {
  const label = workingDirLabel.trim();
  return label !== "" && label === expectedWorkingDir;
}

/**
 * Probe the Docker daemon for a running compose project that shares
 * `projectName`. Decides ours-vs-foreign by comparing the project's
 * `com.docker.compose.project.working_dir` label against `expectedWorkingDir`
 * (the install's OP_HOME / compose context).
 *
 * Docker errors are returned separately from a confirmed absent project so
 * callers never mistake "could not check" for "safe to continue".
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
  if (!ps.ok) return { ...none, error: ps.stderr || "Could not query Docker projects" };
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
  if (!inspect.ok) {
    return {
      exists: true,
      isOurs: false,
      workingDir: "",
      error: inspect.stderr || "Could not inspect Docker project ownership",
    };
  }
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
  const mapped: DockerResult = { ok: available, stdout, stderr: result.stderr, code: result.code };
  if (result.errorCode !== undefined) mapped.errorCode = result.errorCode;
  return mapped;
}

/**
 * Minimum Docker Compose version that supports `--wait`/`--wait-timeout`
 * (added in Compose v2.14.0) — §2.1 makes these the single health gate for
 * every `compose up`, so an older CLI must fail the preflight instead of
 * silently rejecting the flag at runtime.
 */
const COMPOSE_WAIT_FLOOR = [2, 14, 0] as const;

/**
 * Decide whether a `docker compose version` output (e.g. "Docker Compose
 * version v2.29.1") is new enough for `--wait`/`--wait-timeout`. An
 * unparsable string is treated as new enough — fail open on a version-string
 * format change rather than blocking every install.
 */
export function meetsComposeWaitFloor(versionOutput: string): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  if (!match) return true;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < COMPOSE_WAIT_FLOOR.length; i++) {
    if (actual[i] > COMPOSE_WAIT_FLOOR[i]) return true;
    if (actual[i] < COMPOSE_WAIT_FLOOR[i]) return false;
  }
  return true;
}

/** Check if docker compose is available AND new enough for `--wait` (§2.1). */
export async function checkDockerCompose(): Promise<DockerResult> {
  // No timeout (0) — historically unbounded here.
  const result = await run(["compose", "version"], undefined, 0);
  if (!result.ok) return result;
  if (!meetsComposeWaitFloor(result.stdout)) {
    return {
      ...result,
      ok: false,
      stderr:
        result.stderr ||
        `Docker Compose ${result.stdout.trim() || "(unknown version)"} is too old — v2.14.0 or newer is required.`,
    };
  }
  return result;
}

/**
 * Build stderr text for a {@link mapDockerError} call from a failed
 * {@link DockerResult}. A genuine daemon/compose failure already has
 * descriptive stderr, but a spawn-level failure (the binary itself missing)
 * carries an `errorCode` errno with EMPTY stderr — synthesize a short line
 * that still carries the errno so `mapDockerError`'s not-installed branch
 * (which matches `\bENOENT\b`, among other patterns) recognizes it instead
 * of falling through to the "unknown error" fallback.
 */
function dockerFailureText(result: DockerResult): string {
  if (result.stderr) return result.stderr;
  if (result.errorCode) return `spawn ${dockerBin()} ${result.errorCode}`;
  return "";
}

/**
 * D1: a single "is Docker actually usable right now" readiness check, for
 * lifecycle callers (day-2 start/stop/restart/rollback/addon enable) that
 * currently only discover Docker is missing/stopped via a raw, sometimes
 * BLANK compose preflight error. Runs {@link checkDocker} then
 * {@link checkDockerCompose} and maps either failure through
 * {@link mapDockerError} for a friendly, non-blank message — including the
 * empty-stderr ENOENT case (missing binary) that raw compose stderr never
 * surfaces.
 */
export async function ensureDockerReady(): Promise<{ ok: true } | { ok: false; message: string }> {
  const docker = await checkDocker();
  if (!docker.ok) {
    return { ok: false, message: mapDockerError(dockerFailureText(docker)).message };
  }
  const compose = await checkDockerCompose();
  if (!compose.ok) {
    return { ok: false, message: mapDockerError(dockerFailureText(compose)).message };
  }
  return { ok: true };
}

/** Merge all env files into a single overrides object for process env. */
function collectComposeEnvOverrides(envFiles?: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const ef of envFiles ?? []) Object.assign(overrides, parseEnvFile(ef));
  return overrides;
}

/** Build common docker compose args: -f ... --project-name ... --env-file ... --profile ... */
export function buildComposeCommandArgs(
  options: { files: string[]; envFiles?: string[]; profiles?: string[]; projectName?: string },
  fileExists: (path: string) => boolean = existsSync,
): string[] {
  const envOverrides = collectComposeEnvOverrides(options.envFiles);
  const args = ["--project-name", options.projectName ?? resolveComposeProjectName(envOverrides), ...options.files.flatMap((f) => ["-f", f])];
  for (const ef of options.envFiles ?? []) {
    if (fileExists(ef)) args.push("--env-file", ef);
  }
  for (const p of options.profiles ?? []) args.push("--profile", p);
  return args;
}

/** Build common prefix: compose --progress plain -f ... --project-name ... --env-file ... --profile ... */
function buildComposeArgs(
  options: { files: string[]; envFiles?: string[]; profiles?: string[]; projectName?: string },
  fileExists: (path: string) => boolean = existsSync,
): string[] {
  // --progress plain on every non-interactive (captured, non-tty) invocation —
  // deterministic line-oriented output, no braille spinner frames to parse (§2.1).
  // The one EXCLUDED caller is runComposeStreaming (stdio-inherited, genuinely
  // interactive), which keeps compose's default renderer.
  return ["compose", "--progress", "plain", ...buildComposeCommandArgs(options, fileExists)];
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
 * A single volume entry from Docker's fully-resolved project view. Short-form
 * (`source:target:mode`) entries are normalized by Docker to this long form, so
 * `source` is already absolute and fully `${VAR}`-interpolated and `type`
 * distinguishes a host `bind` from a named `volume`. Consumers therefore never
 * hand-parse compose volume strings themselves.
 */
export interface ResolvedComposeVolume {
  type?: string;
  source?: string;
  target?: string;
  read_only?: boolean;
  bind?: { create_host_path?: boolean };
}

export interface ResolvedComposeSecret {
  file?: string;
  environment?: string;
}

/** Docker's resolved project view (subset consumed by the control plane). */
export interface ResolvedComposeProject {
  services?: Record<string, {
    user?: string;
    environment?: Record<string, string> | string[];
    env_file?: string | string[];
    secrets?: unknown;
    volumes?: ResolvedComposeVolume[];
  } | null>;
  secrets?: Record<string, ResolvedComposeSecret>;
}

export type ComposeConfigJsonResult = {
  ok: boolean;
  config: ResolvedComposeProject | null;
  stderr: string;
};

/**
 * Run `docker compose config --format json` and return Docker's fully-resolved
 * project view. This is the SINGLE SOURCE OF TRUTH for compose volume/env
 * resolution — callers that need a service's real bind-mount source paths use
 * this instead of re-implementing `${VAR}` interpolation or `split(':')`, both
 * of which are fragile (Windows drive paths, nested `${VAR:-${VAR}}` defaults).
 *
 * Synchronous (`execFileSync`, arg array — never a shell string) on purpose:
 * the sole consumer is the fully-synchronous bind-mount pre-creation path
 * (`ensureComposeVolumeTargets` → mkdirSync/chownSync) reached from synchronous
 * `setAddonEnabled` and the synchronous ownership-repair path resolver. Making
 * this async would force an async cascade through those and their many
 * synchronous UI/CLI callers for no benefit — this runs during a blocking
 * install/addon mutation where a short subprocess wait is already the norm.
 *
 * Best-effort: a compose or JSON-parse failure returns `{ ok:false, config:null }`.
 */
export function composeConfigJsonSync(
  options: { files: string[]; envFiles?: string[]; profiles?: string[] }
): ComposeConfigJsonResult {
  const args = buildComposeArgs(options);
  args.push("config", "--format", "json");
  try {
    const stdout = execFileSync(dockerBin(), args, {
      timeout: 30_000,
      encoding: "utf-8",
      env: { ...process.env, ...collectComposeEnvOverrides(options.envFiles) },
    });
    return { ok: true, config: JSON.parse(stdout) as ResolvedComposeProject, stderr: "" };
  } catch (error) {
    const stderr =
      (error as { stderr?: Buffer | string })?.stderr?.toString() ?? String(error);
    return { ok: false, config: null, stderr };
  }
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
 * {@link applyStack} — the two must not diverge.
 */
export function composeUpTimeoutMs(): number {
  const raw = process.env.OP_COMPOSE_UP_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 30 * 60_000;
}

/**
 * Seconds budget for compose's OWN `--wait-timeout` (§2.1's single health
 * gate) — how long compose itself waits for every targeted service to become
 * healthy before `up` exits non-zero. Default 5 minutes, matching the
 * health-poll deadline this replaces (the deleted deploy.ts pollContainerHealth
 * loop) and comfortably above the voice addon's 180s start_period. Override
 * with OP_COMPOSE_WAIT_TIMEOUT_MS (ms).
 */
export function composeWaitTimeoutSec(): number {
  const raw = process.env.OP_COMPOSE_WAIT_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60_000;
  return Math.ceil(ms / 1000);
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
    const child = spawn(dockerBin(), ["compose", ...args], { stdio: "inherit" });
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
 * Run `docker compose down` against an EXPLICIT project name instead of the
 * one resolved from env files. Exists for the project-rename flow (#540):
 * once OP_PROJECT_NAME changes in stack.env, every normal compose call
 * resolves the NEW name, so the outgoing project's containers can never be
 * addressed again and would keep running forever. The rename teardown is the
 * only caller that may target a project other than the current one — callers
 * MUST verify ownership (working_dir label) before invoking this.
 *
 * No preflight: the compose config is validated by the surrounding apply
 * flow, and this teardown must stay best-effort — a preflight hiccup must not
 * strand the old project.
 */
export async function composeDownProject(
  projectName: string,
  options: {
    files: string[];
    profiles?: string[];
    envFiles?: string[];
    removeOrphans?: boolean;
  }
): Promise<DockerResult> {
  if (options.files.length === 0 || !existsSync(options.files[0])) {
    return { ok: false, stdout: "", stderr: "Compose file not found", code: 1 };
  }
  const args = buildComposeArgs({ ...options, projectName });
  args.push("down");
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

/** One row of `compose ps --format json` output, reduced to what callers need. */
export type ComposePsRow = { service: string; state: string; health: string };

/**
 * Parse `compose ps --format json` stdout (one JSON object per line, or a
 * JSON array on some Compose versions) into {@link ComposePsRow}s. Matches
 * by the `Service` field — NEVER derive the service name from the container
 * name (which carries a `-<n>` suffix, e.g. `assistant-1`).
 *
 * Single source of truth for this parse — used by {@link applyStack}'s
 * post-failure diagnosis and by the deploy-journal's display refresh.
 */
export function parseComposePsRows(stdout: string): ComposePsRow[] {
  const rows: ComposePsRow[] = [];
  const trimmedStdout = stdout.trim();
  if (!trimmedStdout) return rows;
  for (const line of trimmedStdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const obj = entry as Record<string, unknown>;
        const service = String(obj.Service ?? obj.Name ?? "");
        if (!service) continue;
        rows.push({ service, state: String(obj.State ?? ""), health: String(obj.Health ?? "") });
      }
    } catch {
      // Ignore unparsable lines.
    }
  }
  return rows;
}

export function isComposePsRowHealthy(row: ComposePsRow | undefined): boolean {
  if (row?.state.toLowerCase() !== 'running') return false;
  const health = row.health.toLowerCase();
  return health === '' || health === 'healthy';
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


// ── applyStack — the single compose driver (§4.3) ───────────────────────────

export type ApplyStackScope =
  | { kind: "service"; service: string }
  | { kind: "services"; services: string[] }
  | { kind: "all" };

export type ApplyStackResult = {
  ok: boolean;
  /** Services that were successfully brought up. */
  started: string[];
  /** Per-service failures. */
  failed: { service: string; reason: string }[];
  /** Top-level error string (when compose itself fails). */
  error?: string;
  /**
   * True only when the `up` invocation itself failed (no service in scope
   * ever started) — the early-return branch below. Undefined/false means
   * `up` succeeded but at least one service failed its post-up health wait.
   * Lets callers with their own domain-specific stderr translation (e.g. the
   * voice addon's operator-facing hints) distinguish the two failure classes
   * without string-sniffing `error`.
   */
  upFailed?: boolean;
  /**
   * Raw compose stderr from the `up` invocation, present only when
   * `upFailed` is true. `error` is already {@link mapDockerError}-translated
   * for the generic admin UI; this is for callers that need to run their own
   * translation over the untouched stderr.
   */
  rawStderr?: string;
  /** Explicit pull failed before Compose was allowed to mutate containers. */
  pullFailed?: boolean;
};

/**
 * Options for the single {@link applyStack} driver. Both fields are optional;
 * omitting the param is byte-identical to the default apply.
 *
 * - `pull: "missing"` uses Compose's simple inline `up --pull missing` path,
 *   which supports installs and local development without forcing a registry
 *   lookup for an image already present. `pull: "always"` first runs an explicit
 *   `compose pull` for the requested scope and only then runs `up --pull never`.
 * - `healthTimeoutMs` widens compose's own `--wait-timeout` beyond the default
 *   for a caller (e.g. the voice addon's slow cold boot) that tolerates a longer
 *   start.
 */
export type ApplyStackOptions = {
  pull?: "always" | "missing";
  healthTimeoutMs?: number;
};

/**
 * The SINGLE Docker Compose driver for install/update/upgrade/pull (§4.3, plan 2.2).
 *
 * The default `--pull missing` path remains one `up` call. `pull: "always"`
 * deliberately uses two ordered calls: `pull` must succeed for the complete
 * requested scope before `up --pull never` may mutate containers. This prevents
 * a multi-service update from starting against a partially refreshed image set.
 * `--force-recreate` is REQUIRED on every scope so a
 * container whose managed compose config is unchanged still restarts onto a
 * freshly pulled same-tag image (#450). Active profiles are always passed
 * (§4.3). Success = running AND healthy — `up -d --wait` IS the single health
 * gate (§2.1): compose blocks until every targeted service reaches
 * running+healthy or `--wait-timeout` elapses, so there is no separate
 * per-container poll loop; on failure ONE `compose ps --format json` call names
 * which services didn't come up.
 *
 * scope = { kind:"service", service:"assistant" }    →  pull/up the service
 * scope = { kind:"services", services:["a","b"] }     →  pull/up both services
 * scope = { kind:"all" }                              →  pull/up the active project
 *
 * `services` (plural) is the multi-service sibling of `service` — a named,
 * pre-resolved subset (e.g. every service in one addon profile) recreated
 * together with no `--remove-orphans`, exactly like the singular form. It
 * exists so a caller that owns a named group of services (e.g. the voice
 * addon's bring-up flow, or the manual pull button) can route through this
 * single driver instead of reimplementing its own up + health-wait.
 *
 * Callers pass the resolved ComposeOptions so this function never builds them
 * itself — profiles are already resolved.
 */
export async function applyStack(
  scope: ApplyStackScope,
  options: { files: string[]; envFiles?: string[]; profiles?: string[] },
  deps: StackDeps = defaultStackDeps,
  applyOpts: ApplyStackOptions = {},
): Promise<ApplyStackResult> {
  if (scope.kind === "services" && scope.services.length === 0) {
    return { ok: true, started: [], failed: [] };
  }
  const { docker, fileExists } = deps;
  const envOverrides = collectComposeEnvOverrides(options.envFiles);
  const base = buildComposeArgs(options, fileExists);
  const pullMode = applyOpts.pull ?? "missing";
  const waitTimeoutSec = applyOpts.healthTimeoutMs
    ? Math.max(1, Math.ceil(applyOpts.healthTimeoutMs / 1000))
    : composeWaitTimeoutSec();

  const scopedServices = scope.kind === "service" ? [scope.service] : scope.kind === "services" ? scope.services : [];

  if (pullMode === "always") {
    const pullArgs = [...base, "pull", ...scopedServices];
    const pullResult = await docker.run(pullArgs, {
      timeoutMs: PULL_TIMEOUT_MS,
      env: envOverrides,
    });
    if (!pullResult.ok) {
      const mapped = mapDockerError(pullResult.stderr || `docker compose pull exited with code ${pullResult.code}`);
      return {
        ok: false,
        started: [],
        failed: scopedServices.map((service) => ({ service, reason: mapped.message })),
        error: mapped.message,
        pullFailed: true,
      };
    }
  }

  // `always` was completed transactionally above; never perform a second,
  // implicit pull while containers are being recreated.
  const upPullMode = pullMode === "always" ? "never" : "missing";
  const upArgs = [...base, "up", "-d", "--pull", upPullMode, "--wait", "--wait-timeout", String(waitTimeoutSec), "--force-recreate"];
  if (scope.kind === "service") {
    upArgs.push("--no-deps", scope.service);
  } else if (scope.kind === "services") {
    upArgs.push("--no-deps", ...scope.services);
  } else {
    upArgs.push("--remove-orphans");
  }

  const upTimeout = pullMode === "always" ? composeUpTimeoutMs() : PULL_TIMEOUT_MS + composeUpTimeoutMs();
  const upResult = await docker.run(upArgs, { timeoutMs: upTimeout, env: envOverrides });

  const targetServices =
    scope.kind === "service"
      ? [scope.service]
      : scope.kind === "services"
        ? scope.services
        : await (async () => {
            const configArgs = [...base, "config", "--services"];
            const r = await docker.run(configArgs, { timeoutMs: 15_000, env: envOverrides });
            return r.ok ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
          })();

  // ── 2. On failure, ONE `compose ps --format json` call names the failed
  //      services (§2.1) — no per-container inspect polling. `upFailed` +
  //      `rawStderr` let a caller with its own stderr translation (the voice
  //      addon) distinguish "up never came up" from "some service unhealthy".
  if (!upResult.ok) {
    const psArgs = [...base, "ps", "--format", "json"];
    const psResult = await docker.run(psArgs, { timeoutMs: 15_000, env: envOverrides });
    const rows = psResult.ok ? parseComposePsRows(psResult.stdout) : [];
    if (rows.length === 0) {
      // ps itself gave us nothing to work with — map the full stderr (§6).
      const mapped = mapDockerError(upResult.stderr || `docker compose exited with code ${upResult.code}`);
      return {
        ok: false,
        started: [],
        failed: targetServices.map((service) => ({ service, reason: mapped.message })),
        error: mapped.message,
        upFailed: true,
        rawStderr: upResult.stderr,
      };
    }
    const started: string[] = [];
    const failed: { service: string; reason: string }[] = [];
    for (const svc of targetServices) {
      const row = rows.find((r) => r.service === svc);
      if (isComposePsRowHealthy(row)) {
        started.push(svc);
        continue;
      }
      const rawReason = !row
        ? `container for service ${svc} not found after up`
        : row.health === "unhealthy"
          ? `container ${svc} is unhealthy`
          : `container ${svc} did not become healthy (state: ${row.state || "unknown"})`;
      failed.push({ service: svc, reason: mapDockerError(rawReason).message });
    }
    return {
      ok: false,
      started,
      failed,
      error: failed.map((f) => f.reason).join("; ") || mapDockerError(upResult.stderr).message,
      upFailed: started.length === 0,
      rawStderr: upResult.stderr,
    };
  }

  // ── 3. Success — `--wait` already confirmed every target service is healthy ──
  return { ok: true, started: targetServices, failed: [] };
}
