/**
 * Authoritative path resolution for the OpenPalm control plane.
 *
 * Every consumer imports from here instead of concatenating paths inline.
 * When the directory layout changes, update this file only.
 *
 * Layout:
 *   config/        — user-editable config + system config files (akm/)
 *   config/stack/  — fixed compose files only (stack.env, secrets, auth.json live under knowledge/; no stack.yml)
 *   data/          — persistent service data, logs, backups, rollback
 *   knowledge/     — akm knowledge (skills, env, secrets, agents)
 *   workspace/     — shared work area
 */
import { dirname, basename } from "node:path";
import type { ControlPlaneState } from "./types.js";

// ── Config directory — user + system config ─────────────────────────────────

/**
 * OpenCode auth token store. Provider credentials are sensitive, so they live
 * under knowledge/secrets/ (out of config/stack/) and are bind-mounted into
 * every OpenCode-based container (assistant + guardian).
 */
export const authJsonPath          = (s: ControlPlaneState): string => `${s.stashDir}/secrets/auth.json`;
/** akm config directory mounted at /etc/akm */
export const akmConfigDir          = (s: ControlPlaneState): string => `${s.configDir}/akm`;
/** akm setup config file (written by the admin UI AKM action and CLI install) */
export const akmConfigPath         = (s: ControlPlaneState): string => `${s.configDir}/akm/config.json`;
export const tasksDir              = (s: ControlPlaneState): string => `${s.stashDir}/tasks`;
export const assistantConfigDir    = (s: ControlPlaneState): string => `${s.configDir}/assistant`;
/** Guardian OpenCode global config dir — bind-mounted at /etc/opencode */
export const guardianConfigDir     = (s: ControlPlaneState): string => `${s.configDir}/guardian`;

// ── Config/stack directory — compose runtime + stack config ─────────────────

/**
 * System env: non-secret runtime configuration (the Compose `--env-file`).
 * Lives under knowledge/env/ alongside the user env file (akm `env:stack`).
 */
export const stackEnvPath          = (s: ControlPlaneState): string => `${s.stashDir}/env/stack.env`;
/**
 * Resolve the OP_HOME root from a stackDir. Normally `<home>/config/stack`;
 * falls back to the stackDir itself for callers/tests that pass a home-shaped
 * dir. Mirrors `resolveHomeDirFromStackDir` in secrets-files.ts so the env and
 * secret dirs resolve consistently from the same input.
 */
const homeFromStackDir = (stackDir: string): string =>
  basename(stackDir) === "stack" && basename(dirname(stackDir)) === "config"
    ? dirname(dirname(stackDir))
    : stackDir;

/**
 * Same as `stackEnvPath` but resolved from a `stackDir` for the few callers
 * that only have the stack dir, not full state.
 */
export const stackEnvPathFromStackDir = (stackDir: string): string => `${homeFromStackDir(stackDir)}/knowledge/env/stack.env`;

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
export const backupsDir            = (s: ControlPlaneState): string => `${s.dataDir}/backups`;

// ── State directory — persistent service data ───────────────────────────────

export const assistantServiceDir   = (s: ControlPlaneState): string => `${s.dataDir}/assistant`;
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
// The akm env:user file path (`knowledge/env/user.env`) is owned by
// `akm-user-env.ts` (`userEnvPathSync`), which also handles its read/write and
// legacy migration — kept there rather than duplicated as a bare path here.

// ── Stack directory ─────────────────────────────────────────────────────────

export const coreComposePath       = (s: ControlPlaneState): string => `${s.stackDir}/core.compose.yml`;
export const servicesComposePath   = (s: ControlPlaneState): string => `${s.stackDir}/services.compose.yml`;
export const channelsComposePath   = (s: ControlPlaneState): string => `${s.stackDir}/channels.compose.yml`;
export const customComposePath     = (s: ControlPlaneState): string => `${s.stackDir}/custom.compose.yml`;
