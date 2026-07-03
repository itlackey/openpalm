/**
 * Built-in addon/profile discovery helpers.
 *
 * Runtime addon enablement is recorded as OP_ENABLED_ADDONS in stack.env and
 * resolved to Compose profiles. The fixed compose files under config/stack are
 * the runtime source of truth.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '../logger.js';
import { resolveLocalOpenpalmDir } from './ui-assets.js';
import { ensurePortalSecret, ensureComposeVolumeTargets } from './config-persistence.js';
import { patchStateEnvFile, readStackEnv } from './secrets.js';
import { readBundledStackAsset, readBundledCustomCompose } from './core-assets.js';
import { canonicalAddonProfileSelection } from './profile-ids.js';
import { getAddonProfileAvailability } from './addon-availability.js';
import { parseEnabledAddons, removeEnvKey } from './env.js';
import type { ControlPlaneState } from './types.js';
import { resolveStashDir, composeFilePath, customComposeFilePath, stateEnvFile, legacyStackEnvFile } from './home.js';
import { BUILTIN_ADDON_ENV_SCHEMAS } from './addon-env-schemas.js';
import { BUILTIN_ADDON_IDS, PORTAL_SECRET_ADDON_IDS } from './addon-ids.js';

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
  const env = readStackEnv(homeDir);
  const available = new Set(BUILTIN_ADDON_IDS);
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
  return [...enabled].filter((name) => available.has(name)).sort();
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
    composeFilePath(homeDir, "portals.compose.yml"),
    composeFilePath(homeDir, "services.compose.yml"),
    customComposeFilePath(homeDir),
  ];

  for (const composePath of composeCandidates) {
    const services = readAddonServiceNames(composePath, name);
    if (services.length > 0) return services;
  }

  for (const assetName of ["portals.compose.yml", "services.compose.yml"]) {
    const services = readAddonServiceNamesFromContent(readBundledStackAsset(assetName), `bundled:${assetName}`, name);
    if (services.length > 0) return services;
  }
  const customServices = readAddonServiceNamesFromContent(readBundledCustomCompose(), 'bundled:custom.compose.yml', name);
  if (customServices.length > 0) return customServices;

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
    composeFilePath(homeDir, "portals.compose.yml"),
    composeFilePath(homeDir, "services.compose.yml"),
    customComposeFilePath(homeDir),
  ];

	const localOpenpalmDir = resolveLocalOpenpalmDir();
	if (localOpenpalmDir) {
		composeCandidates.push(composeFilePath(localOpenpalmDir, 'portals.compose.yml'));
		composeCandidates.push(composeFilePath(localOpenpalmDir, 'services.compose.yml'));
		composeCandidates.push(customComposeFilePath(localOpenpalmDir));
	}

  for (const composePath of composeCandidates) {
    const profiles = readAddonProfiles(composePath).filter((profile) => profile.id.startsWith(`addon.${name}`));
    if (profiles.length > 0) return profiles;
  }

  for (const assetName of ["portals.compose.yml", "services.compose.yml"]) {
    const profiles = readAddonProfilesFromContent(readBundledStackAsset(assetName), `bundled:${assetName}`)
      .filter((profile) => profile.id.startsWith(`addon.${name}`));
    if (profiles.length > 0) return profiles;
  }
  const customProfiles = readAddonProfilesFromContent(readBundledCustomCompose(), 'bundled:custom.compose.yml')
    .filter((profile) => profile.id.startsWith(`addon.${name}`));
  if (customProfiles.length > 0) return customProfiles;

  return [];
}

function profileEnvKey(name: string): string {
  if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);
  return `OP_${name.replace(/-/g, '_').toUpperCase()}_PROFILE`;
}

export function getAddonProfileSelection(homeDir: string, name: string): string | null {
  const env = readStackEnv(homeDir);
  const value = env[profileEnvKey(name)];
  const normalized = value ? canonicalAddonProfileSelection(name, value) : '';
  return normalized ? normalized : null;
}

export function setAddonProfileSelection(homeDir: string, name: string, profile: string): void {
  const trimmed = canonicalAddonProfileSelection(name, profile);
  if (!trimmed) throw new Error(`Invalid canonical profile id for addon ${name}: ${profile}`);
  patchStateEnvFile(homeDir, { [profileEnvKey(name)]: trimmed });
}

/** Add/remove one or more addon ids in the OP_ENABLED_ADDONS list (app-written → state/). */
function setEnabledAddonState(homeDir: string, name: string | string[], enabled: boolean): void {
  const names = Array.isArray(name) ? name : [name];
  const current = new Set(parseEnabledAddons(readStackEnv(homeDir).OP_ENABLED_ADDONS));
  for (const n of names) {
    if (enabled) current.add(n);
    else current.delete(n);
  }
  patchStateEnvFile(homeDir, { OP_ENABLED_ADDONS: [...current].sort().join(',') });
}

