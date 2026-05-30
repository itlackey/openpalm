/**
 * Authoritative path resolution for the OpenPalm control plane.
 *
 * Every consumer imports from here instead of concatenating paths inline.
 * When the directory layout changes, update this file only.
 *
 * Layout:
 *   config/        — user-editable config + system config files (auth.json, akm/)
 *   config/stack/  — compose runtime + stack config (stack.env, stack.yml, fixed compose files)
 *   cache/         — regenerable/semi-persistent data (akm cache, guardian, rollback, logs, backups)
 *   state/         — persistent service data (assistant, admin, guardian, akm)
 *   stash/         — akm knowledge (skills, vaults, agents)
 *   workspace/     — shared work area
 */
import type { ControlPlaneState } from "./types.js";

// ── Config directory — user + system config ─────────────────────────────────

/** OpenCode auth token store */
export const authJsonPath          = (s: ControlPlaneState): string => `${s.configDir}/auth.json`;
/** akm setup config directory (AKM_CONFIG_DIR) */
export const akmConfigDir          = (s: ControlPlaneState): string => `${s.configDir}/akm`;
/** akm setup config file (written by admin on capability save) */
export const akmConfigPath         = (s: ControlPlaneState): string => `${s.configDir}/akm/config.json`;
export const tasksDir              = (s: ControlPlaneState): string => `${s.stashDir}/tasks`;
export const assistantConfigDir    = (s: ControlPlaneState): string => `${s.configDir}/assistant`;

// ── Config/stack directory — compose runtime + stack config ─────────────────

/** System env: non-secret runtime configuration */
export const stackEnvPath          = (s: ControlPlaneState): string => `${s.stackDir}/stack.env`;

// ── Cache directory — regenerable/semi-persistent ───────────────────────────

export const akmCacheDir           = (s: ControlPlaneState): string => `${s.cacheDir}/akm`;
export const guardianCacheDir      = (s: ControlPlaneState): string => `${s.cacheDir}/guardian`;
export const rollbackDir           = (s: ControlPlaneState): string => `${s.cacheDir}/rollback`;
export const logsDir               = (s: ControlPlaneState): string => `${s.cacheDir}/logs`;
/**
 * Guardian's own audit log of channel ingress (HMAC verify, replay, rate
 * limit). Phase 6 of the auth/proxy refactor removed the OpenPalm-side
 * `admin-audit.jsonl` — OpenCode session logs are the audit trail for
 * chat + tool activity.
 */
export const guardianAuditPath     = (s: ControlPlaneState): string => `${s.cacheDir}/logs/guardian-audit.log`;
/** One-shot 0.11.0 migration log (OP_UI_TOKEN → OPENCODE_SERVER_PASSWORD, endpoints.json move) */
export const migration0110LogPath  = (s: ControlPlaneState): string => `${s.cacheDir}/logs/migration-0.11.0.log`;
export const backupsDir            = (s: ControlPlaneState): string => `${s.cacheDir}/backups`;

// ── State directory — persistent service data ───────────────────────────────

export const assistantServiceDir   = (s: ControlPlaneState): string => `${s.stateDir}/assistant`;
export const adminServiceDir       = (s: ControlPlaneState): string => `${s.stateDir}/admin`;
export const guardianServiceDir    = (s: ControlPlaneState): string => `${s.stateDir}/guardian`;
export const guardianStashDir      = (s: ControlPlaneState): string => `${s.stateDir}/guardian/stash`;
export const guardianAkmDir        = (s: ControlPlaneState): string => `${s.stateDir}/guardian/akm`;
/** akm operational data (data/, state/ — NOT config, which lives in config/akm/) */
export const akmStateDir           = (s: ControlPlaneState): string => `${s.stateDir}/akm`;
export const taskLogDir            = (s: ControlPlaneState, id: string): string => `${s.cacheDir}/akm/tasks/logs/${id}`;
export const taskLogsRootDir       = (s: ControlPlaneState): string => `${s.cacheDir}/akm/tasks/logs`;
export const secretsDir            = (s: ControlPlaneState): string => `${s.stateDir}/secrets`;
export const secretProviderPath    = (s: ControlPlaneState): string => `${s.stateDir}/secrets/provider.json`;
export const secretsIndexPath      = (s: ControlPlaneState): string => `${s.stateDir}/secrets/plaintext-index.json`;
export const passStoreDir          = (s: ControlPlaneState): string => `${s.stateDir}/secrets/pass-store`;

// ── Stash directory ─────────────────────────────────────────────────────────

/** akm vault:user file — lives in the stash */
export const akmUserVaultPath      = (s: ControlPlaneState): string => `${s.stashDir}/vaults/user.env`;

// ── Stack directory ─────────────────────────────────────────────────────────

export const coreComposePath       = (s: ControlPlaneState): string => `${s.stackDir}/core.compose.yml`;
export const servicesComposePath   = (s: ControlPlaneState): string => `${s.stackDir}/services.compose.yml`;
export const channelsComposePath   = (s: ControlPlaneState): string => `${s.stackDir}/channels.compose.yml`;
export const customComposePath     = (s: ControlPlaneState): string => `${s.stackDir}/custom.compose.yml`;
export const addonComposePath      = (s: ControlPlaneState, name: string): string => `${s.stackDir}/addons/${name}/compose.yml`;
