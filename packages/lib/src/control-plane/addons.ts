/**
 * Built-in addon/profile discovery helpers.
 *
 * Runtime addon enablement is recorded as OP_ENABLED_ADDONS in stack.env and
 * resolved to Compose profiles. The fixed compose files under config/stack are
 * the runtime source of truth.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '../logger.js';
import { resolveLocalOpenpalmDir } from './ui-assets.js';
import { ensurePortalSecret, ensureComposeVolumeTargets } from './config-persistence.js';
import { patchSecretsEnvFile, readStackEnv } from './secrets.js';
import { readBundledStackAsset } from './core-assets.js';
import { canonicalAddonProfileSelection, resolveHardwareProfileVariant } from './profile-ids.js';
import { parseEnabledAddons } from './env.js';
import type { ControlPlaneState } from './types.js';
import { resolveStashDir } from './home.js';
import { BUILTIN_ADDON_ENV_SCHEMAS } from './addon-env-schemas.js';
import { BUILTIN_ADDON_IDS } from './addon-ids.js';

const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const logger = createLogger('registry');

export type RegistryAddonConfig = {
  schemaPath: string;
  userEnvPath: string;
  envSchema: string;
};

type MutationResult = { ok: true } | { ok: false; error: string };
export type AddonMutationResult = (
  | { ok: true; enabled: boolean; changed: boolean; services: string[] }
  | { ok: false; error: string }
);

export function getRegistryAutomation(name: string): string | null {
  if (!VALID_NAME_RE.test(name)) return null;
  const localOpenpalmDir = resolveLocalOpenpalmDir();
  const candidates = [
    localOpenpalmDir ? join(localOpenpalmDir, 'knowledge', 'tasks', `${name}.yml`) : '',
    join(resolveStashDir(), 'tasks', `${name}.yml`),
  ].filter(Boolean);
  for (const ymlPath of candidates) {
    if (existsSync(ymlPath)) return readFileSync(ymlPath, 'utf-8');
  }
  return null;
}

export function getRegistryAddonConfig(name: string): RegistryAddonConfig {
  if (!VALID_NAME_RE.test(name)) {
    throw new Error(`Invalid addon name: ${name}`);
  }
  return {
    schemaPath: '',
    userEnvPath: 'knowledge/env/stack.env',
    envSchema: BUILTIN_ADDON_ENV_SCHEMAS[name] ?? '',
  };
}

export function listAvailableAddonIds(): string[] {
  return [...BUILTIN_ADDON_IDS].sort();
}

export function listEnabledAddonIds(homeDir: string): string[] {
  const env = readStackEnv(join(homeDir, 'config', 'stack'));
  const enabled = new Set(parseEnabledAddons(env.OP_ENABLED_ADDONS));
  const profiles = new Set<string>();
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
    join(homeDir, "config", "stack", "portals.compose.yml"),
    join(homeDir, "config", "stack", "services.compose.yml"),
    join(homeDir, "config", "stack", "custom.compose.yml"),
  ];

  for (const composePath of composeCandidates) {
    const services = readAddonServiceNames(composePath, name);
    if (services.length > 0) return services;
  }

  for (const assetName of ["portals.compose.yml", "services.compose.yml", "custom.compose.yml"]) {
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
 *   ${OP_IMAGE_NAMESPACE:-openpalm}/voice:${OP_VOICE_VERSION:-latest-<variant>}
 *
 * Voice images are published OUT OF BAND (publish-voice.yml), decoupled from the
 * other service images — they are heavy and rarely change. So the default is the
 * moving `latest-<variant>` voice tag; operators pin a specific build by setting
 * OP_VOICE_VERSION (e.g. `v1.0.0-cpu`). A bare `latest` (the seeded default) is
 * treated as "unset" so the GPU-variant default still applies.
 */
function voiceImageRef(variant: 'cpu' | 'cu121' | 'rocm6'): string {
  const namespace = process.env.OP_IMAGE_NAMESPACE?.trim() || 'openpalm';
  const explicit = process.env.OP_VOICE_VERSION?.trim();
  if (explicit && explicit !== 'latest') return `${namespace}/voice:${explicit}`;
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
    join(homeDir, "config", "stack", "portals.compose.yml"),
    join(homeDir, "config", "stack", "services.compose.yml"),
    join(homeDir, "config", "stack", "custom.compose.yml"),
  ];

	const localOpenpalmDir = resolveLocalOpenpalmDir();
	if (localOpenpalmDir) {
		composeCandidates.push(join(localOpenpalmDir, 'config', 'stack', 'portals.compose.yml'));
		composeCandidates.push(join(localOpenpalmDir, 'config', 'stack', 'services.compose.yml'));
		composeCandidates.push(join(localOpenpalmDir, 'config', 'stack', 'custom.compose.yml'));
	}

  for (const composePath of composeCandidates) {
    const profiles = readAddonProfiles(composePath).filter((profile) => profile.id.startsWith(`addon.${name}`));
    if (profiles.length > 0) return profiles;
  }

  for (const assetName of ["portals.compose.yml", "services.compose.yml", "custom.compose.yml"]) {
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

export function setAddonProfileSelection(stackDir: string, name: string, profile: string): void {
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

function enableAddon(stackDir: string, name: string): MutationResult {
  try {
    if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);
    setEnabledAddonState(stackDir, name, true);
    if (name === 'ssh') patchSecretsEnvFile(stackDir, { OPENCODE_ENABLE_SSH: '1' });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function disableAddonByName(stackDir: string, name: string): MutationResult {
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

  const mutation = enabled ? enableAddon(stackDir, name) : disableAddonByName(stackDir, name);
  if (!mutation.ok) return mutation;

  if (enabled) {
    if (['api', 'chat', 'discord', 'slack'].includes(name)) {
      for (const portal of ['api', 'chat', 'discord', 'slack']) {
        ensurePortalSecret(stackDir, portal);
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
