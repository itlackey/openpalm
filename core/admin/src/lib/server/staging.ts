/**
 * Artifact staging pipeline for the OpenPalm control plane.
 *
 * Stages artifacts from CONFIG_HOME/DATA_HOME into STATE_HOME:
 * Caddyfile/compose staging, env staging, channel/automation file staging,
 * and artifact persistence.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { mergeEnvContent } from './env.js';
import type { ControlPlaneState, ArtifactMeta } from "./types.js";
import { discoverChannels } from "./channels.js";
import { appendAudit } from "./audit.js";
import { parseAutomationYaml } from "./scheduler.js";
import {
  readCoreCaddyfile,
  readCoreCompose,
  PUBLIC_ACCESS_IMPORT,
  LAN_ONLY_IMPORT
} from "./core-assets.js";

declare const __APP_VERSION__: string;
const DEFAULT_IMAGE_TAG = typeof __APP_VERSION__ !== "undefined" ? `v${__APP_VERSION__}` : "latest";

// Re-export core-assets functions for barrel compatibility
export {
  ensureCoreCaddyfile,
  readCoreCaddyfile,
  detectAccessScope,
  setCoreCaddyAccessScope,
  ensureCoreCompose,
  readCoreCompose,
  ensureOpenCodeSystemConfig,
  refreshCoreAssets
} from "./core-assets.js";

// ── Crypto Utilities ──────────────────────────────────────────────────

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// ── Caddyfile Staging ─────────────────────────────────────────────────

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
  const stagedChannelsDir = `${state.stateDir}/artifacts/channels`;
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

function stageCaddyfile(_state: ControlPlaneState): string {
  return readCoreCaddyfile();
}

// ── Compose Staging ───────────────────────────────────────────────────

function stageCompose(_state: ControlPlaneState): string {
  return readCoreCompose();
}

// ── Env Staging ───────────────────────────────────────────────────────

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
 * Read DATA_HOME/stack.env (written by setup.sh with host-detected values),
 * merge in admin-managed dynamic values (DB password, channel secrets,
 * setup status), and write the combined result to STATE_HOME/artifacts/stack.env.
 *
 * DATA_HOME/stack.env is the source of truth for host-detected infrastructure
 * config (UID/GID, Docker socket, paths). The admin never overwrites those —
 * it only updates the keys it owns in-place and appends new ones.
 */
function stageStackEnv(state: ControlPlaneState): void {
  const artifactDir = `${state.stateDir}/artifacts`;
  mkdirSync(artifactDir, { recursive: true });

  const dataStackEnv = `${state.dataDir}/stack.env`;

  // Read base config from DATA_HOME/stack.env (seeded by setup.sh).
  // If it doesn't exist yet (e.g. dev mode), generate a minimal fallback.
  let base = "";
  if (existsSync(dataStackEnv)) {
    base = readFileSync(dataStackEnv, "utf-8");
  } else {
    base = generateFallbackStackEnv(state);
    mkdirSync(state.dataDir, { recursive: true });
    writeFileSync(dataStackEnv, base);
  }

  // Admin-managed dynamic values to merge into the staged file
  const adminManaged: Record<string, string> = {
    OPENPALM_SETUP_COMPLETE: state.adminToken ? "true" : "false"
  };
  for (const [ch, secret] of Object.entries(state.channelSecrets)) {
    adminManaged[`CHANNEL_${ch.toUpperCase()}_SECRET`] = secret;
  }

  const content = mergeEnvContent(base, adminManaged, {
    sectionHeader: "# ── Admin-managed ──────────────────────────────────────────────────"
  });

  // Update DATA_HOME/stack.env with merged content so persisted values
  // (channel secrets) survive admin restarts.
  writeFileSync(dataStackEnv, content);

  // Stage to STATE_HOME/artifacts/ for compose consumption
  writeFileSync(`${artifactDir}/stack.env`, content);
}

/**
 * Generate a minimal fallback stack.env when DATA_HOME/stack.env doesn't exist.
 * This handles dev mode or first-run before setup.sh has executed.
 */
function generateFallbackStackEnv(state: ControlPlaneState): string {
  const uid = typeof process.getuid === "function" ? (process.getuid() ?? 1000) : 1000;
  const gid = typeof process.getgid === "function" ? (process.getgid() ?? 1000) : 1000;

  const home = process.env.HOME ?? "/tmp";
  const workDir = process.env.OPENPALM_WORK_DIR ?? `${home}/openpalm`;

  return [
    "# OpenPalm Stack Configuration — system-managed, do not edit",
    "# Auto-generated fallback by admin (setup.sh has not run yet).",
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
    "",
    "# ── Docker Socket ───────────────────────────────────────────────────",
    `OPENPALM_DOCKER_SOCK=${process.env.OPENPALM_DOCKER_SOCK ?? "/var/run/docker.sock"}`,
    "",
    "# ── Images ──────────────────────────────────────────────────────────",
    `OPENPALM_IMAGE_NAMESPACE=${process.env.OPENPALM_IMAGE_NAMESPACE ?? "openpalm"}`,
    `OPENPALM_IMAGE_TAG=${process.env.OPENPALM_IMAGE_TAG ?? DEFAULT_IMAGE_TAG}`,
    "",
    "# ── Networking ──────────────────────────────────────────────────────",
    `OPENPALM_INGRESS_BIND_ADDRESS=${process.env.OPENPALM_INGRESS_BIND_ADDRESS ?? "127.0.0.1"}`,
    `OPENPALM_INGRESS_PORT=${process.env.OPENPALM_INGRESS_PORT ?? "8080"}`,
    "",
    "# ── OpenMemory ──────────────────────────────────────────────────────",
    `OPENMEMORY_DASHBOARD_API_URL=${process.env.OPENMEMORY_DASHBOARD_API_URL ?? "http://localhost:8765"}`,
    `OPENMEMORY_USER_ID=${process.env.OPENMEMORY_USER_ID ?? "default_user"}`,
    "",
    "# ── Channel HMAC Secrets ────────────────────────────────────────────",
    ""
  ].join("\n");
}

