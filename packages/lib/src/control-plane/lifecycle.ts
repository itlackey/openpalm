/**
 * Lifecycle helpers for the OpenPalm control plane.
 *
 * State factory, apply* lifecycle transitions, compose file list builders,
 * and caller/action validation.
 *
 * All asset operations are delegated via CoreAssetProvider (injected).
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { parseEnvFile, mergeEnvContent } from "./env.js";
import type { ControlPlaneState, CallerType } from "./types.js";
import { CORE_SERVICES } from "./types.js";
import {
  resolveOpenPalmHome,
  resolveConfigDir,
  resolveVaultDir,
  resolveDataDir,
  resolveLogsDir,
  resolveCacheHome,
} from "./home.js";
import { ensureSecrets, loadSecretsEnvFile, readSystemSecretsEnvFile, updateSystemSecretsEnv } from "./secrets.js";
import {
  resolveArtifacts,
  persistConfiguration,
  discoverComponentOverlays,
  discoverChannelOverlays,
  randomHex,
  isOllamaEnabled,
  isAdminEnabled,
  buildEnvFiles,
} from "./staging.js";
import { refreshCoreAssets, ensureMemoryDir, ensureCoreAutomations } from "./core-assets.js";
import { ensureMemoryConfig } from "./memory-config.js";
import { isSetupComplete } from "./setup-status.js";
import { snapshotCurrentState } from "./rollback.js";
import { validateProposedState } from "./validate.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";

const IMAGE_NAMESPACE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SEMVER_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// ── State Factory ──────────────────────────────────────────────────────

export function createState(
  adminToken?: string
): ControlPlaneState {
  const homeDir = resolveOpenPalmHome();
  const configDir = resolveConfigDir();
  const vaultDir = resolveVaultDir();
  const dataDir = resolveDataDir();
  const logsDir = resolveLogsDir();
  const cacheDir = resolveCacheHome();

  const services: Record<string, "running" | "stopped"> = {};
  for (const name of CORE_SERVICES) {
    services[name] = "stopped";
  }

  const setupToken = randomHex(16);
  const bootstrapState: ControlPlaneState = {
    adminToken: adminToken ?? process.env.OPENPALM_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "",
    assistantToken: "",
    setupToken,
    homeDir,
    configDir,
    vaultDir,
    dataDir,
    logsDir,
    cacheDir,
    services,
    artifacts: { compose: "", caddyfile: "" },
    artifactMeta: [],
    audit: [],
    channelSecrets: {},
  };

  ensureSecrets(bootstrapState);

  const fileEnv = loadSecretsEnvFile(vaultDir);
  const systemEnv = readSystemSecretsEnvFile(vaultDir);
  // Precedence: explicit parameter > system.env > user.env > process.env.
  bootstrapState.adminToken =
    adminToken
      ?? systemEnv.OPENPALM_ADMIN_TOKEN
      ?? systemEnv.ADMIN_TOKEN
      ?? fileEnv.OPENPALM_ADMIN_TOKEN
      ?? fileEnv.ADMIN_TOKEN
      ?? process.env.OPENPALM_ADMIN_TOKEN
      ?? process.env.ADMIN_TOKEN
      ?? "";
  bootstrapState.assistantToken =
    systemEnv.ASSISTANT_TOKEN
      ?? process.env.ASSISTANT_TOKEN
      ?? "";

  // Backfill: if admin token was resolved from user.env (legacy) but not in
  // system.env, migrate it so system-managed credentials don't live in the
  // user-editable file indefinitely.
  if (
    bootstrapState.adminToken &&
    !systemEnv.OPENPALM_ADMIN_TOKEN &&
    (fileEnv.OPENPALM_ADMIN_TOKEN || fileEnv.ADMIN_TOKEN)
  ) {
    updateSystemSecretsEnv(bootstrapState, { OPENPALM_ADMIN_TOKEN: bootstrapState.adminToken });
  }

  bootstrapState.channelSecrets = {
    ...loadPersistedChannelSecrets(vaultDir),
  };

  writeSetupTokenFile(bootstrapState);

  return bootstrapState;
}

/**
 * Write or remove the setup-token.txt file based on setup completion state.
 */
export function writeSetupTokenFile(state: ControlPlaneState): void {
  const tokenPath = `${state.dataDir}/setup-token.txt`;
  const setupComplete = isSetupComplete(state.vaultDir);

  if (setupComplete) {
    try { unlinkSync(tokenPath); } catch { /* already gone */ }
  } else {
    mkdirSync(state.dataDir, { recursive: true });
    writeFileSync(tokenPath, state.setupToken + "\n", { mode: 0o600 });
  }
}

// ── Private Loaders ───────────────────────────────────────────────────

/**
 * Load persisted channel HMAC secrets from vault/system.env.
 */
function loadPersistedChannelSecrets(vaultDir: string): Record<string, string> {
  const parsed = parseEnvFile(`${vaultDir}/system.env`);
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

  // Snapshot before writing (for rollback on failure)
  snapshotCurrentState(state);

  // Resolve and persist configuration directly to live paths
  state.artifacts = resolveArtifacts(state, assets);
  persistConfiguration(state, assets);
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
  const systemEnvPath = `${state.vaultDir}/system.env`;
  const parsed = parseEnvFile(systemEnvPath);
  const namespace = (parsed.OPENPALM_IMAGE_NAMESPACE ?? process.env.OPENPALM_IMAGE_NAMESPACE ?? "openpalm").trim().toLowerCase();

  if (!IMAGE_NAMESPACE_RE.test(namespace)) {
    throw new Error(`Invalid image namespace in system.env: ${namespace}`);
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

  const currentContent = existsSync(systemEnvPath) ? readFileSync(systemEnvPath, "utf-8") : "";
  const updatedContent = mergeEnvContent(currentContent, { OPENPALM_IMAGE_TAG: latestTag }, { uncomment: true });
  writeFileSync(systemEnvPath, updatedContent);

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

/**
 * Build the compose file list from config/components/.
 */
export function buildComposeFileList(state: ControlPlaneState): string[] {
  const coreYml = `${state.configDir}/components/core.yml`;
  const files: string[] = [];

  if (existsSync(coreYml)) {
    files.push(coreYml);
  }

  if (isAdminEnabled(state)) {
    const adminYml = `${state.configDir}/components/admin.yml`;
    if (existsSync(adminYml)) files.push(adminYml);
  }

  if (isOllamaEnabled(state)) {
    const ollamaYml = `${state.configDir}/components/ollama.yml`;
    if (existsSync(ollamaYml)) files.push(ollamaYml);
  }

  // Add channel overlays
  const channelYmls = discoverChannelOverlays(state.configDir);
  files.push(...channelYmls);

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

  const channelYmls = discoverChannelOverlays(state.configDir);
  for (const p of channelYmls) {
    const filename = p.split("/").pop() ?? "";
    const name = filename.replace(/\.yml$/, "");
    if (name) services.push(name);
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
  return validateProposedState(state);
}
