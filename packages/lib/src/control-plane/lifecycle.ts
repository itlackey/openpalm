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
  randomHex,
  buildEnvFiles,
} from "./staging.js";
import { readStackSpec } from "./stack-spec.js";
import { refreshCoreAssets, ensureMemoryDir, ensureCoreAutomations } from "./core-assets.js";
import { ensureMemoryConfig } from "./memory-config.js";
import { isSetupComplete } from "./setup-status.js";
import { snapshotCurrentState } from "./rollback.js";
import { validateProposedState } from "./validate.js";
import { checkDocker, composePreflight, resolveComposeProjectName } from "./docker.js";
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
    adminToken: adminToken ?? process.env.OP_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "",
    assistantToken: "",
    setupToken,
    homeDir,
    configDir,
    vaultDir,
    dataDir,
    logsDir,
    cacheDir,
    services,
    artifacts: { compose: "" },
    artifactMeta: [],
    audit: [],
  };

  ensureSecrets(bootstrapState);

  const fileEnv = loadSecretsEnvFile(vaultDir);
  const systemEnv = readSystemSecretsEnvFile(vaultDir);
  // Precedence: explicit parameter > system.env > user.env > process.env.
  bootstrapState.adminToken =
    adminToken
      ?? systemEnv.OP_ADMIN_TOKEN
      ?? systemEnv.ADMIN_TOKEN
      ?? fileEnv.OP_ADMIN_TOKEN
      ?? fileEnv.ADMIN_TOKEN
      ?? process.env.OP_ADMIN_TOKEN
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
    !systemEnv.OP_ADMIN_TOKEN &&
    (fileEnv.OP_ADMIN_TOKEN || fileEnv.ADMIN_TOKEN)
  ) {
    updateSystemSecretsEnv(bootstrapState, { OP_ADMIN_TOKEN: bootstrapState.adminToken });
  }

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

// ── Lifecycle Helpers ──────────────────────────────────────────────────

async function reconcileCore(
  state: ControlPlaneState,
  assets: CoreAssetProvider,
  opts: { activateServices?: boolean; deactivateServices?: boolean; seedMemoryConfig?: boolean },
): Promise<string[]> {
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

  // Preflight: validate compose merge before mutation.
  // Only runs when Docker is available and compose files exist.
  // If Docker is unavailable (e.g., first install before Docker setup),
  // the check is skipped with a warning rather than blocking.
  const files = buildComposeFileList(state);
  const envFiles = buildEnvFiles(state);
  if (files.length > 0) {
    const dockerCheck = await checkDocker();
    if (dockerCheck.ok) {
      const preflight = await composePreflight({ files, envFiles });
      if (!preflight.ok) {
        throw new Error(
          `Compose preflight failed: ${preflight.stderr}\n` +
          `Files: ${files.join(", ")}\n` +
          `Env files: ${envFiles.join(", ")}\n` +
          `Project: ${resolveComposeProjectName()}`
        );
      }
    }
  }

  // Snapshot before writing (for rollback on failure)
  snapshotCurrentState(state);

  // Resolve and persist configuration directly to live paths
  state.artifacts = resolveArtifacts(state, assets);
  persistConfiguration(state, assets);
  return active;
}

export async function applyInstall(state: ControlPlaneState, assets: CoreAssetProvider): Promise<void> {
  await reconcileCore(state, assets, { activateServices: true, seedMemoryConfig: true });
}

export async function applyUpdate(state: ControlPlaneState, assets: CoreAssetProvider): Promise<{ restarted: string[] }> {
  return { restarted: await reconcileCore(state, assets, {}) };
}

export async function applyUninstall(state: ControlPlaneState, assets: CoreAssetProvider): Promise<{ stopped: string[] }> {
  return { stopped: await reconcileCore(state, assets, { deactivateServices: true }) };
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
  const systemEnvPath = `${state.vaultDir}/stack/stack.env`;
  const parsed = parseEnvFile(systemEnvPath);
  const namespace = (parsed.OP_IMAGE_NAMESPACE ?? process.env.OP_IMAGE_NAMESPACE ?? "openpalm").trim().toLowerCase();

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
  const updatedContent = mergeEnvContent(currentContent, { OP_IMAGE_TAG: latestTag }, { uncomment: true });
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
  const restarted = await reconcileCore(state, assets, {});
  return { backupDir, updated, restarted };
}

// ── Compose File List Builder ────────────────────────────────────────────

/**
 * Build the compose file list from stack/.
 * Returns: [stack/core.compose.yml, stack/addons/{name}/compose.yml]
 * filtered by enabled addons in stack.yaml.
 */
export function buildComposeFileList(state: ControlPlaneState): string[] {
  const stackDir = `${state.homeDir}/stack`;
  const coreYml = `${stackDir}/core.compose.yml`;
  const files: string[] = [];

  if (existsSync(coreYml)) {
    files.push(coreYml);
  }

  // Add addon overlays for enabled addons
  const spec = readStackSpec(state.configDir);
  if (spec?.addons) {
    for (const [addonName, addon] of Object.entries(spec.addons)) {
      if (addon === false) continue;
      const addonYml = `${stackDir}/addons/${addonName}/compose.yml`;
      if (existsSync(addonYml)) files.push(addonYml);
    }
  }

  return files;
}

/**
 * Build the list of services managed by the stack.
 * Core services always included; addon services derived from stack.yaml.
 *
 * For the authoritative runtime service list from Docker Compose,
 * use composeConfigServices() which runs `docker compose config --services`.
 */
export function buildManagedServices(state: ControlPlaneState): string[] {
  const services: string[] = [...CORE_SERVICES];

  // Add addon-specific services based on stack.yaml
  const spec = readStackSpec(state.configDir);
  if (spec?.addons) {
    for (const [addonName, addon] of Object.entries(spec.addons)) {
      if (addon === false) continue;
      services.push(addonName);
    }
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