function enableAddon(homeDir: string, name: string): MutationResult {
  try {
    if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);
    setEnabledAddonState(homeDir, name, true);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function disableAddonByName(homeDir: string, name: string): MutationResult {
  try {
    if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);
    setEnabledAddonState(homeDir, name, false);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Env keys that only a now-removed built-in addon ever wrote. Stripped alongside
 * the addon id so upgraded installs don't carry the stale value forever.
 * `ssh` (OPENCODE_ENABLE_SSH) is the only removed addon that shipped an env key.
 */
const REMOVED_ADDON_ENV_KEYS = ['OPENCODE_ENABLE_SSH'] as const;

/** Remove a key from an env file if present. Returns whether the file changed. */
function removeEnvKeyFromFile(path: string, key: string): boolean {
  if (!existsSync(path)) return false;
  const before = readFileSync(path, 'utf-8');
  const after = removeEnvKey(before, key);
  if (after === before) return false;
  writeFileSync(path, after.endsWith('\n') || after.length === 0 ? after : `${after}\n`, { mode: 0o600 });
  return true;
}

/** Strip every removed-addon env key from both env files. Returns the keys removed. */
function removeRemovedAddonEnvKeys(homeDir: string): string[] {
  const removed = new Set<string>();
  for (const path of [stateEnvFile(homeDir), legacyStackEnvFile(homeDir)]) {
    for (const key of REMOVED_ADDON_ENV_KEYS) {
      if (removeEnvKeyFromFile(path, key)) removed.add(key);
    }
  }
  return [...removed];
}

/**
 * One-time cleanup of addon state left behind by addons that were removed from
 * BUILTIN_ADDON_IDS (currently `ssh`). On an upgraded install OP_ENABLED_ADDONS
 * can still list a removed addon — `resolveActiveProfiles` then emits its stale
 * `--profile addon.<id>` on every compose call — and a prior `openpalm addon
 * enable ssh` may have left OPENCODE_ENABLE_SSH in the env.
 *
 * Idempotent and skip-if-absent: strips any OP_ENABLED_ADDONS entry that is no
 * longer built in and drops the removed-addon env keys. A no-op that writes
 * nothing (`changed: false`) when the state is already clean, so it is safe to
 * run unconditionally on every reconcile — no version gate needed.
 */
export function pruneRemovedAddonState(
  homeDir: string,
): { changed: boolean; removedAddons: string[]; removedEnvKeys: string[] } {
  const builtin = new Set(BUILTIN_ADDON_IDS);
  const enabled = parseEnabledAddons(readStackEnv(homeDir).OP_ENABLED_ADDONS);
  const removedAddons = enabled.filter((id) => !builtin.has(id));

  if (removedAddons.length > 0) {
    setEnabledAddonState(homeDir, removedAddons, false);
  }

  const removedEnvKeys = removeRemovedAddonEnvKeys(homeDir);

  return {
    changed: removedAddons.length > 0 || removedEnvKeys.length > 0,
    removedAddons,
    removedEnvKeys,
  };
}

export function setAddonEnabled(homeDir: string, name: string, enabled: boolean, state?: ControlPlaneState): AddonMutationResult {
  if (!VALID_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid addon name: ${name}` };
  }

  if (!listAvailableAddonIds().includes(name)) {
    // Enabling an unknown addon is always rejected — validation is unchanged.
    if (enabled) {
      return { ok: false, error: `Addon "${name}" is not built in` };
    }
    // Disabling: allow cleanup of an addon that was removed from the built-in
    // set but still lingers in OP_ENABLED_ADDONS on an upgraded install, so a
    // stale entry can be stripped via CLI/UI rather than only by pruneRemovedAddonState.
    const lingering = parseEnabledAddons(readStackEnv(homeDir).OP_ENABLED_ADDONS).includes(name);
    if (!lingering) {
      return { ok: true, enabled: false, changed: false, services: [] };
    }
    setEnabledAddonState(homeDir, name, false);
    removeRemovedAddonEnvKeys(homeDir);
    return { ok: true, enabled: false, changed: true, services: [] };
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

  const mutation = enabled ? enableAddon(homeDir, name) : disableAddonByName(homeDir, name);
  if (!mutation.ok) return mutation;

  if (enabled) {
    if (PORTAL_SECRET_ADDON_IDS.includes(name)) {
      for (const portal of PORTAL_SECRET_ADDON_IDS) {
        ensurePortalSecret(homeDir, portal);
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
