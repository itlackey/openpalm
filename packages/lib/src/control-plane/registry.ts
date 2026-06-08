/**
 * Built-in addon/profile discovery and legacy registry helpers.
 *
 * Runtime addon enablement is recorded as OP_ENABLED_ADDONS in stack.env and
 * resolved to Compose profiles. The fixed compose files under config/stack are
 * the runtime source of truth.
 */
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '../logger.js';
import { resolveLocalOpenpalmDir } from './ui-assets.js';
import { ensureChannelSecret, ensureComposeVolumeTargets } from './config-persistence.js';
import { patchSecretsEnvFile, readStackEnv } from './secrets.js';
import { readBundledStackAsset } from './core-assets.js';
import { canonicalAddonProfileSelection, resolveHardwareProfileVariant } from './profile-ids.js';
import { parseEnabledAddons } from './env.js';
import type { ControlPlaneState } from './types.js';
import {
  resolveRegistryAddonsDir,
  resolveRegistryAutomationsDir,
  resolveRegistryDir,
  resolveStashDir,
} from './home.js';

const BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;
const URL_RE = /^(https:\/\/|git@)/;
const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const logger = createLogger('registry');
const BUILTIN_ADDONS = ['api', 'chat', 'discord', 'ollama', 'slack', 'ssh', 'voice'] as const;

// Credential/config field definitions for the first-party addons, parsed by the
// admin Secrets/Addons UI (`# @sensitive` → password+masked, `KEY=DEFAULT`).
// The file-based registry was removed from the skeleton, so these live in-code.
// `ssh` is compose/profile-only (no configurable env) and is intentionally absent.
const BUILTIN_ADDON_ENV_SCHEMAS: Record<string, string> = {
  api: `# API Gateway channel configuration
# ---

# HMAC secret for the API channel. Auto-generated during setup if left blank;
# stored as knowledge/secrets/channel_api_secret.
# @required @sensitive
CHANNEL_API_SECRET=
`,
  chat: `# Web Chat channel configuration
# ---

# HMAC secret for the chat channel. Auto-generated during setup if left blank;
# stored as knowledge/secrets/channel_chat_secret.
# @required @sensitive
CHANNEL_CHAT_SECRET=
`,
  discord: `# Discord bot configuration
# ---

# HMAC secret for the Discord channel. Auto-generated during setup if left blank.
# @required @sensitive
CHANNEL_DISCORD_SECRET=

# ---
# Discord credentials
# ---

# Application ID from the Discord Developer Portal.
# https://discord.com/developers/applications
# @required
DISCORD_APPLICATION_ID=

# Bot token from the Discord Developer Portal (Bot → Token).
# @required @sensitive
DISCORD_BOT_TOKEN=

# ---
# Access control
# ---

# Comma-separated allowed guild (server) IDs. Empty = all joined guilds.
DISCORD_ALLOWED_GUILDS=

# Comma-separated allowed role IDs.
DISCORD_ALLOWED_ROLES=

# Comma-separated allowed user IDs.
DISCORD_ALLOWED_USERS=

# Comma-separated blocked user IDs (denied even if otherwise allowed).
DISCORD_BLOCKED_USERS=

# ---
# Behavior
# ---

# Register slash commands on startup.
DISCORD_REGISTER_COMMANDS=true

# JSON array of custom slash command definitions.
DISCORD_CUSTOM_COMMANDS=

# Hours before a conversation thread expires.
DISCORD_THREAD_TTL_HOURS=24

# Milliseconds to wait before forwarding a message (0 = immediate).
DISCORD_FORWARD_TIMEOUT_MS=0
`,
  slack: `# Slack bot configuration
# ---

# HMAC secret for the Slack channel. Auto-generated during setup if left blank.
# @required @sensitive
CHANNEL_SLACK_SECRET=

# ---
# Slack credentials
# ---

# Bot User OAuth Token (OAuth & Permissions → Bot User OAuth Token).
# @required @sensitive
SLACK_BOT_TOKEN=

# App-Level Token with connections:write (Basic Information → App-Level Tokens).
# @required @sensitive
SLACK_APP_TOKEN=

# ---
# Access control
# ---

# Comma-separated allowed channel IDs. Empty = all channels the bot is in.
SLACK_ALLOWED_CHANNELS=

# Comma-separated allowed user IDs.
SLACK_ALLOWED_USERS=

# Comma-separated blocked user IDs.
SLACK_BLOCKED_USERS=

# ---
# Behavior
# ---

# Hours before a conversation thread expires.
SLACK_THREAD_TTL_HOURS=24

# Milliseconds to allow for guardian forwarding before timing out (default 30m).
SLACK_FORWARD_TIMEOUT_MS=1800000
`,
  ollama: `# Ollama component configuration
# ---

# Bind address for the Ollama HTTP API (default: localhost only).
# @required
OP_OLLAMA_BIND_ADDRESS=127.0.0.1
`,
  voice: `# OpenPalm Voice (Kokoro TTS + Whisper STT) configuration
# ---
# Local inference server — no upstream API or key. Values are optional; the
# compose overlay supplies safe defaults.

# faster-whisper model id. Default base.en is baked into the image.
# @required
OP_VOICE_WHISPER_MODEL=base.en

# Default Kokoro voice id (54 bundled voices, e.g. af_heart, am_michael).
OP_VOICE_KOKORO_VOICE=bf_isabella

# Python logging level: debug, info, warning, error.
OP_VOICE_LOG_LEVEL=info
`,
};

