/**
 * Authoritative path resolution for the OpenPalm control plane.
 *
 * Every consumer must import from here instead of concatenating paths inline.
 * When the directory layout changes, update this file only.
 */
import type { ControlPlaneState } from "./types.js";

// ── State directory ─────────────────────────────────────────────────────────

/** state/stack.env — system-managed config and secrets */
export const stackEnvPath          = (s: ControlPlaneState): string => `${s.stateDir}/stack.env`;
/** state/guardian.env — channel HMAC secrets */
export const guardianEnvPath       = (s: ControlPlaneState): string => `${s.stateDir}/guardian.env`;
/** state/auth.json — OpenCode auth token store */
export const authJsonPath          = (s: ControlPlaneState): string => `${s.stateDir}/auth.json`;
export const logsDir               = (s: ControlPlaneState): string => `${s.stateDir}/logs`;
export const adminAuditPath        = (s: ControlPlaneState): string => `${s.stateDir}/logs/admin-audit.jsonl`;
export const guardianAuditPath     = (s: ControlPlaneState): string => `${s.stateDir}/logs/guardian-audit.log`;
export const schedulerDir          = (s: ControlPlaneState): string => `${s.stateDir}/scheduler`;
export const schedulerTriggersDir  = (s: ControlPlaneState): string => `${s.stateDir}/scheduler/triggers`;
export const akmStateDir           = (s: ControlPlaneState): string => `${s.stateDir}/akm`;
export const akmConfigDir          = (s: ControlPlaneState): string => `${s.stateDir}/akm/config`;
/** Written by admin on capability save; read by akm in container via AKM_CONFIG_DIR mount */
export const akmConfigPath         = (s: ControlPlaneState): string => `${s.stateDir}/akm/config/config.json`;
export const akmCacheDir           = (s: ControlPlaneState): string => `${s.stateDir}/cache/akm`;
export const guardianCacheDir      = (s: ControlPlaneState): string => `${s.stateDir}/cache/guardian`;
export const rollbackDir           = (s: ControlPlaneState): string => `${s.stateDir}/cache/rollback`;
export const backupsDir            = (s: ControlPlaneState): string => `${s.stateDir}/backups`;
export const registryDir           = (s: ControlPlaneState): string => `${s.stateDir}/registry`;
export const registryAddonsDir     = (s: ControlPlaneState): string => `${s.stateDir}/registry/addons`;
export const registryAutomationsDir = (s: ControlPlaneState): string => `${s.stateDir}/registry/automations`;
export const secretsDir            = (s: ControlPlaneState): string => `${s.stateDir}/secrets`;
export const secretProviderPath    = (s: ControlPlaneState): string => `${s.stateDir}/secrets/provider.json`;
export const secretsIndexPath      = (s: ControlPlaneState): string => `${s.stateDir}/secrets/plaintext-index.json`;
export const passStoreDir          = (s: ControlPlaneState): string => `${s.stateDir}/secrets/pass-store`;

// ── Stash ───────────────────────────────────────────────────────────────────

/** akm vault:user file — always inside the stash */
export const akmUserVaultPath      = (s: ControlPlaneState): string => `${s.stashDir}/vaults/user.env`;

// ── Services ────────────────────────────────────────────────────────────────

export const assistantServiceDir   = (s: ControlPlaneState): string => `${s.servicesDir}/assistant`;
export const adminServiceDir       = (s: ControlPlaneState): string => `${s.servicesDir}/admin`;
export const guardianServiceDir    = (s: ControlPlaneState): string => `${s.servicesDir}/guardian`;
export const guardianStashDir      = (s: ControlPlaneState): string => `${s.servicesDir}/guardian/stash`;
export const guardianAkmDir        = (s: ControlPlaneState): string => `${s.servicesDir}/guardian/akm`;

// ── Config ──────────────────────────────────────────────────────────────────

export const stackSpecFilePath     = (s: ControlPlaneState): string => `${s.configDir}/stack.yml`;
export const automationsDir        = (s: ControlPlaneState): string => `${s.configDir}/automations`;
export const assistantConfigDir    = (s: ControlPlaneState): string => `${s.configDir}/assistant`;

// ── Stack ───────────────────────────────────────────────────────────────────

export const coreComposePath       = (s: ControlPlaneState): string => `${s.stackDir}/core.compose.yml`;
export const addonsStackDir        = (s: ControlPlaneState): string => `${s.stackDir}/addons`;
export const addonComposePath      = (s: ControlPlaneState, name: string): string => `${s.stackDir}/addons/${name}/compose.yml`;
