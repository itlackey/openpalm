/**
 * Authoritative path resolution for the OpenPalm control plane.
 *
 * Every consumer imports from here instead of concatenating paths inline.
 * When the directory layout changes, update this file only.
 *
 * Layout:
 *   config/        — user-editable config + system config files (akm/)
 *   config/stack/  — compose runtime + stack config (stack.env, stack.yml, auth.json, fixed compose files)
 *   data/          — persistent service data, logs, backups, rollback
 *   knowledge/     — akm knowledge (skills, env, secrets, agents)
 *   workspace/     — shared work area
 */
import type { ControlPlaneState } from "./types.js";

// ── Config directory — user + system config ─────────────────────────────────

/**
 * OpenCode auth token store. Lives under config/stack/ so it is shared by
 * every OpenCode-based container (assistant + guardian) via a single mount.
 */
export const authJsonPath          = (s: ControlPlaneState): string => `${s.stackDir}/auth.json`;
/** akm config directory mounted at /etc/akm */
export const akmConfigDir          = (s: ControlPlaneState): string => `${s.configDir}/akm`;
/** akm setup config file (written by admin on capability save) */
export const akmConfigPath         = (s: ControlPlaneState): string => `${s.configDir}/akm/config.json`;
export const tasksDir              = (s: ControlPlaneState): string => `${s.stashDir}/tasks`;
export const assistantConfigDir    = (s: ControlPlaneState): string => `${s.configDir}/assistant`;
/** Guardian OpenCode global config dir — bind-mounted at /etc/opencode */
export const guardianConfigDir     = (s: ControlPlaneState): string => `${s.configDir}/guardian`;

// ── Config/stack directory — compose runtime + stack config ─────────────────

/** System env: non-secret runtime configuration */
export const stackEnvPath          = (s: ControlPlaneState): string => `${s.stackDir}/stack.env`;

// ── Operational state directories ───────────────────────────────────────────

export const akmCacheDir           = (s: ControlPlaneState): string => `${s.dataDir}/akm/cache`;
export const rollbackDir           = (s: ControlPlaneState): string => `${s.dataDir}/rollback`;
export const logsDir               = (s: ControlPlaneState): string => `${s.dataDir}/logs`;
/**
 * Guardian's own audit log of channel ingress (HMAC verify, replay, rate
 * limit). Phase 6 of the auth/proxy refactor removed the OpenPalm-side
 * `admin-audit.jsonl` — OpenCode session logs are the audit trail for
 * chat + tool activity.
 */
export const guardianAuditPath     = (s: ControlPlaneState): string => `${s.dataDir}/logs/guardian-audit.log`;
/** One-shot 0.11.0 migration log (OP_UI_TOKEN → OPENCODE_SERVER_PASSWORD, endpoints.json move) */
export const migration0110LogPath  = (s: ControlPlaneState): string => `${s.dataDir}/logs/migration-0.11.0.log`;
export const backupsDir            = (s: ControlPlaneState): string => `${s.dataDir}/backups`;

// ── State directory — persistent service data ───────────────────────────────

export const assistantServiceDir   = (s: ControlPlaneState): string => `${s.dataDir}/assistant`;
export const adminServiceDir       = (s: ControlPlaneState): string => `${s.dataDir}/admin`;
export const guardianServiceDir    = (s: ControlPlaneState): string => `${s.dataDir}/guardian`;
export const guardianAkmDir        = (s: ControlPlaneState): string => `${s.dataDir}/guardian/akm`;
/** akm durable data — NOT config, which lives in config/akm/ */
export const akmDataDir            = (s: ControlPlaneState): string => `${s.dataDir}/akm/data`;
export const taskLogDir            = (s: ControlPlaneState, id: string): string => `${s.dataDir}/akm/cache/tasks/logs/${id}`;
export const taskLogsRootDir       = (s: ControlPlaneState): string => `${s.dataDir}/akm/cache/tasks/logs`;
export const secretsDir            = (s: ControlPlaneState): string => `${s.dataDir}/secrets`;
export const secretProviderPath    = (s: ControlPlaneState): string => `${s.dataDir}/secrets/provider.json`;
export const secretsIndexPath      = (s: ControlPlaneState): string => `${s.dataDir}/secrets/plaintext-index.json`;
export const passStoreDir          = (s: ControlPlaneState): string => `${s.dataDir}/secrets/pass-store`;

// ── Knowledge directory ─────────────────────────────────────────────────────

/** akm env:user file — lives in the knowledge dir */
export const akmUserEnvPath        = (s: ControlPlaneState): string => `${s.stashDir}/env/user.env`;

// ── Stack directory ─────────────────────────────────────────────────────────

export const coreComposePath       = (s: ControlPlaneState): string => `${s.stackDir}/core.compose.yml`;
export const servicesComposePath   = (s: ControlPlaneState): string => `${s.stackDir}/services.compose.yml`;
export const channelsComposePath   = (s: ControlPlaneState): string => `${s.stackDir}/channels.compose.yml`;
export const customComposePath     = (s: ControlPlaneState): string => `${s.stackDir}/custom.compose.yml`;
export const addonComposePath      = (s: ControlPlaneState, name: string): string => `${s.stackDir}/addons/${name}/compose.yml`;
