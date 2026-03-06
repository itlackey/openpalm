/**
 * Lifecycle helpers for the OpenPalm control plane.
 *
 * State factory, apply* lifecycle transitions, compose file list builders,
 * and caller/action validation.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseEnvFile, mergeEnvContent } from "./env.js";
import type { ControlPlaneState, CallerType } from "./types.js";
import { CORE_SERVICES } from "./types.js";
import { resolveConfigHome, resolveStateHome, resolveDataHome } from "./paths.js";
import { loadSecretsEnvFile } from "./secrets.js";
import { stageArtifacts, persistArtifacts, discoverStagedChannelYmls, randomHex, isOllamaEnabled } from "./staging.js";
import { refreshCoreAssets, ensureOpenMemoryDir } from "./core-assets.js";
import { ensureOpenMemoryConfig } from "./openmemory-config.js";

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

  return {
    adminToken: resolvedAdminToken,
    setupToken: randomHex(16),
    stateDir,
    configDir,
    dataDir,
    services,
    artifacts: { compose: "", caddyfile: "" },
    artifactMeta: [],
    audit: [],
    channelSecrets
  };
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

export function applyInstall(state: ControlPlaneState): void {
  for (const service of CORE_SERVICES) {
    state.services[service] = "running";
  }
  ensureOpenMemoryConfig(state.dataDir);
  ensureOpenMemoryDir();
  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);
}

export function applyUpdate(state: ControlPlaneState): { restarted: string[] } {
  const restarted: string[] = [];
  for (const [name, status] of Object.entries(state.services)) {
    if (status === "running") {
      restarted.push(name);
    }
  }
  ensureOpenMemoryDir();
  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);
  return { restarted };
}

export function applyUninstall(state: ControlPlaneState): { stopped: string[] } {
  const stopped: string[] = [];
  for (const [name, status] of Object.entries(state.services)) {
    if (status === "running") {
      stopped.push(name);
    }
    state.services[name] = "stopped";
  }
  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);
  return { stopped };
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
  ensureOpenMemoryDir();

  const restarted: string[] = [];
  for (const [name, status] of Object.entries(state.services)) {
    if (status === "running") {
      restarted.push(name);
    }
  }

  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);

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
 * Excludes:
 *  - **admin** — the admin cannot safely recreate its own container.
 *  - **docker-socket-proxy** — recreating it severs the `DOCKER_HOST`
 *    TCP connection the admin uses to talk to Docker, causing all
 *    subsequent container operations in the same compose run to fail
 *    ("Cannot connect to the Docker daemon at tcp://docker-socket-proxy:2375").
 *
 * Both services are started by the host-side bootstrap (setup.sh) and
 * must remain running throughout admin-initiated compose operations.
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