let warnedMissingRegistryAddonsDir = false;

export function validateBranch(branch: string): string {
  const normalized = branch.trim();
  if (!BRANCH_RE.test(normalized)) throw new Error(`Invalid registry branch name: ${branch}`);
  if (normalized.includes('..')) throw new Error(`Invalid registry branch name (contains '..'): ${branch}`);
  return normalized;
}

export function validateRegistryUrl(url: string): string {
  const normalized = url.trim();
  if (!normalized.startsWith('/') && !URL_RE.test(normalized)) {
    throw new Error(`Invalid registry URL: ${url}`);
  }
  return normalized;
}

export function isValidComponentName(name: string): boolean {
  return VALID_NAME_RE.test(name);
}

const DEFAULT_REPO = 'itlackey/openpalm';

export type RegistryConfig = {
  repoUrl: string;
  branch: string;
};

export function getRegistryConfig(): RegistryConfig {
  return {
    repoUrl: validateRegistryUrl(process.env.OP_REGISTRY_URL ?? `https://github.com/${DEFAULT_REPO}.git`),
    branch: validateBranch(process.env.OP_REGISTRY_BRANCH ?? 'main'),
  };
}

export type RegistryAutomationEntry = {
  name: string;
  type: 'automation';
  description: string;
  schedule: string;
  content: string;
};

export type RegistryComponentEntry = {
  compose: string;
  schema: string;
};

export type RegistryAddonConfig = {
  schemaPath: string;
  userEnvPath: string;
  envSchema: string;
};

export type RegistryCatalogVerification = {
  root: string;
  addonCount: number;
  automationCount: number;
};

type MutationResult = { ok: true } | { ok: false; error: string };
export type AddonMutationResult = (
  | { ok: true; enabled: boolean; changed: boolean; services: string[] }
  | { ok: false; error: string }
);

function countValidAddons(rootDir: string): number {
  const addonsDir = join(rootDir, 'addons');
  if (!existsSync(addonsDir)) return 0;
  return readdirSync(addonsDir, { withFileTypes: true }).filter((entry) => {
    if (!entry.isDirectory() || !isValidComponentName(entry.name)) return false;
    const addonDir = join(addonsDir, entry.name);
    // An addon is valid if it has a compose.yml. Overlay-only addons that only
    // patch existing services (ports, env, volumes) do not need an .env.schema;
    // full addons that introduce services and env vars do.
    return existsSync(join(addonDir, 'compose.yml'));
  }).length;
}

function countValidAutomations(rootDir: string): number {
  const automationsDir = join(rootDir, 'automations');
  if (!existsSync(automationsDir)) return 0;
  return readdirSync(automationsDir).filter((file) => {
    if (!file.endsWith('.yml')) return false;
    return isValidComponentName(file.replace(/\.yml$/, ''));
  }).length;
}

