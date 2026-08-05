/**
 * Built-in addon/profile discovery helpers.
 *
 * Runtime addon enablement is recorded as OP_ENABLED_ADDONS in stack.env and
 * resolved to Compose profiles. Managed files under system/stack plus the user
 * config/stack/custom.compose.yml overlay are the runtime source of truth.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { errMessage } from './errors.js';
import { join } from 'node:path';
import { parseComposeServices, type ComposeService } from './compose-services.js';
import { createLogger } from '../logger.js';
import { resolveLocalOpenpalmDir } from './ui-assets.js';
import { ensurePortalSecret, ensureComposeVolumeTargets } from './config-persistence.js';
import { patchStateEnvFile, readStackEnv } from './secrets.js';
import { readBundledStackAsset, readBundledCustomCompose } from './core-assets.js';
import { canonicalAddonProfileSelection } from './profile-ids.js';
import { getAddonProfileAvailability } from './addon-availability.js';
import { parseEnabledAddons, removeEnvKey } from './env.js';
import type { ControlPlaneState } from './types.js';
import { resolveStashDir, composeFilePath, customComposeFilePath, stackEnvFile } from './home.js';
import { BUILTIN_ADDON_ENV_SCHEMAS } from './addon-env-schemas.js';
import { BUILTIN_ADDON_IDS, GUARDIAN_INGRESS_ADDON_IDS, PORTAL_SECRET_ADDON_IDS } from './addon-ids.js';
import { applyRemoteAccess } from './remote-apply.js';
import { preparePaperclipAddon } from './paperclip.js';

const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const logger = createLogger('registry');

export type RegistryAddonConfig = {
  schemaPath: string;
  userEnvPath: string;
  envSchema: string;
};

type MutationResult = { ok: true } | { ok: false; error: string };
export type AddonMutationResult = (
  | {
      ok: true;
      enabled: boolean;
      changed: boolean;
      services: string[];
      /**
       * Set when the mutation succeeded but left something only the operator
       * can finish — today: enabling `remote` with a guardian target while no
       * guardian-ingress addon is enabled. Advisory; callers surface it and
       * carry on.
       */
      warning?: string;
    }
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
    userEnvPath: 'state/stack.env',
    envSchema: BUILTIN_ADDON_ENV_SCHEMAS[name] ?? '',
  };
}

export function listAvailableAddonIds(): string[] {
  return [...BUILTIN_ADDON_IDS].sort();
}

export function listEnabledAddonIds(homeDir: string): string[] {
  // OP_ENABLED_ADDONS is the SOLE source of addon enablement (plan 2.2). A
  // profile-var-only install (voice/ollama enabled purely by an OP_*_PROFILE
  // hardware pick, never named here) is reconciled into OP_ENABLED_ADDONS once
  // by migrateProfileOnlyAddonEnablement — this read no longer reverse-parses
  // profile vars.
  const env = readStackEnv(homeDir);
  const available = new Set(BUILTIN_ADDON_IDS);
  const enabled = new Set(parseEnabledAddons(env.OP_ENABLED_ADDONS));
  return [...enabled].filter((name) => available.has(name)).sort();
}

