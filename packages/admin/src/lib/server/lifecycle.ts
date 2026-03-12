/**
 * Lifecycle helpers for the OpenPalm control plane.
 *
 * State factory, apply* lifecycle transitions, compose file list builders,
 * and caller/action validation.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseEnvFile, mergeEnvContent } from "./env.js";
import type { ControlPlaneState, CallerType } from "./types.js";
import { CORE_SERVICES } from "./types.js";
import { resolveConfigHome, resolveStateHome, resolveDataHome } from "./paths.js";
import { loadSecretsEnvFile } from "./secrets.js";
import { stageArtifacts, persistArtifacts, discoverStagedChannelYmls, randomHex, isOllamaEnabled } from "./staging.js";
import { refreshCoreAssets, ensureMemoryDir, ensureCoreAutomations } from "./core-assets.js";
import { ensureMemoryConfig } from "./memory-config.js";
import { isSetupComplete } from "./setup-status.js";

const execFileAsync = promisify(execFile);

/** Resolve the varlock binary path — honours VARLOCK_BIN for dev environments. */
const VARLOCK_BIN = process.env.VARLOCK_BIN || "varlock";

const IMAGE_NAMESPACE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SEMVER_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// ── State Factory ──────────────────────────────────────────────────────

export function createState(
  adminToken?: string
): ControlPlaneState {
  const stateDir = resolveStateHome();
  const configDir = resolveConfigHome();
  const fileEnv = loadSecretsEnvFile(configDir);
  const resolvedAdminToken =
    adminToken ?? fileEnv.ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "";

  // Initialize core services as stopped
  const services: Record<string, "running" | "stopped"> = {};
  for (const name of CORE_SERVICES) {
    services[name] = "stopped";
  }

  const dataDir = resolveDataHome();

  const persistedSecrets = loadPersistedChannelSecrets(dataDir);
  const channelSecrets: Record<string, string> = { ...persistedSecrets };

  const setupToken = randomHex(16);
  const state: ControlPlaneState = {
    adminToken: resolvedAdminToken,
    setupToken,
    stateDir,
    configDir,
    dataDir,
    services,
    artifacts: { compose: "", caddyfile: "" },
    artifactMeta: [],
    audit: [],
    channelSecrets
  };

  // Write setup token to disk so the setup script can display it.
  // Delete it if setup is already complete.
  writeSetupTokenFile(state);

  return state;
}

/**
 * Write or remove the setup-token.txt file based on setup completion state.
 * The file is written to STATE_HOME/setup-token.txt so the host-side
 * setup script can read and display it to the user.
 */
export function writeSetupTokenFile(state: ControlPlaneState): void {
  const tokenPath = `${state.stateDir}/setup-token.txt`;
  const setupComplete = isSetupComplete(state.stateDir, state.configDir);

  if (setupComplete) {
    // Clean up — don't leave the token on disk after setup is done
    try { unlinkSync(tokenPath); } catch { /* already gone */ }
  } else {
    mkdirSync(state.stateDir, { recursive: true });
    writeFileSync(tokenPath, state.setupToken + "\n", { mode: 0o600 });
  }
}

// ── Private Loaders ───────────────────────────────────────────────────

/**
 * Load persisted channel secrets from DATA_HOME/stack.env.
 * Returns a map of channel name → secret. Returns empty object if the file doesn't exist.
 */
function loadPersistedChannelSecrets(dataDir: string): Record<string, string> {
  const parsed = parseEnvFile(`${dataDir}/stack.env`);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const match = key.match(/^CHANNEL_([A-Z0-9_]+)_SECRET$/);
    if (match?.[1] && value) result[match[1].toLowerCase()] = value;
  }
  return result;
}

// ── Lifecycle Helpers ──────────────────────────────────────────────────

function reconcileCore(
  state: ControlPlaneState,
  opts: { activateServices?: boolean; deactivateServices?: boolean; seedMemoryConfig?: boolean },
): string[] {
  if (opts.activateServices) {
    for (const s of CORE_SERVICES) state.services[s] = "running";
  }
  ensureMemoryDir();
  ensureCoreAutomations();
  if (opts.seedMemoryConfig) ensureMemoryConfig(state.dataDir);

  const active: string[] = [];
  for (const [name, status] of Object.entries(state.services)) {
    if (status === "running") active.push(name);
  }

  if (opts.deactivateServices) {
    for (const name of Object.keys(state.services)) state.services[name] = "stopped";
  }

  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);
  return active;
}

export function applyInstall(state: ControlPlaneState): void {
  reconcileCore(state, { activateServices: true, seedMemoryConfig: true });
}

