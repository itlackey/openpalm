/**
 * OpenPalm Control Plane — Core state management, types, and business logic.
 *
 * This module is the single source of truth for the control plane's in-memory
 * state. It handles artifact staging, audit logging, guardian security
 * (HMAC, replay, rate limiting, intake validation), and lifecycle helpers.
 *
 * Real Docker operations are delegated to docker.ts — this module only
 * manages state transitions and artifact staging.
 *
 * Directory model (XDG-compliant):
 *   CONFIG_HOME (~/.config/openpalm)      — user-editable: secrets.env, channels/, opencode/
 *   DATA_HOME   (~/.local/share/openpalm) — opaque service data (postgres, qdrant, etc.)
 *   STATE_HOME  (~/.local/state/openpalm) — assembled runtime, audit logs
 *
 * Channel registry: Channel compose overlays (.yml) and optional Caddy routes
 * (.caddy) are cataloged in registry/ and bundled at build time via
 * import.meta.glob. Channels are NOT auto-installed — users install them
 * explicitly via the admin API. Installed channel files live in
 * CONFIG_HOME/channels/. Caddy files are optional: if present, the channel
 * gets HTTP routing through Caddy; if absent, it's Docker-network only.
 */
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { createHash, randomBytes } from "node:crypto";

// @ts-ignore — raw asset imports bundled by Vite at build time
import coreComposeAsset from "$assets/docker-compose.yml?raw";
// @ts-ignore — raw asset imports bundled by Vite at build time
import caddyfileAsset from "$assets/Caddyfile?raw";

// ── Registry channel catalog (discovered at build time) ───────────────
// import.meta.glob discovers all .yml and .caddy files in registry/
// at build time. Adding a new registry channel = dropping files in registry/.
const channelYmlModules: Record<string, string> = import.meta.glob(
  "$registry/*.yml",
  { query: "?raw", eager: true, import: "default" }
) as Record<string, string>;

const channelCaddyModules: Record<string, string> = import.meta.glob(
  "$registry/*.caddy",
  { query: "?raw", eager: true, import: "default" }
) as Record<string, string>;

/** Extract channel name from a glob path like "/.../channels/chat.yml" → "chat" */
function assetMap(modules: Record<string, string>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [path, content] of Object.entries(modules)) {
    const filename = path.split("/").pop() ?? "";
    const name = filename.replace(/\.\w+$/, "");
    if (name) map[name] = content;
  }
  return map;
}

/** Registry channel compose overlays, keyed by channel name */
export const REGISTRY_CHANNEL_YML: Record<string, string> = assetMap(channelYmlModules);

/** Registry channel Caddy routes (optional), keyed by channel name */
export const REGISTRY_CHANNEL_CADDY: Record<string, string> = assetMap(channelCaddyModules);

/** Names of registry channels derived from bundled assets */
export const REGISTRY_CHANNEL_NAMES: string[] = Object.keys(REGISTRY_CHANNEL_YML);

/**
 * Minimal opencode.json seeded into CONFIG_HOME/opencode/ on first install.
 * Contains only the schema reference so OpenCode can validate it — no provider
 * config is included, preserving user credentials and choices.
 */
const OPENCODE_STARTER_CONFIG = JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + "\n";

// ── Types ──────────────────────────────────────────────────────────────

export type CoreServiceName =
  | "assistant"
  | "guardian"
  | "openmemory"
  | "openmemory-ui"
  | "admin"
  | "caddy"
  | "postgres"
  | "qdrant";

export type AccessScope = "host" | "lan";
export type CallerType = "assistant" | "cli" | "ui" | "system" | "test" | "unknown";

/** Info about a discovered channel */
export type ChannelInfo = {
  name: string;
  hasRoute: boolean;
  ymlPath: string;
  caddyPath: string | null;
};

export type AuditEntry = {
  at: string;
  requestId: string;
  actor: string;
  callerType: CallerType;
  action: string;
  args: Record<string, unknown>;
  ok: boolean;
};

export type ArtifactMeta = {
  name: string;
  sha256: string;
  generatedAt: string;
  bytes: number;
};

export type ControlPlaneState = {
  adminToken: string;
  postgresPassword: string;
  stateDir: string;
  configDir: string;
  dataDir: string;
  services: Record<string, "running" | "stopped">;
  installedExtensions: Set<string>;
  artifacts: {
    compose: string;
    caddyfile: string;
  };
  artifactMeta: ArtifactMeta[];
  audit: AuditEntry[];
  channelSecrets: Record<string, string>;
};

// ── Constants ──────────────────────────────────────────────────────────

export const CORE_SERVICES: CoreServiceName[] = [
  "caddy",
  "postgres",
  "qdrant",
  "openmemory",
  "openmemory-ui",
  "assistant",
  "guardian",
  "admin"
];

