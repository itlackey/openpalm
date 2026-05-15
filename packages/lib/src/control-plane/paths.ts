/**
 * Authoritative path resolution for the OpenPalm control plane.
 *
 * Every consumer imports from here instead of concatenating paths inline.
 * When the directory layout changes, update this file only.
 *
 * Layout:
 *   config/   — user-editable config + system config files (stack.env, auth.json, akm/)
 *   cache/    — regenerable/semi-persistent data (akm cache, guardian cache, rollback)
 *   state/    — persistent service data (assistant, admin, guardian, logs, backups, registry)
 *   stash/    — akm knowledge (skills, vaults, agents)
 *   workspace/ — shared work area
 *   stack/    — compose runtime (addon overlays)
 */
import type { ControlPlaneState } from "./types.js";

// ── Config directory — user + system config ─────────────────────────────────

/** System env: capabilities, secrets, tokens */
export const stackEnvPath          = (s: ControlPlaneState): string => `${s.configDir}/stack.env`;
/** Guardian HMAC channel secrets */
export const guardianEnvPath       = (s: ControlPlaneState): string => `${s.configDir}/guardian.env`;
/** OpenCode auth token store */
export const authJsonPath          = (s: ControlPlaneState): string => `${s.configDir}/auth.json`;
/** akm setup config directory (AKM_CONFIG_DIR) */
export const akmConfigDir          = (s: ControlPlaneState): string => `${s.configDir}/akm`;
/** akm setup config file (written by admin on capability save) */
export const akmConfigPath         = (s: ControlPlaneState): string => `${s.configDir}/akm/config.json`;
export const stackSpecFilePath     = (s: ControlPlaneState): string => `${s.configDir}/stack.yml`;
export const automationsDir        = (s: ControlPlaneState): string => `${s.configDir}/automations`;
export const assistantConfigDir    = (s: ControlPlaneState): string => `${s.configDir}/assistant`;

// ── Cache directory — regenerable/semi-persistent ───────────────────────────

export const akmCacheDir           = (s: ControlPlaneState): string => `${s.cacheDir}/akm`;
export const guardianCacheDir      = (s: ControlPlaneState): string => `${s.cacheDir}/guardian`;
export const rollbackDir           = (s: ControlPlaneState): string => `${s.cacheDir}/rollback`;

// ── State directory — persistent service data ───────────────────────────────

export const assistantServiceDir   = (s: ControlPlaneState): string => `${s.stateDir}/assistant`;
export const adminServiceDir       = (s: ControlPlaneState): string => `${s.stateDir}/admin`;
export const guardianServiceDir    = (s: ControlPlaneState): string => `${s.stateDir}/guardian`;
export const guardianStashDir      = (s: ControlPlaneState): string => `${s.stateDir}/guardian/stash`;
export const guardianAkmDir        = (s: ControlPlaneState): string => `${s.stateDir}/guardian/akm`;
/** Shared akm operational data (data/, state/ — NOT config, which lives in config/akm/) */
export const akmStateDir           = (s: ControlPlaneState): string => `${s.stateDir}/akm`;
export const schedulerDir          = (s: ControlPlaneState): string => `${s.stateDir}/scheduler`;
export const schedulerTriggersDir  = (s: ControlPlaneState): string => `${s.stateDir}/scheduler/triggers`;
export const logsDir               = (s: ControlPlaneState): string => `${s.stateDir}/logs`;
export const adminAuditPath        = (s: ControlPlaneState): string => `${s.stateDir}/logs/admin-audit.jsonl`;
export const guardianAuditPath     = (s: ControlPlaneState): string => `${s.stateDir}/logs/guardian-audit.log`;
export const backupsDir            = (s: ControlPlaneState): string => `${s.stateDir}/backups`;
export const registryDir           = (s: ControlPlaneState): string => `${s.stateDir}/registry`;
export const registryAddonsDir     = (s: ControlPlaneState): string => `${s.stateDir}/registry/addons`;
export const registryAutomationsDir = (s: ControlPlaneState): string => `${s.stateDir}/registry/automations`;
export const secretsDir            = (s: ControlPlaneState): string => `${s.stateDir}/secrets`;
export const secretProviderPath    = (s: ControlPlaneState): string => `${s.stateDir}/secrets/provider.json`;
export const secretsIndexPath      = (s: ControlPlaneState): string => `${s.stateDir}/secrets/plaintext-index.json`;
export const passStoreDir          = (s: ControlPlaneState): string => `${s.stateDir}/secrets/pass-store`;

// ── Stash directory ─────────────────────────────────────────────────────────

/** akm vault:user file — lives in the stash */
export const akmUserVaultPath      = (s: ControlPlaneState): string => `${s.stashDir}/vaults/user.env`;

// ── Stack directory ─────────────────────────────────────────────────────────

export const coreComposePath       = (s: ControlPlaneState): string => `${s.stackDir}/core.compose.yml`;
export const addonsStackDir        = (s: ControlPlaneState): string => `${s.stackDir}/addons`;
export const addonComposePath      = (s: ControlPlaneState, name: string): string => `${s.stackDir}/addons/${name}/compose.yml`;
