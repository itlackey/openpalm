/**
 * Authoritative path resolution for the OpenPalm control plane.
 *
 * Every consumer imports from here instead of concatenating paths inline.
 * When the directory layout changes, update this file only.
 *
 * Layout (four-tree ownership):
 *   config/        — user-editable config + system config files (akm/)
 *   config/stack/  — USER custom.compose.yml overlay ONLY (seeded once, never overwritten)
 *   system/stack/  — MANAGED fixed compose files (core/services/portals), overwritten on reconcile
 *   data/          — persistent service data, logs, backups, rollback
 *   knowledge/     — akm knowledge (skills, user env, secrets, agents); secrets + auth.json live here
 *   state/         — app-written records: the stack env file, pins, host identity, schema version
 *   workspace/     — shared work area
 */

import type { ControlPlaneState } from "./types.js";
import { stackEnvFile } from "./home.js";

/**
 * Guard every root segment before interpolating it.
 *
 * Each builder below interpolates one root segment of the state. If that field
 * is missing, template interpolation yields the literal "undefined" and the
 * result is a
 * *relative* path — so a caller that meant to write `auth.json` into OP_HOME
 * silently writes it under the process's current working directory instead.
 * The type says these fields are always set, but `as ControlPlaneState` casts in
 * tests bypass that, and it has been writing real credential files into the repo
 * root. Fail loudly instead of writing to the wrong place.
 */
function req(value: string | undefined, field: string): string {
  if (!value) throw new Error(`ControlPlaneState.${field} is required to resolve this path`);
  return value;
}

// ── Config directory — user + system config ─────────────────────────────────

/**
 * OpenCode auth token store. Provider credentials are sensitive, so they live
 * under knowledge/secrets/ (out of config/stack/). Assistant receives a bind
 * mount; Guardian receives the same file as a named Compose secret.
 */
export const authJsonPath          = (s: ControlPlaneState): string => `${req(s.stashDir, "stashDir")}/secrets/auth.json`;
/** akm config directory mounted at /etc/akm */
export const akmConfigDir          = (s: ControlPlaneState): string => `${req(s.configDir, "configDir")}/akm`;
/** akm setup config file (written by the admin UI AKM action and CLI install) */
export const akmConfigPath         = (s: ControlPlaneState): string => `${req(s.configDir, "configDir")}/akm/config.json`;
export const tasksDir              = (s: ControlPlaneState): string => `${req(s.stashDir, "stashDir")}/tasks`;
export const assistantConfigDir    = (s: ControlPlaneState): string => `${req(s.configDir, "configDir")}/assistant`;
/** Guardian OpenCode global config dir — bind-mounted at /etc/opencode */
export const guardianConfigDir     = (s: ControlPlaneState): string => `${req(s.configDir, "configDir")}/guardian`;

// ── Config/stack directory — compose runtime + stack config ─────────────────

/**
 * The single non-secret Compose `--env-file`. Lives in the app-written state/
 * tree — see home.ts `stackEnvFile`, which this delegates to so the location is
 * defined exactly once.
 */
export const stackEnvPath          = (s: ControlPlaneState): string => stackEnvFile(req(s.homeDir, "homeDir"));
// (Removed homeFromStackDir + stackEnvPathFromStackDir — the path-reverse-engineering
//  twin of resolveHomeDirFromStackDir. Callers now take homeDir and use
//  home.ts `stackEnvFile(homeDir)` directly.)

// ── Operational state directories ───────────────────────────────────────────

export const akmCacheDir           = (s: ControlPlaneState): string => `${req(s.dataDir, "dataDir")}/akm/cache`;
export const rollbackDir           = (s: ControlPlaneState): string => `${req(s.dataDir, "dataDir")}/rollback`;
export const logsDir               = (s: ControlPlaneState): string => `${req(s.dataDir, "dataDir")}/logs`;
/**
 * Guardian's own audit log of portal ingress (HMAC verify, replay, rate
 * limit). Phase 6 of the auth/proxy refactor removed the OpenPalm-side
 * `admin-audit.jsonl` — OpenCode session logs are the audit trail for
 * chat + tool activity.
 */
export const guardianAuditPath     = (s: ControlPlaneState): string => `${req(s.dataDir, "dataDir")}/logs/guardian-audit.log`;
export const backupsDir            = (s: ControlPlaneState): string => `${req(s.dataDir, "dataDir")}/backups`;

// ── State directory — persistent service data ───────────────────────────────

export const assistantServiceDir   = (s: ControlPlaneState): string => `${req(s.dataDir, "dataDir")}/assistant`;
export const guardianServiceDir    = (s: ControlPlaneState): string => `${req(s.dataDir, "dataDir")}/guardian`;
export const guardianAkmDir        = (s: ControlPlaneState): string => `${req(s.dataDir, "dataDir")}/guardian/akm`;
/** akm durable data — NOT config, which lives in config/akm/ */
export const akmDataDir            = (s: ControlPlaneState): string => `${req(s.dataDir, "dataDir")}/akm/data`;
export const taskLogDir            = (s: ControlPlaneState, id: string): string => `${req(s.dataDir, "dataDir")}/akm/cache/tasks/logs/${id}`;
export const taskLogsRootDir       = (s: ControlPlaneState): string => `${req(s.dataDir, "dataDir")}/akm/cache/tasks/logs`;
// (Removed the dataDir-scoped secretsDir/secretProviderPath/secretsIndexPath/
//  passStoreDir helpers — zero consumers, and secretsDir here name-collided
//  with the live knowledge/secrets `home.ts` secretsDir().)

// ── Knowledge directory ─────────────────────────────────────────────────────
// The akm env:user file path (`knowledge/env/user.env`) is owned by
// `akm-user-env.ts` (`userEnvPathSync`), which also handles its read/write and
// legacy migration — kept there rather than duplicated as a bare path here.

// ── Stack directory ─────────────────────────────────────────────────────────

export const coreComposePath       = (s: ControlPlaneState): string => `${req(s.stackDir, "stackDir")}/core.compose.yml`;
export const servicesComposePath   = (s: ControlPlaneState): string => `${req(s.stackDir, "stackDir")}/services.compose.yml`;
export const portalsComposePath   = (s: ControlPlaneState): string => `${req(s.stackDir, "stackDir")}/portals.compose.yml`;
// custom.compose.yml is USER-owned and lives in the config/ tree, not system/stack.
export const customComposePath     = (s: ControlPlaneState): string => `${req(s.homeDir, "homeDir")}/config/stack/custom.compose.yml`;