export function applyUpdate(state: ControlPlaneState): { restarted: string[] } {
  return { restarted: reconcileCore(state, {}) };
}

export function applyUninstall(state: ControlPlaneState): { stopped: string[] } {
  return { stopped: reconcileCore(state, { deactivateServices: true }) };
}

type DockerTagEntry = { name?: unknown };
type DockerTagsResponse = { results?: unknown };

function resolveNewestDockerTag(payload: unknown): string | null {
  const results = (payload as DockerTagsResponse)?.results;
  if (!Array.isArray(results)) return null;

  let fallback: string | null = null;
  for (const entry of results as DockerTagEntry[]) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!name || name === "latest") continue;
    if (SEMVER_TAG_RE.test(name)) return name;
    if (!fallback) fallback = name;
  }
  return fallback;
}

export async function updateStackEnvToLatestImageTag(state: ControlPlaneState): Promise<{
  namespace: string;
  tag: string;
}> {
  const stackEnvPath = `${state.dataDir}/stack.env`;
  const parsed = parseEnvFile(stackEnvPath);
  const namespace = (parsed.OPENPALM_IMAGE_NAMESPACE ?? process.env.OPENPALM_IMAGE_NAMESPACE ?? "openpalm").trim().toLowerCase();

  if (!IMAGE_NAMESPACE_RE.test(namespace)) {
    throw new Error(`Invalid image namespace in stack.env: ${namespace}`);
  }

  let response: Response;
  try {
    response = await fetch(
      `https://registry.hub.docker.com/v2/repositories/${namespace}/admin/tags?page_size=25&ordering=last_updated`,
      { headers: { Accept: "application/json" } }
    );
  } catch (e) {
    throw new Error(`Failed to query Docker tags: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!response.ok) {
    throw new Error(`Docker tag lookup failed (${response.status})`);
  }

  const payload = await response.json();
  const latestTag = resolveNewestDockerTag(payload);
  if (!latestTag) {
    throw new Error("No usable Docker image tag found");
  }

  const currentContent = existsSync(stackEnvPath) ? readFileSync(stackEnvPath, "utf-8") : "";
  const updatedContent = mergeEnvContent(currentContent, { OPENPALM_IMAGE_TAG: latestTag }, { uncomment: true });
  writeFileSync(stackEnvPath, updatedContent);

  return { namespace, tag: latestTag };
}

export async function applyUpgrade(state: ControlPlaneState): Promise<{
  backupDir: string | null;
  updated: string[];
  restarted: string[];
}> {
  const { backupDir, updated } = await refreshCoreAssets();
  const restarted = reconcileCore(state, {});
  return { backupDir, updated, restarted };
}

// ── Compose File List Builder ────────────────────────────────────────────

/**
 * Build the full list of compose files: core compose + Ollama overlay (if enabled) + channel overlays.
 * Uses staged .yml files from STATE_HOME/artifacts/channels/ — never reads from CONFIG_HOME at runtime.
 */
export function buildComposeFileList(state: ControlPlaneState): string[] {
  const files = [`${state.stateDir}/artifacts/docker-compose.yml`];

  // Include Ollama overlay when enabled
  if (isOllamaEnabled(state)) {
    const ollamaYml = `${state.stateDir}/artifacts/ollama.yml`;
    files.push(ollamaYml);
  }

  const stagedYmls = discoverStagedChannelYmls(state.stateDir);
  files.push(...stagedYmls);

  return files;
}

/**
 * Build the list of services that `docker compose up` should manage.
 *
 * Excludes **admin** — the admin cannot recreate its own container inline
 * because doing so would kill the process mid-request. Instead, the upgrade
 * endpoint schedules a deferred `selfRecreateAdmin()` call (in docker.ts)
 * after the HTTP response is sent, which spawns a detached process to
 * recreate the admin container with the new image.
 *
 * Note: **docker-socket-proxy** is not in CORE_SERVICES by design, so it
 * is never included here. Both admin and docker-socket-proxy are started
 * by the host-side bootstrap (setup.sh) and must remain running throughout
 * admin-initiated compose operations.
 */
export function buildManagedServices(state: ControlPlaneState): string[] {
  const services: string[] = CORE_SERVICES.filter((s) => s !== "admin");

  // Include Ollama when enabled
  if (isOllamaEnabled(state)) {
    services.push("ollama");
  }

  const stagedYmls = discoverStagedChannelYmls(state.stateDir);
  for (const p of stagedYmls) {
    const filename = p.split("/").pop() ?? "";
    const name = filename.replace(/\.yml$/, "");
    if (name) services.push(`channel-${name}`);
  }
  return services;
}

// ── Caller Normalization ───────────────────────────────────────────────

const VALID_CALLERS = new Set<CallerType>([
  "assistant",
  "cli",
  "ui",
  "system",
  "test"
]);

export function normalizeCaller(headerValue: string | null): CallerType {
  const v = (headerValue ?? "").trim().toLowerCase() as CallerType;
  return VALID_CALLERS.has(v) ? v : "unknown";
}

// ── Action Validation ──────────────────────────────────────────────────

const ALLOWED_ACTIONS = new Set([
  "install",
  "update",
  "upgrade",
  "uninstall",
  "containers.list",
  "containers.up",
  "containers.down",
  "containers.restart",
  "channels.list",
  "channels.install",
  "channels.uninstall",

  "extensions.list",
  "artifacts.list",
  "artifacts.get",
  "artifacts.manifest",
  "audit.list",
  "accessScope.get",
  "accessScope.set",
  "connections.get",
  "connections.patch",
  "connections.status"
]);

export function isAllowedAction(action: string): boolean {
  return ALLOWED_ACTIONS.has(action);
}

// ── Environment Validation ─────────────────────────────────────────────

/**
 * Validate the environment configuration using varlock.
 * Runs `varlock load --path <tmpdir>/` with the schema and env file
 * co-located in a temp directory (varlock discovers .env.schema files
 * from the --path directory).
 * Returns { ok, errors, warnings }.
 * Never throws — returns { ok: false } on any error.
 */
export async function validateEnvironment(state: ControlPlaneState): Promise<{
  ok: boolean;
  errors: string[];
  warnings: string[];
}> {
  const schemaPath = `${state.dataDir}/secrets.env.schema`;
  const envPath = `${state.configDir}/secrets.env`;

  // Redact potential secret values from varlock diagnostic output before logging/returning.
  function sanitizeVarlockMessage(msg: string): string {
    return msg
      .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]")
      .replace(/gsk_[A-Za-z0-9]{30,}/g, "[REDACTED]")
      .replace(/AIza[A-Za-z0-9_\-]{35}/g, "[REDACTED]")
      .replace(/[0-9a-f]{32,}/gi, "[REDACTED]")
      .replace(/value '([^']*)'/g, "value '[REDACTED]'");
  }

  function collectVarlockOutput(stderr: string, errors: string[], warnings: string[]): void {
    for (const line of stderr.split("\n")) {
      const trimmed = sanitizeVarlockMessage(line.trim());
      if (!trimmed) continue;
      if (trimmed.includes("ERROR")) errors.push(trimmed);
      else if (trimmed.includes("WARN")) warnings.push(trimmed);
    }
  }

  /**
   * Run varlock load with a schema and env file that may be in different
   * directories. Varlock discovers .env.schema alongside the --path target,
   * so we create a temp directory with both files co-located.
   */
  async function runVarlockLoad(
    schemaFile: string,
    envFile: string,
  ): Promise<void> {
    const tmpDir = mkdtempSync(join(tmpdir(), "varlock-"));
    try {
      copyFileSync(schemaFile, join(tmpDir, ".env.schema"));
      copyFileSync(envFile, join(tmpDir, ".env"));
      await execFileAsync(
        VARLOCK_BIN,
        ["load", "--path", `${tmpDir}/`],
        { timeout: 10000 }
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  let anyFailed = false;

  // Validate secrets.env against DATA_HOME/secrets.env.schema
  try {
    await runVarlockLoad(schemaPath, envPath);
  } catch (err: unknown) {
    anyFailed = true;
    if (err && typeof err === "object" && "stderr" in err) {
      collectVarlockOutput(String((err as { stderr: string }).stderr), errors, warnings);
    }
  }

  // Validate stack.env against DATA_HOME/stack.env.schema.
  // NOTE: CHANNEL_*_SECRET dynamic keys will only partially validate (varlock cannot
  // validate wildcard patterns); the server-side entropy guarantee from persistArtifacts()
  // is the primary mitigation for those keys.
  const stackSchemaPath = `${state.dataDir}/stack.env.schema`;
  const stackEnvPath = `${state.stateDir}/artifacts/stack.env`;
  try {
    await runVarlockLoad(stackSchemaPath, stackEnvPath);
  } catch (err: unknown) {
    anyFailed = true;
    if (err && typeof err === "object" && "stderr" in err) {
      collectVarlockOutput(String((err as { stderr: string }).stderr), errors, warnings);
    }
  }

  return { ok: !anyFailed && errors.length === 0, errors, warnings };
}