export function verifyRegistryCatalog(rootDir = resolveRegistryDir()): RegistryCatalogVerification {
  const addonCount = countValidAddons(rootDir);
  const automationCount = countValidAutomations(rootDir);

  if (addonCount === 0) throw new Error('Registry catalog is incomplete: missing valid addons');
  if (automationCount === 0) throw new Error('Registry catalog is incomplete: missing valid automations');

  return {
    root: rootDir,
    addonCount,
    automationCount,
  };
}

export function materializeRegistryCatalog(sourceRoot: string): string {
  const sourceAddonsDir = join(sourceRoot, '.openpalm', 'data', 'registry', 'addons');
  const sourceAutomationsDir = join(sourceRoot, '.openpalm', 'data', 'registry', 'automations');
  const tempRoot = mkdtempSync(join(tmpdir(), 'openpalm-registry-materialize-'));

  try {
    const tempAddonsDir = join(tempRoot, 'addons');
    const tempAutomationsDir = join(tempRoot, 'automations');
    mkdirSync(tempAddonsDir, { recursive: true });
    mkdirSync(tempAutomationsDir, { recursive: true });

    if (existsSync(sourceAddonsDir)) cpSync(sourceAddonsDir, tempAddonsDir, { recursive: true });
    if (existsSync(sourceAutomationsDir)) cpSync(sourceAutomationsDir, tempAutomationsDir, { recursive: true });

    verifyRegistryCatalog(tempRoot);

    rmSync(resolveRegistryDir(), { recursive: true, force: true });
    mkdirSync(resolveRegistryDir(), { recursive: true });
    cpSync(tempAddonsDir, resolveRegistryAddonsDir(), { recursive: true });
    cpSync(tempAutomationsDir, resolveRegistryAutomationsDir(), { recursive: true });
    return resolveRegistryDir();
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function refreshRegistryCatalog(config?: RegistryConfig): RegistryCatalogVerification {
  const raw = config ?? getRegistryConfig();
  const repoUrl = validateRegistryUrl(raw.repoUrl);
  const branch = validateBranch(raw.branch);
  const cloneDir = mkdtempSync(join(tmpdir(), 'openpalm-registry-refresh-'));

  try {
    execFileSync(
      'git',
      ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', branch, repoUrl, '.'],
      { cwd: cloneDir, stdio: 'pipe', timeout: 60_000 },
    );
    execFileSync('git', ['sparse-checkout', 'set', '.openpalm'], {
      cwd: cloneDir,
      stdio: 'pipe',
      timeout: 30_000,
    });
    const root = materializeRegistryCatalog(cloneDir);
    return verifyRegistryCatalog(root);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to refresh registry from ${repoUrl}: ${msg}`);
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

export function discoverRegistryComponents(): Record<string, RegistryComponentEntry> {
  const addonsDir = resolveRegistryAddonsDir();
  if (!existsSync(addonsDir)) return {};

  const result: Record<string, RegistryComponentEntry> = {};
  for (const entry of readdirSync(addonsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !VALID_NAME_RE.test(entry.name)) continue;
    const addonDir = join(addonsDir, entry.name);
    const composeFile = join(addonDir, 'compose.yml');
    if (!existsSync(composeFile)) continue;

    // .env.schema is optional: overlay-only addons (e.g. a port toggle) do
    // not introduce new env vars, so they ship just compose.yml.
    const schemaFile = join(addonDir, '.env.schema');
    const schema = existsSync(schemaFile) ? readFileSync(schemaFile, 'utf-8') : '';

    result[entry.name] = {
      compose: readFileSync(composeFile, 'utf-8'),
      schema,
    };
  }

  return result;
}

export function discoverRegistryAutomations(stashDir: string): RegistryAutomationEntry[] {
  const localOpenpalmDir = resolveLocalOpenpalmDir();
  const automationsDir = localOpenpalmDir
    ? join(localOpenpalmDir, 'knowledge', 'tasks')
    : join(stashDir, 'tasks');
  if (!existsSync(automationsDir)) return [];

  return readdirSync(automationsDir)
    .filter((file) => file.endsWith('.yml'))
    .map((file) => {
      const name = file.replace(/\.yml$/, '');
      if (!VALID_NAME_RE.test(name)) return null;

      const content = readFileSync(join(automationsDir, file), 'utf-8');
      let description = '';
      let schedule = '';

      // Extract YAML metadata.
      try {
        const parsed = parseYaml(content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          description = (parsed as Record<string, unknown>).description as string ?? '';
          schedule = (parsed as Record<string, unknown>).schedule as string ?? '';
        }
      } catch {
        // best-effort metadata extraction
      }

      return {
        name,
        type: 'automation' as const,
        description,
        schedule,
        content,
      };
    })
    .filter((entry): entry is RegistryAutomationEntry => entry !== null);
}

export function getRegistryAutomation(name: string): string | null {
  if (!VALID_NAME_RE.test(name)) return null;
  const localOpenpalmDir = resolveLocalOpenpalmDir();
  const candidates = [
    localOpenpalmDir ? join(localOpenpalmDir, 'knowledge', 'tasks', `${name}.yml`) : '',
    join(resolveStashDir(), 'tasks', `${name}.yml`),
    join(resolveRegistryAutomationsDir(), `${name}.yml`),
  ].filter(Boolean);
  for (const ymlPath of candidates) {
    if (existsSync(ymlPath)) return readFileSync(ymlPath, 'utf-8');
  }
  return null;
}

export function getRegistryAddonConfig(_homeDir: string, name: string): RegistryAddonConfig {
  if (!VALID_NAME_RE.test(name)) {
    throw new Error(`Invalid addon name: ${name}`);
  }

  // Resolve the addon's `.env.schema` (credential/config field definitions):
  //   1. A materialized registry copy at OP_HOME/data/registry/addons (custom
  //      addons installed from a registry win).
  //   2. The built-in schema embedded below (the first-party addons). The
  //      file-based registry was removed from the skeleton, so the built-in
  //      addon credential schemas live in-code rather than as bundled files.
  const materialized = join(resolveRegistryAddonsDir(), name, '.env.schema');
  if (existsSync(materialized)) {
    return { schemaPath: materialized, userEnvPath: 'knowledge/env/stack.env', envSchema: readFileSync(materialized, 'utf-8') };
  }
  return {
    schemaPath: '',
    userEnvPath: 'knowledge/env/stack.env',
    envSchema: BUILTIN_ADDON_ENV_SCHEMAS[name] ?? '',
  };
}

export function listAvailableAddonIds(): string[] {
  return [...BUILTIN_ADDONS].sort();
}

export function listEnabledAddonIds(homeDir: string): string[] {
  const env = readStackEnv(join(homeDir, 'config', 'stack'));
  const enabled = new Set(parseEnabledAddons(env.OP_ENABLED_ADDONS));
  const profiles = new Set((env.COMPOSE_PROFILES ?? '').split(',').map((p) => p.trim()).filter(Boolean));
  for (const key of ['OP_VOICE_PROFILE', 'OP_OLLAMA_PROFILE']) {
    const profile = env[key]?.trim();
    if (profile) profiles.add(profile);
  }
  for (const profile of profiles) {
    const match = profile.match(/^addon\.([a-z0-9-]+)(?:\.|$)/);
    if (match?.[1]) enabled.add(match[1]);
  }
  return [...enabled].sort();
}

function readAddonServiceNamesFromContent(composeContent: string, composePath: string, addonName?: string): string[] {
  try {
    const parsed = parseYaml(composeContent);
    const services = parsed && typeof parsed === "object" ? (parsed as { services?: unknown }).services : undefined;
    if (!services || typeof services !== "object" || Array.isArray(services)) return [];
    const entries = Object.entries(services as Record<string, unknown>);
    if (!addonName) return entries.map(([name]) => name);
    return entries
      .filter(([serviceName, raw]) => {
        if (serviceName === 'guardian') return false;
        if (serviceName === addonName || serviceName.startsWith(`${addonName}-`)) return true;
        if (!raw || typeof raw !== 'object') return false;
        const profiles = (raw as { profiles?: unknown }).profiles;
        return Array.isArray(profiles) && profiles.some((p) => typeof p === 'string' && p.startsWith(`addon.${addonName}`));
      })
      .map(([serviceName]) => serviceName);
  } catch (error) {
    logger.warn("failed to parse addon compose services", {
      composePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function readAddonServiceNames(composePath: string, addonName?: string): string[] {
  if (!existsSync(composePath)) return [];
  return readAddonServiceNamesFromContent(readFileSync(composePath, "utf-8"), composePath, addonName);
}

export function getAddonServiceNames(homeDir: string, name: string): string[] {
  if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);

  const composeCandidates = [
    join(homeDir, "config", "stack", "channels.compose.yml"),
    join(homeDir, "config", "stack", "services.compose.yml"),
    join(homeDir, "config", "stack", "custom.compose.yml"),
  ];

  for (const composePath of composeCandidates) {
    const services = readAddonServiceNames(composePath, name);
    if (services.length > 0) return services;
  }

  for (const assetName of ["channels.compose.yml", "services.compose.yml", "custom.compose.yml"]) {
    const services = readAddonServiceNamesFromContent(readBundledStackAsset(assetName), `bundled:${assetName}`, name);
    if (services.length > 0) return services;
  }

  return [];
}

export type AddonProfile = {
  id: string;
  services: string[];
  label?: string;
  requires?: string;
  default?: boolean;
  /**
   * Whether the host can run this profile.
   *
   * Populated by `getAddonProfileAvailability()`. When the value is missing
   * (e.g. older catalogs), callers should treat the profile as available.
   */
  available?: boolean;
  /** Human-readable reason when `available === false`. */
  reason?: string;
};

// ── Host capability probes ─────────────────────────────────────────────

export type AddonProfileAvailability = { available: boolean; reason?: string };

const HOST_PROBE_TIMEOUT_MS = 2_000;

// Process-lifetime cache. Hardware presence does not change while the UI
// server is running, so probing once is enough.
const availabilityCache = new Map<string, AddonProfileAvailability>();

/**
 * Reset the host-capability cache. Test-only — not exported.
 */
function _resetAvailabilityCacheForTests(): void {
  availabilityCache.clear();
}

// Exported under a deliberately ugly name so test files can reach it.
export const __addonAvailabilityTestHooks = {
  reset: _resetAvailabilityCacheForTests,
  /**
   * Test-only: exposes the internal exec wrapper so tests can verify
   * ENOENT (missing binary) is surfaced as actionable stderr that the
   * docker-error translator can recognise.
   */
  execFileNoThrow: (cmd: string, args: string[], timeoutMs: number) =>
    execFileNoThrow(cmd, args, timeoutMs),
};

function execFileNoThrow(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      // ENOENT (binary missing) surfaces here with no stderr — child_process
      // never gets to exec the program. Inject a synthetic stderr that
      // matches the translateDockerError ENOENT regex so callers get
      // actionable copy instead of "unknown error (no stderr)".
      let mergedStderr = stderr?.toString() ?? '';
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code && !mergedStderr) {
        if (code === 'ENOENT') {
          mergedStderr = `spawn ${cmd} ENOENT: command not found`;
        } else {
          mergedStderr = `spawn ${cmd} ${code}`;
        }
      }
      resolve({
        ok: !error,
        stdout: stdout?.toString() ?? '',
        stderr: mergedStderr,
      });
    });
  });
}

/**
 * Compute the openpalm/voice image ref for a given GPU variant, matching
 * the substitution chain in the addon compose file:
 *   ${OP_IMAGE_NAMESPACE:-openpalm}/voice:${OP_VOICE_IMAGE_TAG:-latest-<variant>}
 *
 * Voice images are published OUT OF BAND (publish-voice.yml), decoupled from the
 * platform OP_IMAGE_TAG — they are heavy and rarely change. So the default is
 * the moving `latest-<variant>` voice tag; operators pin a specific build by
 * setting OP_VOICE_IMAGE_TAG (e.g. `v1.0.0-cpu`).
 */
function voiceImageRef(variant: 'cpu' | 'cu121' | 'rocm6'): string {
  const namespace = process.env.OP_IMAGE_NAMESPACE?.trim() || 'openpalm';
  const explicit = process.env.OP_VOICE_IMAGE_TAG?.trim();
  if (explicit) return `${namespace}/voice:${explicit}`;
  return `${namespace}/voice:latest-${variant}`;
}

/**
 * `docker manifest inspect <ref>` returns 0 only when the registry can
 * resolve a manifest for that ref. We use it as the cheap "is this image
 * actually published?" check — no pull required. The retry handles
 * transient registry hiccups. Timeout is short because the manifest blob
 * is a few KB.
 */
async function dockerManifestExists(imageRef: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await execFileNoThrow(
      'docker',
      ['manifest', 'inspect', imageRef],
      5_000,
    );
    if (res.ok) return true;
    // If docker itself is missing (ENOENT), retrying won't help.
    if (/ENOENT/.test(res.stderr)) return false;
  }
  return false;
}

async function probeCuda(): Promise<AddonProfileAvailability> {
  // Two acceptance signals:
  //   1. `docker info` reports an `nvidia` runtime (toolkit installed +
  //      `nvidia-ctk runtime configure --runtime=docker` was run).
  //   2. `/etc/cdi/nvidia.yaml` exists (CDI-mode daemon with a generated
  //      spec). We don't require the runtime in this case — the route's
  //      CDI fallback can switch the compose to driver:cdi.
  try {
    if (existsSync('/etc/cdi/nvidia.yaml')) return { available: true };
  } catch {
    // existsSync only throws on path-syntax issues; ignore and probe docker.
  }

  const result = await execFileNoThrow(
    'docker',
    ['info', '--format', '{{json .Runtimes}}'],
    HOST_PROBE_TIMEOUT_MS,
  );
  if (result.ok && result.stdout.includes('"nvidia"')) {
    return { available: true };
  }
  return {
    available: false,
    reason: 'NVIDIA runtime not registered. Install nvidia-container-toolkit or enable CDI.',
  };
}

async function probeRocm(): Promise<AddonProfileAvailability> {
  // Hardware gate: ROCm needs both the KFD char device and the GPU DRI nodes.
  let devicesPresent = false;
  try {
    devicesPresent = existsSync('/dev/kfd') && existsSync('/dev/dri');
  } catch {
    devicesPresent = false;
  }
  if (!devicesPresent) {
    return {
      available: false,
      reason: 'AMD ROCm devices not present on this host.',
    };
  }

  // Image gate: the openpalm/voice:*-rocm6 image isn't published yet, so
  // even on a fully-functional ROCm host the compose-up would fail with a
  // manifest-unknown pull error. Refuse the profile until the image lands.
  const imageRef = voiceImageRef('rocm6');
  const published = await dockerManifestExists(imageRef);
  if (!published) {
    return {
      available: false,
      reason: 'AMD ROCm image not published yet. Check back in a future release or use the CPU profile.',
    };
  }
  return { available: true };
}

/**
 * Probe the host for the capabilities required by an addon profile.
 *
 * Results are cached for the lifetime of the process — hardware doesn't
 * change while the UI server runs. All probes use execFile (no shell)
 * and never throw: errors collapse to `{ available: false, reason }`.
 *
 * Unknown profile ids default to `available: true` so unrelated addons
 * (e.g. a future "high-mem" profile that doesn't probe hardware) keep
 * working without code changes here.
 */
export async function getAddonProfileAvailability(
  profile: Pick<AddonProfile, 'id'>,
): Promise<AddonProfileAvailability> {
  const cacheKey = profile.id;
  const cached = availabilityCache.get(cacheKey);
  if (cached) return cached;

  let result: AddonProfileAvailability;
  try {
    const variant = resolveHardwareProfileVariant(profile.id);
    if (variant === 'cpu') {
      result = { available: true };
    } else if (variant === 'cuda') {
      result = await probeCuda();
    } else if (variant === 'rocm') {
      result = await probeRocm();
    } else {
      // Unknown profile id — assume available; caller is responsible for
      // labelling profiles that need host capability gating.
      result = { available: true };
    }
  } catch (err) {
    // Belt-and-braces: any unexpected throw collapses to unavailable.
    const reason = err instanceof Error ? err.message : String(err);
    result = { available: false, reason: `probe failed: ${reason}` };
  }

  availabilityCache.set(cacheKey, result);
  return result;
}

/**
 * Decorate a list of profiles with `available`/`reason` based on the host
 * capability probes. Returns a fresh array; does not mutate inputs.
 */
export async function annotateAddonProfileAvailability(
  profiles: AddonProfile[],
): Promise<AddonProfile[]> {
  const results = await Promise.all(
    profiles.map(async (p) => {
      const a = await getAddonProfileAvailability(p);
      const annotated: AddonProfile = { ...p, available: a.available };
      if (a.reason) annotated.reason = a.reason;
      return annotated;
    }),
  );
  return results;
}

function readAddonProfilesFromContent(composeContent: string, composePath: string): AddonProfile[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(composeContent);
  } catch (error) {
    logger.warn("failed to parse addon compose profiles", {
      composePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const services = parsed && typeof parsed === "object"
    ? (parsed as { services?: unknown }).services
    : undefined;
  if (!services || typeof services !== "object" || Array.isArray(services)) return [];

  const byProfile = new Map<string, AddonProfile>();
  for (const [svcName, svcRaw] of Object.entries(services as Record<string, unknown>)) {
    if (!svcRaw || typeof svcRaw !== "object") continue;
    const svc = svcRaw as { profiles?: unknown; labels?: unknown };
    if (!Array.isArray(svc.profiles)) continue;
    const profileIds = svc.profiles.filter((p): p is string => typeof p === "string");
    if (profileIds.length === 0) continue;

    const labels = readServiceLabels(svc.labels);
    const label = labels["openpalm.profile.label"];
    const requires = labels["openpalm.profile.requires"];
    const isDefault = labels["openpalm.profile.default"] === "true";

    for (const id of profileIds) {
      const existing = byProfile.get(id);
      if (existing) {
        existing.services.push(svcName);
        if (!existing.label && label) existing.label = label;
        if (!existing.requires && requires) existing.requires = requires;
        if (!existing.default && isDefault) existing.default = true;
      } else {
        const profile: AddonProfile = { id, services: [svcName] };
        if (label) profile.label = label;
        if (requires) profile.requires = requires;
        if (isDefault) profile.default = true;
        byProfile.set(id, profile);
      }
    }
  }

  return [...byProfile.values()];
}

function readAddonProfiles(composePath: string): AddonProfile[] {
  if (!existsSync(composePath)) return [];
  return readAddonProfilesFromContent(readFileSync(composePath, "utf-8"), composePath);
}

function readServiceLabels(raw: unknown): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const eq = entry.indexOf("=");
      if (eq < 0) continue;
      out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } else if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v == null) continue;
      out[k] = String(v);
    }
  }
  return out;
}

export function getAddonProfiles(homeDir: string, name: string): AddonProfile[] {
  if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);

  const composeCandidates = [
    join(homeDir, "config", "stack", "channels.compose.yml"),
    join(homeDir, "config", "stack", "services.compose.yml"),
    join(homeDir, "config", "stack", "custom.compose.yml"),
  ];

	const localOpenpalmDir = resolveLocalOpenpalmDir();
	if (localOpenpalmDir) {
		composeCandidates.push(join(localOpenpalmDir, 'config', 'stack', 'channels.compose.yml'));
		composeCandidates.push(join(localOpenpalmDir, 'config', 'stack', 'services.compose.yml'));
		composeCandidates.push(join(localOpenpalmDir, 'config', 'stack', 'custom.compose.yml'));
	}

  for (const composePath of composeCandidates) {
    const profiles = readAddonProfiles(composePath).filter((profile) => profile.id.startsWith(`addon.${name}`));
    if (profiles.length > 0) return profiles;
  }

  for (const assetName of ["channels.compose.yml", "services.compose.yml", "custom.compose.yml"]) {
    const profiles = readAddonProfilesFromContent(readBundledStackAsset(assetName), `bundled:${assetName}`)
      .filter((profile) => profile.id.startsWith(`addon.${name}`));
    if (profiles.length > 0) return profiles;
  }

  return [];
}

function profileEnvKey(name: string): string {
  if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);
  return `OP_${name.replace(/-/g, '_').toUpperCase()}_PROFILE`;
}

export function getAddonProfileSelection(stackDir: string, name: string): string | null {
  const env = readStackEnv(stackDir);
  const value = env[profileEnvKey(name)];
  const normalized = value ? canonicalAddonProfileSelection(name, value) : '';
  return normalized ? normalized : null;
}

export function setAddonProfileSelection(stackDir: string, name: string, profile: string, state?: ControlPlaneState): void {
  const trimmed = canonicalAddonProfileSelection(name, profile);
  if (!trimmed) throw new Error(`Invalid canonical profile id for addon ${name}: ${profile}`);
  patchSecretsEnvFile(stackDir, { [profileEnvKey(name)]: trimmed });
}

/** Add/remove an addon id in the OP_ENABLED_ADDONS list in stack.env. */
function setEnabledAddonState(stackDir: string, name: string, enabled: boolean): void {
  const current = new Set(parseEnabledAddons(readStackEnv(stackDir).OP_ENABLED_ADDONS));
  if (enabled) current.add(name);
  else current.delete(name);
  patchSecretsEnvFile(stackDir, { OP_ENABLED_ADDONS: [...current].sort().join(',') });
}

function enableAddon(homeDir: string, stackDir: string, name: string): MutationResult {
  try {
    if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);
    setEnabledAddonState(stackDir, name, true);
    if (name === 'ssh') patchSecretsEnvFile(stackDir, { OPENCODE_ENABLE_SSH: '1' });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function disableAddonByName(homeDir: string, stackDir: string, name: string): MutationResult {
  try {
    if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);
    setEnabledAddonState(stackDir, name, false);
    if (name === 'ssh') patchSecretsEnvFile(stackDir, { OPENCODE_ENABLE_SSH: '0' });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function setAddonEnabled(homeDir: string, stackDir: string, name: string, enabled: boolean, state?: ControlPlaneState): AddonMutationResult {
  if (!VALID_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid addon name: ${name}` };
  }

  if (!listAvailableAddonIds().includes(name)) {
    return { ok: false, error: `Addon "${name}" is not built in` };
  }

  const wasEnabled = listEnabledAddonIds(homeDir).includes(name);
  const services = getAddonServiceNames(homeDir, name);

  if (wasEnabled === enabled) {
    return {
      ok: true,
      enabled: wasEnabled,
      changed: false,
      services,
    };
  }

  const mutation = enabled ? enableAddon(homeDir, stackDir, name) : disableAddonByName(homeDir, stackDir, name);
  if (!mutation.ok) return mutation;

  if (enabled) {
    if (['api', 'chat', 'discord', 'slack'].includes(name)) {
      for (const channel of ['api', 'chat', 'discord', 'slack']) {
        ensureChannelSecret(stackDir, channel);
      }
    }

    // Pre-create (and chown) any host-side bind-mount targets the newly
    // enabled addon declares — e.g. ollama's data dir. Matches the install
    // path (applyInstall → ensureComposeVolumeTargets) so enabling an addon
    // post-install isn't more exposed than enabling it at install time
    // (issue #452). Guarded on `state` since callers may omit it.
    if (state) {
      ensureComposeVolumeTargets(state);
    }
  }


  return {
    ok: true,
    enabled,
    changed: true,
    services,
  };
}

export function installAutomationFromRegistry(name: string, stashDir: string): MutationResult {
  if (!VALID_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid automation name: ${name}` };
  }

  const taskContent = getRegistryAutomation(name);
  if (!taskContent) {
    return { ok: false, error: `Automation "${name}" not found in registry` };
  }

  const tasksDir = join(stashDir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });

  const ymlPath = join(tasksDir, `${name}.yml`);
  if (existsSync(ymlPath)) {
    return { ok: false, error: `Automation "${name}" is already installed` };
  }

  writeFileSync(ymlPath, taskContent);
  // The assistant container's 60-second akm tasks sync loop picks up the new
  // file from the shared stash mount and registers it with OS cron.
  return { ok: true };
}

export function uninstallAutomation(name: string, stashDir: string): MutationResult {
  if (!VALID_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid automation name: ${name}` };
  }

  const ymlPath = join(stashDir, 'tasks', `${name}.yml`);
  if (!existsSync(ymlPath)) {
    return { ok: false, error: `Automation "${name}" is not installed` };
  }

  rmSync(ymlPath, { force: true });
  // The assistant container's 60-second akm tasks sync will notice the file
  // is gone and deregister it from OS cron on next sync.
  return { ok: true };
}
