/**
 * Lifecycle helpers for the OpenPalm control plane.
 *
 * State factory, apply* lifecycle transitions, compose file list builders,
 * and caller/action validation.
 *
 * All asset operations are delegated via CoreAssetProvider (injected).
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
import { stageArtifacts, persistArtifacts, discoverStagedChannelYmls, randomHex, isOllamaEnabled, isAdminEnabled } from "./staging.js";
import { refreshCoreAssets, ensureMemoryDir, ensureCoreAutomations } from "./core-assets.js";
import { ensureMemoryConfig } from "./memory-config.js";
import { isSetupComplete } from "./setup-status.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";

const execFileAsync = promisify(execFile);

/** Resolve the varlock binary path — honours VARLOCK_BIN for dev environments. */
const envVarlockBin = process.env.VARLOCK_BIN;
let VARLOCK_BIN = "varlock";
if (envVarlockBin) {
  if (envVarlockBin === "varlock" || envVarlockBin.startsWith("/")) {
    VARLOCK_BIN = envVarlockBin;
  } else {
    console.warn(
      `Unsafe VARLOCK_BIN value: ${envVarlockBin}. Falling back to "varlock". ` +
      "Must be \"varlock\" or an absolute path.",
    );
  }
}

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
    adminToken ?? fileEnv.OPENPALM_ADMIN_TOKEN ?? fileEnv.ADMIN_TOKEN ?? process.env.OPENPALM_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "";

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

  writeSetupTokenFile(state);

  return state;
}

/**
 * Write or remove the setup-token.txt file based on setup completion state.
 */
export function writeSetupTokenFile(state: ControlPlaneState): void {
  const tokenPath = `${state.stateDir}/setup-token.txt`;
  const setupComplete = isSetupComplete(state.stateDir, state.configDir);

  if (setupComplete) {
    try { unlinkSync(tokenPath); } catch { /* already gone */ }
  } else {
    mkdirSync(state.stateDir, { recursive: true });
    writeFileSync(tokenPath, state.setupToken + "\n", { mode: 0o600 });
  }
}

// ── Private Loaders ───────────────────────────────────────────────────

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
  assets: CoreAssetProvider,
  opts: { activateServices?: boolean; deactivateServices?: boolean; seedMemoryConfig?: boolean },
): string[] {
  if (opts.activateServices) {
    for (const s of CORE_SERVICES) state.services[s] = "running";
  }
  ensureMemoryDir();
  ensureCoreAutomations(assets);
  if (opts.seedMemoryConfig) ensureMemoryConfig(state.dataDir);

  const active: string[] = [];
  for (const [name, status] of Object.entries(state.services)) {
    if (status === "running") active.push(name);
  }

  if (opts.deactivateServices) {
    for (const name of Object.keys(state.services)) state.services[name] = "stopped";
  }

  state.artifacts = stageArtifacts(state, assets);
  persistArtifacts(state, assets);
  return active;
}

export function applyInstall(state: ControlPlaneState, assets: CoreAssetProvider): void {
  reconcileCore(state, assets, { activateServices: true, seedMemoryConfig: true });
}

export function applyUpdate(state: ControlPlaneState, assets: CoreAssetProvider): { restarted: string[] } {
  return { restarted: reconcileCore(state, assets, {}) };
}

export function applyUninstall(state: ControlPlaneState, assets: CoreAssetProvider): { stopped: string[] } {
  return { stopped: reconcileCore(state, assets, { deactivateServices: true }) };
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

export async function applyUpgrade(
  state: ControlPlaneState,
  assets: CoreAssetProvider
): Promise<{
  backupDir: string | null;
  updated: string[];
  restarted: string[];
}> {
  const { backupDir, updated } = await refreshCoreAssets();
  const restarted = reconcileCore(state, assets, {});
  return { backupDir, updated, restarted };
}

// ── Compose File List Builder ────────────────────────────────────────────

export function buildComposeFileList(state: ControlPlaneState): string[] {
  const files = [`${state.stateDir}/artifacts/docker-compose.yml`];

  if (isAdminEnabled(state)) {
    const adminYml = `${state.stateDir}/artifacts/admin.yml`;
    files.push(adminYml);
  }

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
 * Core services always; admin/caddy/docker-socket-proxy only when admin is enabled.
 */
export function buildManagedServices(state: ControlPlaneState): string[] {
  const services: string[] = [...CORE_SERVICES];

  if (isAdminEnabled(state)) {
    services.push("caddy", "admin", "docker-socket-proxy");
  }

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

export async function validateEnvironment(state: ControlPlaneState): Promise<{
  ok: boolean;
  errors: string[];
  warnings: string[];
}> {
  const schemaPath = `${state.dataDir}/secrets.env.schema`;
  const envPath = `${state.configDir}/secrets.env`;

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

  try {
    await runVarlockLoad(schemaPath, envPath);
  } catch (err: unknown) {
    anyFailed = true;
    if (err && typeof err === "object" && "stderr" in err) {
      collectVarlockOutput(String((err as { stderr: string }).stderr), errors, warnings);
    }
  }

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