const ALLOWED_ACTIONS = new Set([
  "install",
  "update",
  "uninstall",
  "containers.list",
  "containers.pull",
  "containers.up",
  "containers.down",
  "containers.restart",
  "channels.list",
  "channels.install",
  "channels.uninstall",

  "extensions.list",
  "extensions.install",
  "extensions.uninstall",
  "gallery.refresh",
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

const MAX_AUDIT_MEMORY = 1000;
const PUBLIC_ACCESS_IMPORT = "import public_access";
const LAN_ONLY_IMPORT = "import lan_only";

// ── Path Helpers ──────────────────────────────────────────────────────

function resolveHome(): string {
  return process.env.HOME ?? "/tmp";
}

function resolveConfigHome(): string {
  const raw = process.env.OPENPALM_CONFIG_HOME;
  if (!raw) return `${resolveHome()}/.config/openpalm`;
  return resolvePath(raw);
}

function resolveStateHome(): string {
  const raw = process.env.OPENPALM_STATE_HOME;
  if (!raw) return `${resolveHome()}/.local/state/openpalm`;
  return resolvePath(raw);
}

function resolveDataHome(): string {
  const raw = process.env.OPENPALM_DATA_HOME;
  if (!raw) return `${resolveHome()}/.local/share/openpalm`;
  return resolvePath(raw);
}

// ── Channel Name Validation ───────────────────────────────────────────

/** Strict channel name: lowercase alphanumeric + hyphens, 1–63 chars, must start with alnum */
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function isValidChannelName(name: string): boolean {
  return CHANNEL_NAME_RE.test(name);
}

// ── Channel Discovery ─────────────────────────────────────────────────

/**
 * Discover installed channels by scanning CONFIG_HOME/channels/.
 *
 * A channel is any .yml file in the channels directory.
 * A .caddy file is optional — if present, the channel gets Caddy HTTP routing.
 * If absent, the channel is only accessible on the Docker network (host + containers).
 */
export function discoverChannels(configDir: string): ChannelInfo[] {
  const channelsDir = `${configDir}/channels`;
  if (!existsSync(channelsDir)) return [];

  const files = readdirSync(channelsDir);
  const ymlFiles = files.filter((f) => f.endsWith(".yml"));
  const caddyFiles = new Set(files.filter((f) => f.endsWith(".caddy")));

  return ymlFiles
    .map((ymlFile) => {
      const name = ymlFile.replace(/\.yml$/, "");
      const caddyFile = `${name}.caddy`;
      const hasCaddy = caddyFiles.has(caddyFile);
      return {
        name,
        hasRoute: hasCaddy,
        ymlPath: `${channelsDir}/${ymlFile}`,
        caddyPath: hasCaddy ? `${channelsDir}/${caddyFile}` : null
      };
    })
    .filter((ch) => isValidChannelName(ch.name));
}

// ── State Factory ──────────────────────────────────────────────────────

export function createState(
  adminToken?: string
): ControlPlaneState {
  const stateDir = resolveStateHome();
  const configDir = resolveConfigHome();
  const fileEnv = loadSecretsEnvFile(configDir);
  const resolvedAdminToken =
    adminToken ?? fileEnv.ADMIN_TOKEN ?? process.env.ADMIN_TOKEN;
  if (!resolvedAdminToken) {
    throw new Error("ADMIN_TOKEN must be set via environment variable or secrets.env");
  }

  // Initialize core services as stopped
  const services: Record<string, "running" | "stopped"> = {};
  for (const name of CORE_SERVICES) {
    services[name] = "stopped";
  }

  // Load persisted system-managed secrets
  const persistedPostgresPassword = loadPersistedPostgresPassword(stateDir);
  const postgresPassword =
    persistedPostgresPassword
    ?? randomHex(16);

  // Load persisted system-generated channel secrets
  const persistedSecrets = loadPersistedChannelSecrets(stateDir);
  const channelSecrets: Record<string, string> = { ...persistedSecrets };

  const dataDir = resolveDataHome();

  return {
    adminToken: resolvedAdminToken,
    postgresPassword,
    stateDir,
    configDir,
    dataDir,
    services,
    installedExtensions: new Set<string>(),
    artifacts: { compose: "", caddyfile: "" },
    artifactMeta: [],
    audit: [],
    channelSecrets
  };
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Load persisted system-managed postgres password from
 * STATE_HOME/secrets/system-secrets.env.
 */
function loadPersistedPostgresPassword(stateDir: string): string | null {
  const secretsPath = `${stateDir}/secrets/system-secrets.env`;
  try {
    if (!existsSync(secretsPath)) return null;
    const content = readFileSync(secretsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key !== "POSTGRES_PASSWORD") continue;
      return trimmed.slice(eq + 1).trim();
    }
  } catch {
    // fallback to generated value
  }
  return null;
}

/**
 * Load persisted system-generated channel secrets from STATE_HOME/secrets/channel-secrets.env.
 * Returns a map of channel name → secret. Returns empty object if the file doesn't exist.
 */
function loadPersistedChannelSecrets(stateDir: string): Record<string, string> {
  const secretsPath = `${stateDir}/secrets/channel-secrets.env`;
  const result: Record<string, string> = {};
  try {
    if (!existsSync(secretsPath)) return result;
    const content = readFileSync(secretsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const match = key.match(/^CHANNEL_([A-Z0-9_]+)_SECRET$/);
      if (!match?.[1]) continue;
      result[match[1].toLowerCase()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // fallback to empty — new secrets will be generated
  }
  return result;
}

/**
 * Persist system-managed secrets to STATE_HOME/secrets/system-secrets.env.
 */
function persistSystemSecrets(state: ControlPlaneState): void {
  const secretsDir = `${state.stateDir}/secrets`;
  mkdirSync(secretsDir, { recursive: true });
  const lines = [
    "# OpenPalm System Secrets — system-managed, do not edit",
    "",
    `POSTGRES_PASSWORD=${state.postgresPassword}`
  ];
  writeFileSync(`${secretsDir}/system-secrets.env`, lines.join("\n") + "\n");
}

/**
 * Persist all current channel secrets to STATE_HOME/secrets/channel-secrets.env.
 * This file is system-managed and never user-edited. Calling this replaces the
 * entire file so any removed channels are cleaned up.
 */
function persistChannelSecrets(state: ControlPlaneState): void {
  const secretsDir = `${state.stateDir}/secrets`;
  mkdirSync(secretsDir, { recursive: true });
  const lines = [
    "# OpenPalm Channel HMAC Secrets — system-managed, do not edit",
    "# Generated by admin. Rotate via the admin API.",
    ""
  ];
  for (const [ch, secret] of Object.entries(state.channelSecrets)) {
    lines.push(`CHANNEL_${ch.toUpperCase()}_SECRET=${secret}`);
  }
  writeFileSync(`${secretsDir}/channel-secrets.env`, lines.join("\n") + "\n");
}

// ── Allowlist Checks ───────────────────────────────────────────────────

/**
 * Check if a service name is allowed. Core services are always allowed.
 * Channel services (channel-*) are allowed if a corresponding staged .yml exists
 * in STATE_HOME/channels/.
 */
export function isAllowedService(value: string, stateDir?: string): boolean {
  if (!value || !value.trim() || value !== value.toLowerCase()) return false;
  if ((CORE_SERVICES as string[]).includes(value)) return true;
  if (value.startsWith("channel-")) {
    const ch = value.slice("channel-".length);
    if (!isValidChannelName(ch)) return false;
    if (stateDir) {
      return existsSync(`${stateDir}/channels/${ch}.yml`);
    }
  }
  return false;
}

export function isAllowedAction(action: string): boolean {
  return ALLOWED_ACTIONS.has(action);
}

/**
 * Check if a channel name is valid. Accepts any channel with a staged
 * .yml file in STATE_HOME/channels/.
 */
export function isValidChannel(value: string, stateDir?: string): boolean {
  if (!value || !value.trim()) return false;
  if (!isValidChannelName(value)) return false;
  if (stateDir) {
    return existsSync(`${stateDir}/channels/${value}.yml`);
  }
  return false;
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

// ── Lifecycle Helpers ──────────────────────────────────────────────────

export function applyInstall(state: ControlPlaneState): void {
  for (const service of CORE_SERVICES) {
    state.services[service] = "running";
  }
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
  state.installedExtensions.clear();
  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);
  return { stopped };
}

// ── Compose File List Builder ────────────────────────────────────────────

/**
 * Build the full list of compose files: core compose + all staged channel overlays.
 * Uses staged .yml files from STATE_HOME/channels/ — never reads from CONFIG_HOME at runtime.
 */
export function buildComposeFileList(state: ControlPlaneState): string[] {
  const files = [`${state.stateDir}/artifacts/docker-compose.yml`];
  const stagedYmls = discoverStagedChannelYmls(state.stateDir);
  files.push(...stagedYmls);
  return files;
}

// ── Artifact Staging ────────────────────────────────────────────────────

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function stageArtifacts(state: ControlPlaneState): {
  compose: string;
  caddyfile: string;
} {
  return {
    compose: stageCompose(state),
    caddyfile: stageCaddyfile(state)
  };
}

function stageCompose(_state: ControlPlaneState): string {
  return coreComposeAsset;
}

/** IP ranges for each access scope mode */
const HOST_ONLY_IPS = "127.0.0.0/8 ::1";
const LAN_IPS = "10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 ::1 fc00::/7 fe80::/10";
const REMOTE_IP_LINE_RE = /@denied not remote_ip [^\n]+/;

function coreCaddyfilePath(): string {
  return `${resolveDataHome()}/caddy/Caddyfile`;
}

/**
 * Ensure the system-managed core Caddyfile exists in DATA_HOME.
 * This file is the source of truth for access scope policy.
 */
export function ensureCoreCaddyfile(): string {
  const path = coreCaddyfilePath();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, caddyfileAsset);
  }
  return path;
}

export function readCoreCaddyfile(): string {
  const path = ensureCoreCaddyfile();
  return readFileSync(path, "utf-8");
}

export function detectAccessScope(rawCaddyfile: string): AccessScope | "custom" {
  const match = rawCaddyfile.match(REMOTE_IP_LINE_RE);
  if (!match) return "custom";
  const ips = match[0].replace("@denied not remote_ip", "").trim();
  if (ips === HOST_ONLY_IPS) return "host";
  if (ips === LAN_IPS) return "lan";
  return "custom";
}

export function setCoreCaddyAccessScope(scope: AccessScope): { ok: true } | { ok: false; error: string } {
  const path = ensureCoreCaddyfile();
  const raw = readFileSync(path, "utf-8");
  if (!REMOTE_IP_LINE_RE.test(raw)) {
    return { ok: false, error: "core Caddyfile missing '@denied not remote_ip' line" };
  }
  const ips = scope === "host" ? HOST_ONLY_IPS : LAN_IPS;
  const updated = raw.replace(REMOTE_IP_LINE_RE, `@denied not remote_ip ${ips}`);
  writeFileSync(path, updated);
  return { ok: true };
}

function stageCaddyfile(_state: ControlPlaneState): string {
  return readCoreCaddyfile();
}

function withDefaultLanOnly(rawCaddy: string): string | null {
  if (rawCaddy.includes(PUBLIC_ACCESS_IMPORT) || rawCaddy.includes(LAN_ONLY_IMPORT)) {
    return rawCaddy;
  }

  const blockStarts = [
    /(handle_path\s+[^\n{]+\{\s*\n?)/,
    /(handle\s+[^\n{]+\{\s*\n?)/,
    /(route\s+[^\n{]+\{\s*\n?)/
  ];

  for (const pattern of blockStarts) {
    if (pattern.test(rawCaddy)) {
      return rawCaddy.replace(pattern, "$1\timport lan_only\n");
    }
  }

  return null;
}

function stageChannelCaddyfiles(state: ControlPlaneState): void {
  const stagedChannelsDir = `${state.stateDir}/channels`;
  const stagedPublicDir = `${stagedChannelsDir}/public`;
  const stagedLanDir = `${stagedChannelsDir}/lan`;
  // Only clean the caddy subdirectories, not the whole channels/ dir
  // (which also contains staged .yml files)
  rmSync(stagedPublicDir, { recursive: true, force: true });
  rmSync(stagedLanDir, { recursive: true, force: true });
  mkdirSync(stagedPublicDir, { recursive: true });
  mkdirSync(stagedLanDir, { recursive: true });

  const channels = discoverChannels(state.configDir);
  for (const ch of channels) {
    if (!ch.caddyPath) continue;

    const raw = readFileSync(ch.caddyPath, "utf-8");
    if (raw.includes(PUBLIC_ACCESS_IMPORT)) {
      writeFileSync(`${stagedPublicDir}/${ch.name}.caddy`, raw);
      continue;
    }

    const lanScoped = withDefaultLanOnly(raw);
    if (!lanScoped) {
      appendAudit(
        state,
        "system",
        "channels.route.skip",
        {
          channel: ch.name,
          reason: "Unable to infer route block for default LAN scoping"
        },
        false,
        "",
        "system"
      );
      continue;
    }
    writeFileSync(`${stagedLanDir}/${ch.name}.caddy`, lanScoped);
  }
}


/**
 * Stage STATE_HOME/artifacts/secrets.env from CONFIG_HOME/secrets.env.
 *
 * Copies the user's secrets file as-is into the staged artifacts directory.
 * By convention, CONFIG_HOME/secrets.env should contain only ADMIN_TOKEN and
 * LLM provider keys — system-managed values live in stack.env — but this is
 * not enforced. Users may add extra vars here if needed.
 */
function stageSecretsEnv(state: ControlPlaneState): void {
  const artifactDir = `${state.stateDir}/artifacts`;
  mkdirSync(artifactDir, { recursive: true });

  const source = `${state.configDir}/secrets.env`;
  const content = existsSync(source) ? readFileSync(source, "utf-8") : "";
  writeFileSync(`${artifactDir}/secrets.env`, content);
}

/** Return the path to the staged secrets.env in STATE_HOME. */
export function stagedEnvFile(state: ControlPlaneState): string {
  return `${state.stateDir}/artifacts/secrets.env`;
}

/** Return the path to the staged stack.env in STATE_HOME. */
export function stagedStackEnvFile(state: ControlPlaneState): string {
  return `${state.stateDir}/artifacts/stack.env`;
}

/**
 * Return both staged env files in load order: [stack.env, secrets.env].
 * stack.env carries infrastructure config; secrets.env carries secrets.
 * Non-existent files are omitted so docker compose does not error on missing files.
 */
export function buildEnvFiles(state: ControlPlaneState): string[] {
  return [stagedStackEnvFile(state), stagedEnvFile(state)].filter(existsSync);
}

/**
 * Assemble STATE_HOME/artifacts/stack.env from runtime-detected system values.
 *
 * This file holds all non-secret infrastructure configuration consumed by
 * docker compose. Values are auto-detected from the admin's own environment
 * (process.env, process.uid/gid, docker socket stat) so the user never needs
 * to set them in CONFIG_HOME/secrets.env.
 *
 * Runtime consumers:
 *   - docker compose --env-file (variable substitution in compose files)
 *   - guardian env_file + bind mount (CHANNEL_*_SECRET read at request time)
 *   - postgres service (POSTGRES_PASSWORD via compose substitution)
 */
function stageStackEnv(state: ControlPlaneState): void {
  const artifactDir = `${state.stateDir}/artifacts`;
  mkdirSync(artifactDir, { recursive: true });

  const uid = typeof process.getuid === "function" ? (process.getuid() ?? 1000) : 1000;
  const gid = typeof process.getgid === "function" ? (process.getgid() ?? 1000) : 1000;

  // Auto-detect Docker socket GID; fall back to process GID if socket unavailable (e.g. dev mode).
  let dockerGid = gid;
  try {
    const st = statSync("/var/run/docker.sock");
    if (st.gid > 0) dockerGid = st.gid;
  } catch {
    // socket not present — running outside Docker (dev server); fallback is fine
  }

  const home = process.env.HOME ?? "/tmp";
  const workDir = process.env.OPENPALM_WORK_DIR ?? `${home}/openpalm`;

  const lines = [
    "# OpenPalm Stack Configuration — system-managed, do not edit",
    "# Generated by admin on startup. Overwritten on each apply.",
    "",
    "# ── XDG Paths ──────────────────────────────────────────────────────",
    `OPENPALM_CONFIG_HOME=${state.configDir}`,
    `OPENPALM_DATA_HOME=${state.dataDir}`,
    `OPENPALM_STATE_HOME=${state.stateDir}`,
    `OPENPALM_WORK_DIR=${workDir}`,
    "",
    "# ── User/Group ──────────────────────────────────────────────────────",
    `OPENPALM_UID=${uid}`,
    `OPENPALM_GID=${gid}`,
    `OPENPALM_DOCKER_GID=${dockerGid}`,
    "",
    "# ── Images ──────────────────────────────────────────────────────────",
    `OPENPALM_IMAGE_NAMESPACE=${process.env.OPENPALM_IMAGE_NAMESPACE ?? "openpalm"}`,
    `OPENPALM_IMAGE_TAG=${process.env.OPENPALM_IMAGE_TAG ?? "latest"}`,
    "",
    "# ── Networking ──────────────────────────────────────────────────────",
    `OPENPALM_INGRESS_BIND_ADDRESS=${process.env.OPENPALM_INGRESS_BIND_ADDRESS ?? "127.0.0.1"}`,
    `OPENPALM_INGRESS_PORT=${process.env.OPENPALM_INGRESS_PORT ?? "8080"}`,
    "",
    "# ── OpenMemory ──────────────────────────────────────────────────────",
    `OPENMEMORY_DASHBOARD_API_URL=${process.env.OPENMEMORY_DASHBOARD_API_URL ?? "http://localhost:8765"}`,
    `OPENMEMORY_USER_ID=${process.env.OPENMEMORY_USER_ID ?? "default_user"}`,
    "",
    "# ── Database ────────────────────────────────────────────────────────",
    `POSTGRES_PASSWORD=${state.postgresPassword}`,
    "",
    "# ── Channel HMAC Secrets ────────────────────────────────────────────",
    ...Object.entries(state.channelSecrets).map(
      ([ch, secret]) => `CHANNEL_${ch.toUpperCase()}_SECRET=${secret}`
    ),
    ""
  ];

  writeFileSync(`${artifactDir}/stack.env`, lines.join("\n"));
}

function stageChannelYmlFiles(state: ControlPlaneState): void {
  const stagedChannelsDir = `${state.stateDir}/channels`;
  mkdirSync(stagedChannelsDir, { recursive: true });

  // Clean stale staged .yml files before re-staging
  for (const f of readdirSync(stagedChannelsDir)) {
    if (f.endsWith(".yml")) {
      rmSync(`${stagedChannelsDir}/${f}`, { force: true });
    }
  }

  const channels = discoverChannels(state.configDir);
  for (const ch of channels) {
    const content = readFileSync(ch.ymlPath, "utf-8");
    writeFileSync(`${stagedChannelsDir}/${ch.name}.yml`, content);
  }
}

/**
 * Discover staged channel .yml overlays from STATE_HOME/channels/.
 * Returns absolute paths to staged .yml files. Used by buildComposeFileList()
 * so that Docker Compose reads from staged runtime artifacts, not from CONFIG_HOME.
 */
export function discoverStagedChannelYmls(stateDir: string): string[] {
  const channelsDir = `${stateDir}/channels`;
  if (!existsSync(channelsDir)) return [];

  return readdirSync(channelsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => `${channelsDir}/${entry.name}`);
}

// ── Artifact Metadata ──────────────────────────────────────────────────

export function buildArtifactMeta(artifacts: {
  compose: string;
  caddyfile: string;
}): ArtifactMeta[] {
  const now = new Date().toISOString();
  return (["compose", "caddyfile"] as const).map((name) => ({
    name,
    sha256: sha256(artifacts[name]),
    generatedAt: now,
    bytes: Buffer.byteLength(artifacts[name])
  }));
}

// ── Persistence ────────────────────────────────────────────────────────

/**
 * Persist core artifacts to STATE_HOME.
 *
 * Directory responsibilities:
 *   STATE_HOME/artifacts/  — generated compose, manifest (not user-edited)
 *   STATE_HOME/Caddyfile   — generated Caddyfile (not user-edited)
 *   CONFIG_HOME/channels/  — channel .yml and .caddy files (user-installed)
 */
export function persistArtifacts(state: ControlPlaneState): void {
  const artifactDir = `${state.stateDir}/artifacts`;
  const channelsDir = `${state.configDir}/channels`;
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(channelsDir, { recursive: true });

  // Core artifacts → STATE_HOME
  writeFileSync(`${artifactDir}/docker-compose.yml`, state.artifacts.compose);
  writeFileSync(`${state.stateDir}/Caddyfile`, state.artifacts.caddyfile);

  persistSystemSecrets(state);
  // Ensure every discovered channel has a secret, then persist before staging
  const allChannels = discoverChannels(state.configDir);
  for (const ch of allChannels) {
    if (!state.channelSecrets[ch.name]) {
      state.channelSecrets[ch.name] = randomHex(16);
    }
  }
  persistChannelSecrets(state);
  stageStackEnv(state);
  stageSecretsEnv(state);
  stageChannelYmlFiles(state);
  stageChannelCaddyfiles(state);

  state.artifactMeta = buildArtifactMeta(state.artifacts);
  writeFileSync(
    `${artifactDir}/manifest.json`,
    JSON.stringify(state.artifactMeta, null, 2)
  );
}

// ── Channel Install / Uninstall ─────────────────────────────────────────

/**
 * Install a channel from the registry catalog into CONFIG_HOME/channels/.
 * Copies the .yml (and optional .caddy) from bundled registry assets.
 * Refuses if the channel is already installed (files already exist).
 */
export function installChannelFromRegistry(
  name: string,
  configDir: string
): { ok: true } | { ok: false; error: string } {
  if (!isValidChannelName(name)) {
    return { ok: false, error: `Invalid channel name: ${name}` };
  }
  if (!(name in REGISTRY_CHANNEL_YML)) {
    return { ok: false, error: `Channel "${name}" not found in registry` };
  }
  const channelsDir = `${configDir}/channels`;
  mkdirSync(channelsDir, { recursive: true });

  const ymlPath = `${channelsDir}/${name}.yml`;
  if (existsSync(ymlPath)) {
    return { ok: false, error: `Channel "${name}" is already installed` };
  }

  writeFileSync(ymlPath, REGISTRY_CHANNEL_YML[name]);
  if (name in REGISTRY_CHANNEL_CADDY) {
    writeFileSync(`${channelsDir}/${name}.caddy`, REGISTRY_CHANNEL_CADDY[name]);
  }
  return { ok: true };
}

/**
 * Uninstall a channel by removing its .yml (and .caddy) from CONFIG_HOME/channels/.
 */
export function uninstallChannel(
  name: string,
  configDir: string
): { ok: true } | { ok: false; error: string } {
  if (!isValidChannelName(name)) {
    return { ok: false, error: `Invalid channel name: ${name}` };
  }
  const channelsDir = `${configDir}/channels`;
  const ymlPath = `${channelsDir}/${name}.yml`;
  if (!existsSync(ymlPath)) {
    return { ok: false, error: `Channel "${name}" is not installed` };
  }

  rmSync(ymlPath, { force: true });
  rmSync(`${channelsDir}/${name}.caddy`, { force: true });
  return { ok: true };
}

// ── Secrets ─────────────────────────────────────────────────────────────

/**
 * Write a consolidated user-editable secrets.env to CONFIG_HOME/secrets.env.
 * System-managed secrets (POSTGRES_PASSWORD, channel HMAC keys) are persisted
 * under STATE_HOME/secrets and injected only into staged runtime artifacts.
 * Only writes once — skips if secrets.env already exists.
 */
export function ensureSecrets(state: ControlPlaneState): void {
  mkdirSync(state.configDir, { recursive: true });
  const secretsPath = `${state.configDir}/secrets.env`;
  if (existsSync(secretsPath)) {
    return;
  }

  // Consolidated user secrets file — ADMIN_TOKEN + LLM keys only.
  // System-managed secrets are persisted under STATE_HOME/secrets and are NOT
  // written to CONFIG_HOME/secrets.env.
  const secretLines: string[] = [];
  secretLines.push("# OpenPalm Secrets");
  secretLines.push("# Edit this file to update admin token and LLM keys.");
  secretLines.push("# System-managed secrets (database + channel HMAC) do not belong here.");
  secretLines.push("");
  secretLines.push(`ADMIN_TOKEN=${state.adminToken}`);
  secretLines.push("");
  secretLines.push("# LLM provider keys");
  secretLines.push(`OPENAI_API_KEY=${process.env.OPENAI_API_KEY ?? ""}`);
  secretLines.push(`GROQ_API_KEY=${process.env.GROQ_API_KEY ?? ""}`);
  secretLines.push(`MISTRAL_API_KEY=${process.env.MISTRAL_API_KEY ?? ""}`);
  secretLines.push(`GOOGLE_API_KEY=${process.env.GOOGLE_API_KEY ?? ""}`);
  writeFileSync(secretsPath, secretLines.join("\n") + "\n");
}

// ── XDG Directory Setup ────────────────────────────────────────────────

/**
 * Create the full XDG directory tree.
 *
 * CONFIG_HOME (~/.config/openpalm)      — user-editable configuration
 * DATA_HOME   (~/.local/share/openpalm) — opaque persistent service data
 * STATE_HOME  (~/.local/state/openpalm) — generated artifacts, audit logs
 */
export function ensureXdgDirs(): void {
  const dataHome = resolveDataHome();
  const configHome = resolveConfigHome();
  const stateHome = resolveStateHome();

  for (const dir of [
    // CONFIG_HOME — user-editable
    configHome,
    `${configHome}/channels`,
    `${configHome}/opencode`,

    // DATA_HOME — persistent service data (pre-created to avoid root-owned dirs)
    dataHome,
    `${dataHome}/postgres`,
    `${dataHome}/qdrant`,
    `${dataHome}/openmemory`,
    `${dataHome}/assistant`,
    `${dataHome}/guardian`,
    `${dataHome}/caddy`,
    `${dataHome}/caddy/data`,
    `${dataHome}/caddy/config`,

    // STATE_HOME — assembled runtime
    stateHome,
    `${stateHome}/artifacts`,
    `${stateHome}/audit`,
    `${stateHome}/secrets`
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── OpenCode Config ────────────────────────────────────────────────────

/**
 * Seed a starter OpenCode config directory into CONFIG_HOME/opencode/ on first install.
 *
 * Creates opencode.json (schema reference only) and three subdirectories —
 * tools/, plugins/, skills/ — so the user has a ready-made layout to extend.
 * Never overwrites an existing opencode.json; the function is safe to call on
 * every install or update.
 */
export function ensureOpenCodeConfig(): void {
  const configHome = resolveConfigHome();
  const opencodePath = `${configHome}/opencode`;
  mkdirSync(opencodePath, { recursive: true });

  const configFile = `${opencodePath}/opencode.json`;
  if (!existsSync(configFile)) {
    writeFileSync(configFile, OPENCODE_STARTER_CONFIG);
  }

  for (const subdir of ["tools", "plugins", "skills"]) {
    mkdirSync(`${opencodePath}/${subdir}`, { recursive: true });
  }
}

// ── Audit ──────────────────────────────────────────────────────────────

export function appendAudit(
  state: ControlPlaneState,
  actor: string,
  action: string,
  args: Record<string, unknown>,
  ok: boolean,
  requestId = "",
  callerType: CallerType = "unknown"
): void {
  const entry: AuditEntry = {
    at: new Date().toISOString(),
    requestId,
    actor,
    callerType,
    action,
    args,
    ok
  };
  state.audit.push(entry);
  if (state.audit.length > MAX_AUDIT_MEMORY) {
    state.audit = state.audit.slice(-MAX_AUDIT_MEMORY);
  }
  try {
    const auditDir = `${state.stateDir}/audit`;
    mkdirSync(auditDir, { recursive: true });
    appendFileSync(
      `${auditDir}/admin-audit.jsonl`,
      JSON.stringify(entry) + "\n"
    );
  } catch {
    // best-effort persistence
  }
}

// ── Connection Key Management ───────────────────────────────────────────

/**
 * Allowed keys that can be patched via the connections API.
 * Only these keys may be written to CONFIG_HOME/secrets.env via the API.
 */
export const ALLOWED_CONNECTION_KEYS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "GOOGLE_API_KEY",
  "GUARDIAN_LLM_PROVIDER",
  "GUARDIAN_LLM_MODEL",
  "OPENMEMORY_OPENAI_BASE_URL",
  "OPENMEMORY_OPENAI_API_KEY"
]);

/**
 * Keys that contain LLM provider API credentials — at least one must be set
 * for connections to be considered "complete".
 */
export const REQUIRED_LLM_PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "GOOGLE_API_KEY"
];

/**
 * Read specific allowed keys from CONFIG_HOME/secrets.env.
 * Returns a map of key → raw value (empty string if not set).
 * Only returns keys in ALLOWED_CONNECTION_KEYS.
 */
export function readSecretsEnvFile(configDir: string): Record<string, string> {
  const secretsPath = `${configDir}/secrets.env`;
  const result: Record<string, string> = {};
  try {
    if (!existsSync(secretsPath)) return result;
    const content = readFileSync(secretsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!ALLOWED_CONNECTION_KEYS.has(key)) continue;
      let value = trimmed.slice(eq + 1).trim();
      const comment = value.search(/\s+#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  } catch {
    // return partial result
  }
  return result;
}

/**
 * Patch specific key=value entries in CONFIG_HOME/secrets.env.
 *
 * Rules:
 * - Only patches keys present in ALLOWED_CONNECTION_KEYS.
 * - Reads existing file, updates matching lines in-place.
 * - Appends new keys at the end if not already present.
 * - Never deletes existing keys (including keys not in ALLOWED_CONNECTION_KEYS).
 * - Creates the file if it does not exist.
 */
export function patchSecretsEnvFile(
  configDir: string,
  patches: Record<string, string>
): void {
  // Filter to allowed keys only
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(patches)) {
    if (ALLOWED_CONNECTION_KEYS.has(key)) {
      allowed[key] = value;
    }
  }
  if (Object.keys(allowed).length === 0) return;

  const secretsPath = `${configDir}/secrets.env`;
  mkdirSync(configDir, { recursive: true });

  let existingContent = "";
  try {
    if (existsSync(secretsPath)) {
      existingContent = readFileSync(secretsPath, "utf-8");
    }
  } catch {
    // start fresh
  }

  const lines = existingContent.split("\n");
  const patched = new Set<string>();

  // Update existing lines for keys in patches
  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in allowed) {
      patched.add(key);
      return `${key}=${allowed[key]}`;
    }
    return line;
  });

  // Append any keys that weren't found in the existing file
  const toAppend: string[] = [];
  for (const [key, value] of Object.entries(allowed)) {
    if (!patched.has(key)) {
      toAppend.push(`${key}=${value}`);
    }
  }

  let result = updatedLines.join("\n");
  if (toAppend.length > 0) {
    if (!result.endsWith("\n")) result += "\n";
    result += toAppend.join("\n") + "\n";
  }

  writeFileSync(secretsPath, result);
}

// ── Connection Value Masking ────────────────────────────────────────────

/** Keys that are non-secret config — returned unmasked in connection responses. */
export const PLAIN_CONFIG_KEYS = new Set([
  "GUARDIAN_LLM_PROVIDER",
  "GUARDIAN_LLM_MODEL",
  "OPENMEMORY_OPENAI_BASE_URL"
]);

export function maskConnectionValue(key: string, value: string): string {
  if (!value) return "";
  if (PLAIN_CONFIG_KEYS.has(key)) return value;
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

// ── Secrets Loading ────────────────────────────────────────────────────

function loadSecretsEnvFile(configDir?: string): Record<string, string> {
  const base = configDir ?? resolveConfigHome();
  const secretsPath = `${base}/secrets.env`;
  const result: Record<string, string> = {};

  try {
    if (!existsSync(secretsPath)) return result;
    const content = readFileSync(secretsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!/^[A-Z0-9_]+$/.test(key)) continue;

      let value = trimmed.slice(eq + 1).trim();
      const comment = value.search(/\s+#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  } catch {
    // fallback to env/defaults
  }

  return result;
}