function readAddonServiceNamesFromContent(composeContent: string, composePath: string, addonName?: string): string[] {
  try {
    const services = parseComposeServices(composeContent);
    if (!addonName) return services.map((svc) => svc.name);
    return services
      .filter((svc) => {
        if (svc.name === addonName || svc.name.startsWith(`${addonName}-`)) return true;
        return svc.profiles.some((p) => p.startsWith(`addon.${addonName}`));
      })
      .map((svc) => svc.name);
  } catch (error) {
    logger.warn("failed to parse addon compose services", {
      composePath,
      error: errMessage(error),
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
  let services: ComposeService[];
  try {
    services = parseComposeServices(composeContent);
  } catch (error) {
    logger.warn("failed to parse addon compose profiles", {
      composePath,
      error: errMessage(error),
    });
    return [];
  }

  const byProfile = new Map<string, AddonProfile>();
  for (const svc of services) {
    if (svc.profiles.length === 0) continue;

    const labels = svc.labels;
    const label = labels["openpalm.profile.label"];
    const requires = labels["openpalm.profile.requires"];
    const isDefault = labels["openpalm.profile.default"] === "true";

    for (const id of svc.profiles) {
      const existing = byProfile.get(id);
      if (existing) {
        existing.services.push(svc.name);
        if (!existing.label && label) existing.label = label;
        if (!existing.requires && requires) existing.requires = requires;
        if (!existing.default && isDefault) existing.default = true;
      } else {
        const profile: AddonProfile = { id, services: [svc.name] };
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
    return { ok: false, error: errMessage(error) };
  }
}

function disableAddonByName(homeDir: string, name: string): MutationResult {
  try {
    if (!VALID_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);
    setEnabledAddonState(homeDir, name, false);
    // PR #564 second retest R6: clear the hardware-profile env key when disabling
    // a profile-bearing addon (voice/ollama). A lingering OP_VOICE_PROFILE /
    // OP_OLLAMA_PROFILE would otherwise be re-derived into OP_ENABLED_ADDONS by
    // migrateProfileOnlyAddonEnablement on the next reconcile — silently
    // re-enabling the addon the operator just disabled.
    const profileKey = profileEnvKey(name);
    if ((PROFILE_ONLY_ENV_KEYS as readonly string[]).includes(profileKey)) {
      removeEnvKeyFromFile(stackEnvFile(homeDir), profileKey);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/**
 * Retired env keys stripped from both env files on every reconcile so upgraded
 * installs don't carry stale values forever:
 *  - OPENCODE_ENABLE_SSH — written by the removed `ssh` addon.
 *  - OP_TTS_* / OP_STT_* — the pre-split host-side voice provider config
 *    (written by the retired writeVoiceVars / admin Voice tab). TTS/STT
 *    provider choice is a client-owned browser setting now; nothing reads
 *    these keys anymore.
 */
const RETIRED_ENV_KEYS = [
  'OPENCODE_ENABLE_SSH',
  'OP_TTS_ENGINE',
  'OP_TTS_PROVIDER',
  'OP_TTS_BASE_URL',
  'OP_TTS_MODEL',
  'OP_TTS_VOICE',
  'OP_STT_ENGINE',
  'OP_STT_PROVIDER',
  'OP_STT_BASE_URL',
  'OP_STT_MODEL',
  'OP_STT_LANGUAGE',
] as const;

/** Remove a key from an env file if present. Returns whether the file changed. */
function removeEnvKeyFromFile(path: string, key: string): boolean {
  if (!existsSync(path)) return false;
  const before = readFileSync(path, 'utf-8');
  const after = removeEnvKey(before, key);
  if (after === before) return false;
  writeFileSync(path, after.endsWith('\n') || after.length === 0 ? after : `${after}\n`, { mode: 0o600 });
  return true;
}

/**
 * Section-header comment lines that only retired keys ever lived under. Once
 * their keys are gone the header would advertise a section that no longer
 * exists, so the prune drops the exact line too (exact match keeps this
 * idempotent and unable to touch operator-authored comments).
 */
const RETIRED_ENV_SECTION_HEADERS = [
  '# ── Voice Channel (TTS/STT) ──────────────────────────────────────────',
] as const;

/** Remove an exact comment line from an env file if present. Returns whether the file changed. */
function removeEnvCommentLineFromFile(path: string, commentLine: string): boolean {
  if (!existsSync(path)) return false;
  const before = readFileSync(path, 'utf-8');
  const lines = before.split('\n');
  const out = lines.filter((line) => line.trim() !== commentLine);
  if (out.length === lines.length) return false;
  // Collapse a doubled blank line the deletion left behind (mirrors removeEnvKey).
  while (out.length > 1 && out[out.length - 1] === '' && out[out.length - 2] === '') out.pop();
  const after = out.join('\n');
  writeFileSync(path, after.endsWith('\n') || after.length === 0 ? after : `${after}\n`, { mode: 0o600 });
  return true;
}

/** Strip every retired env key (and orphaned section header) from the stack env. Returns the keys removed. */
function removeRetiredEnvKeys(homeDir: string): string[] {
  const removed = new Set<string>();
  const path = stackEnvFile(homeDir);
  for (const key of RETIRED_ENV_KEYS) {
    if (removeEnvKeyFromFile(path, key)) removed.add(key);
  }
  for (const header of RETIRED_ENV_SECTION_HEADERS) {
    removeEnvCommentLineFromFile(path, header);
  }
  return [...removed];
}

/**
 * One-time cleanup of addon state left behind by addons that were removed from
 * BUILTIN_ADDON_IDS (currently `ssh`). On an upgraded install OP_ENABLED_ADDONS
 * can still list a removed addon — `resolveActiveProfiles` then emits its stale
 * `--profile addon.<id>` on every compose call — plus retired env keys (see
 * RETIRED_ENV_KEYS) left by older releases.
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

  const removedEnvKeys = removeRetiredEnvKeys(homeDir);

  return {
    changed: removedAddons.length > 0 || removedEnvKeys.length > 0,
    removedAddons,
    removedEnvKeys,
  };
}

/**
 * Hardware-profile env keys that, before plan 2.2, implied an addon was enabled
 * even when OP_ENABLED_ADDONS never named it. Now read ONLY by the one-time
 * migration below — listEnabledAddonIds no longer reverse-parses them.
 */
const PROFILE_ONLY_ENV_KEYS = ['OP_VOICE_PROFILE', 'OP_OLLAMA_PROFILE'] as const;

/**
 * One-time upgrade guard (2.2, verification correction #4): an install that
 * enabled voice/ollama ONLY by picking a hardware profile — never through
 * OP_ENABLED_ADDONS — used to have its addon enablement derived at READ time by
 * a reverse-parse in listEnabledAddonIds. That reverse-parse is now deleted (a
 * single source of truth), so this migration persists the derived addon id into
 * OP_ENABLED_ADDONS; without it such an install would silently lose the addon.
 *
 * Idempotent and skip-if-already-enabled, so it is safe to run on every
 * reconcile (mirrors pruneRemovedAddonState): write the derived addon id into
 * OP_ENABLED_ADDONS (app-written → state/) whenever a profile var names one
 * that isn't already listed.
 */
export function migrateProfileOnlyAddonEnablement(
  homeDir: string,
): { changed: boolean; migratedAddons: string[] } {
  const env = readStackEnv(homeDir);
  const enabled = new Set(parseEnabledAddons(env.OP_ENABLED_ADDONS));
  const missing = new Set<string>();
  for (const key of PROFILE_ONLY_ENV_KEYS) {
    const profile = env[key]?.trim();
    if (!profile) continue;
    const match = profile.match(/^addon\.([a-z0-9-]+)(?:\.|$)/);
    const addonId = match?.[1];
    if (addonId && !enabled.has(addonId)) missing.add(addonId);
  }

  if (missing.size === 0) return { changed: false, migratedAddons: [] };

  const migratedAddons = [...missing].sort();
  setEnabledAddonState(homeDir, migratedAddons, true);
  return { changed: true, migratedAddons };
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
    removeRetiredEnvKeys(homeDir);
    return { ok: true, enabled: false, changed: true, services: [] };
  }

  const wasEnabled = listEnabledAddonIds(homeDir).includes(name);
  const services = getAddonServiceNames(homeDir, name);

  if (wasEnabled === enabled) {
    if (name === 'remote') {
      const applied = applyRemoteAccess(homeDir);
      if (applied.error) {
        return {
          ok: false,
          error: `Addon "${name}" was recorded as ${enabled ? 'enabled' : 'disabled'}, but its remote access config could not be written: ${applied.error}`,
        };
      }
      return {
        ok: true,
        enabled: wasEnabled,
        changed: false,
        services: [...new Set([...services, ...applied.services])],
        ...(applied.warning ? { warning: applied.warning } : {}),
      };
    }
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
    // Seed EVERY portal principal secret, not just this addon's: enabling any
    // guardian-ingress addon deploys the guardian, and portals.compose.yml
    // grants it all four as file secrets, so all four files must exist. (This
    // is also seeded unconditionally by `ensureSecrets` on every deploy; the
    // call here covers enabling an addon between deploys.)
    if (GUARDIAN_INGRESS_ADDON_IDS.includes(name)) {
      for (const portal of PORTAL_SECRET_ADDON_IDS) ensurePortalSecret(homeDir, portal);
    }

    // Same shape, same reason, as the portal secrets above: services.compose.yml
    // declares paperclip's env_file, and Compose fails the WHOLE project — even
    // `config` — when a profile-active service's env_file is missing. Also
    // seeded unconditionally by `ensureSecrets`; this call covers enabling
    // between deploys.
    if (name === 'paperclip') {
      try {
        preparePaperclipAddon(homeDir);
      } catch (error) {
        return { ok: false, error: errMessage(error) };
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


  // `remote` is the one built-in whose enablement is not fully expressed by
  // flipping its Compose profile: the `tunnel` container serves a GENERATED
  // document (state/remote/serve.json), so recording the addon and starting
  // the container is not an apply — without this the container would come up
  // reading the PREVIOUS document, i.e. enable would report success while
  // serving nothing, and disable would leave a live (possibly Funnel-public)
  // document on disk.
  //
  // Runs HERE, in the shared toggle, rather than in each caller, so the CLI,
  // the UI route, and the wizard cannot diverge — and runs BEFORE the caller
  // starts or stops any container, which is what makes disable fail-CLOSED:
  // the empty document is already on disk, so a `compose stop` that fails
  // afterwards cannot leave the tunnel publicly serving.
  let warning: string | undefined;
  let applyServices: string[] = [];
  if (name === 'remote') {
    const applied = applyRemoteAccess(homeDir);
    if (applied.error) {
      // The enablement write above already landed, so this is a partial
      // apply, not a no-op — say so rather than reporting plain success.
      // Re-running the same toggle re-runs this apply.
      return {
        ok: false,
        error: `Addon "${name}" was recorded as ${enabled ? 'enabled' : 'disabled'}, but its remote access config could not be written: ${applied.error}`,
      };
    }
    warning = applied.warning;
    applyServices = applied.services;
  }

  return {
    ok: true,
    enabled,
    changed: true,
    // `guardian` joins the list when the apply flipped GUARDIAN_DIRECT_INGRESS
    // — that variable is read by the guardian's own listener at start, so
    // recreating only `tunnel` would point the new proxy at a 404.
    services: [...new Set([...services, ...applyServices])],
    ...(warning ? { warning } : {}),
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