// ── Channel YML Staging ───────────────────────────────────────────────

function stageChannelYmlFiles(state: ControlPlaneState): void {
  const stagedChannelsDir = `${state.stateDir}/artifacts/channels`;
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
 * Discover staged channel .yml overlays from STATE_HOME/artifacts/channels/.
 * Returns absolute paths to staged .yml files. Used by buildComposeFileList()
 * so that Docker Compose reads from staged runtime artifacts, not from CONFIG_HOME.
 */
export function discoverStagedChannelYmls(stateDir: string): string[] {
  const channelsDir = `${stateDir}/artifacts/channels`;
  if (!existsSync(channelsDir)) return [];

  return readdirSync(channelsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => `${channelsDir}/${entry.name}`);
}

// ── Channel Env Staging ──────────────────────────────────────────────

// ── Automation Staging ───────────────────────────────────────────────

/** Strict automation filename: lowercase alphanumeric + hyphens, .yml extension, 1–63 chars base */
const AUTOMATION_FILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}\.yml$/;

/**
 * Discover automation files in a directory.
 * Returns filenames and their full paths.
 * Only regular non-hidden .yml files matching the naming convention are returned.
 */
function discoverAutomationFiles(dir: string): { name: string; path: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
    .filter((entry) => AUTOMATION_FILE_NAME_RE.test(entry.name));
}

/**
 * Validate automation YAML content by attempting to parse it.
 * Returns true if the content parses into a valid AutomationConfig.
 */
function validateAutomationContent(content: string, fileName: string): boolean {
  return parseAutomationYaml(content, fileName) !== null;
}

/**
 * Stage automation files from DATA_HOME/automations/ (system) and
 * CONFIG_HOME/automations/ (user) into STATE_HOME/automations/.
 *
 * System files are copied first; user files with the same name override them.
 * This follows the same staging pattern as channels: whole-file copy from
 * source tiers into STATE_HOME for runtime consumption.
 *
 * Only .yml files with valid automation YAML content are staged.
 */
function stageAutomationFiles(state: ControlPlaneState): void {
  const stagedDir = `${state.stateDir}/automations`;
  mkdirSync(stagedDir, { recursive: true });

  // Clean stale staged automation files before re-staging
  for (const f of readdirSync(stagedDir)) {
    const fullPath = `${stagedDir}/${f}`;
    if (!f.startsWith(".")) {
      rmSync(fullPath, { force: true });
    }
  }

  // Stage system-managed automation files from DATA_HOME/automations/ first
  const systemDir = `${state.dataDir}/automations`;
  for (const entry of discoverAutomationFiles(systemDir)) {
    const content = readFileSync(entry.path, "utf-8");
    if (!validateAutomationContent(content, entry.name)) continue;
    writeFileSync(`${stagedDir}/${entry.name}`, content);
  }

  // Stage user automation files from CONFIG_HOME/automations/ (overrides system)
  const userDir = `${state.configDir}/automations`;
  for (const entry of discoverAutomationFiles(userDir)) {
    const content = readFileSync(entry.path, "utf-8");
    if (!validateAutomationContent(content, entry.name)) continue;
    writeFileSync(`${stagedDir}/${entry.name}`, content);
  }
}

// ── Top-Level Staging ─────────────────────────────────────────────────

export function stageArtifacts(state: ControlPlaneState): {
  compose: string;
  caddyfile: string;
} {
  return {
    compose: stageCompose(state),
    caddyfile: stageCaddyfile(state)
  };
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
 *   STATE_HOME/artifacts/  — generated compose, Caddyfile, manifest (not user-edited)
 *   STATE_HOME/artifacts/channels/ — staged channel .yml and .caddy files
 *   CONFIG_HOME/channels/  — channel .yml and .caddy files (user-installed)
 */
export function persistArtifacts(state: ControlPlaneState): void {
  const artifactDir = `${state.stateDir}/artifacts`;
  const channelsDir = `${state.configDir}/channels`;
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(channelsDir, { recursive: true });

  // Core artifacts → STATE_HOME
  writeFileSync(`${artifactDir}/docker-compose.yml`, state.artifacts.compose);
  writeFileSync(`${artifactDir}/Caddyfile`, state.artifacts.caddyfile);

  // Ensure every discovered channel has a secret before staging stack.env
  const allChannels = discoverChannels(state.configDir);
  for (const ch of allChannels) {
    if (!state.channelSecrets[ch.name]) {
      state.channelSecrets[ch.name] = randomHex(16);
    }
  }
  stageStackEnv(state);
  stageSecretsEnv(state);
  stageChannelYmlFiles(state);
  stageChannelCaddyfiles(state);
  stageAutomationFiles(state);

  state.artifactMeta = buildArtifactMeta(state.artifacts);
  writeFileSync(
    `${artifactDir}/manifest.json`,
    JSON.stringify(state.artifactMeta, null, 2)
  );
}
