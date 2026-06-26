/**
 * Home directory layout for the OpenPalm control plane (v0.11.0+).
 *
 * Single ~/.openpalm/ root (four-tree ownership — constitution §1):
 *   config/    — USER: editable config + system config files (akm/)
 *   config/stack/ — USER: the custom.compose.yml overlay ONLY (seeded once, never overwritten)
 *   system/stack/ — MANAGED: fixed compose files (core/services/portals), overwritten on reconcile
 *   data/      — RUNTIME: persistent service data, logs, backups, rollback (never written by install/update)
 *   knowledge/ — USER/services: akm knowledge (env, secrets, tasks); env/stack.env holds
 *                non-secret base Compose configuration only
 *   workspace/ — USER: shared assistant work area
 *   state/     — app-written records (version pins, enabled add-ons, channel, setup);
 *                stack.state.env is merged OVER legacy stack.env at compose time, so
 *                pins/channel/add-ons live here, not in knowledge/env/stack.env
 */
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

// ── Path Resolution ──────────────────────────────────────────────────

export function resolveHome(): string {
  const home = homedir();
  if (home) return home;

  return tmpdir();
}

export function resolveOpenPalmHome(): string {
  const raw = process.env.OP_HOME;
  if (raw) return resolvePath(raw);
  return `${resolveHome()}/.openpalm`;
}

export function resolveConfigDir(): string {
  return `${resolveOpenPalmHome()}/config`;
}

export function resolveStashDir(): string {
  return `${resolveOpenPalmHome()}/knowledge`;
}

export function resolveWorkspaceDir(): string {
  return `${resolveOpenPalmHome()}/workspace`;
}

export function resolveDataDir(): string {
  return `${resolveOpenPalmHome()}/data`;
}

export function resolveStackDir(): string {
  return stackDirFor(resolveOpenPalmHome());
}

/** Managed tree (constitution §1): release-shipped assets, overwritten wholesale. */
export function resolveSystemDir(): string {
  return `${resolveOpenPalmHome()}/system`;
}

/** State tree: app-written records (pins, enabled add-ons, channel, setup). */
export function resolveStateDir(): string {
  return `${resolveOpenPalmHome()}/state`;
}

// ── Well-known files — THE single source of truth ────────────────────────────
// Every well-known path is defined HERE, once, derived from an explicit `home`.
// Moving a file/dir is a one-line edit in this section — never a grep-and-replace
// across the codebase. (This section exists specifically to kill the blast-radius
// class of change, e.g. `${state.stashDir}/env/stack.env` duplicated 18×.)

/** The managed compose dir for a home root (homeDir-param form of resolveStackDir). */
export function stackDirFor(home: string): string {
  return `${home}/system/stack`;
}
/** A MANAGED fixed compose file in the system stack dir (overwritten on reconcile). */
export function composeFilePath(home: string, name: string): string {
  return `${stackDirFor(home)}/${name}`;
}
/**
 * The USER-owned custom compose overlay. It lives in the user tree
 * (config/stack/), NOT the managed system/stack/ — co-locating a never-overwrite
 * user file inside the wholesale-overwritten managed tree is forbidden by the
 * four-tree ownership model (constitution §1). Seeded once, never clobbered.
 */
export function customComposeFilePath(home: string): string {
  return `${home}/config/stack/custom.compose.yml`;
}
/** Pins/add-ons/channel state (constitution §1) — OP_HOME/state. */
export function stateEnvFile(home: string): string {
  return `${home}/state/stack.state.env`;
}
/** Pre-split system env; read only as a transition fallback, then deleted. */
export function legacyStackEnvFile(home: string): string {
  return `${home}/knowledge/env/stack.env`;
}
/** User env (entrypoint-sourced — never a compose --env-file; secret boundary). */
export function userEnvFile(home: string): string {
  return `${home}/knowledge/env/user.env`;
}
export function secretsDir(home: string): string {
  return `${home}/knowledge/secrets`;
}
export function authJsonFile(home: string): string {
  return `${secretsDir(home)}/auth.json`;
}

export function resolveLogsDir(): string {
  return `${resolveDataDir()}/logs`;
}

export function resolveBackupsDir(): string {
  return `${resolveDataDir()}/backups`;
}

export function resolveRollbackDir(): string {
  return `${resolveDataDir()}/rollback`;
}

// ── Directory Setup ──────────────────────────────────────────────────

/**
 * Create the full ~/.openpalm/ directory tree.
 */
export function ensureHomeDirs(): void {
  const home = resolveOpenPalmHome();

  for (const dir of [
    // config/ — user-editable config + system config files
    `${home}/config`,
    `${home}/config/assistant`,
    `${home}/config/guardian`,
    `${home}/config/akm`,           // akm XDG config directory
    `${home}/config/stack`,         // user-owned custom.compose.yml overlay (seeded once)

    // data/ — persistent service data
    `${home}/data`,
    `${home}/data/assistant`,      // assistant HOME bind mount
    `${home}/data/assistant/.cache`,
    `${home}/data/assistant/.local/bin`,
    `${home}/data/assistant/.local/share/opencode`,
    `${home}/data/assistant/.local/state/opencode`,
    `${home}/data/assistant/tools`, // runtime tools managed via package.json
    `${home}/data/guardian`,       // guardian runtime data
    `${home}/data/guardian/tools`, // runtime tools managed via package.json
    `${home}/data/akm/cache`,      // akm cache
    `${home}/data/akm/data`,       // akm durable data
    `${home}/data/akm/empty-host-stash`, // always-present /host-stash fallback when host AKM is absent
    `${home}/data/logs`,           // service logs and audit files
    `${home}/data/backups`,        // lifecycle backup snapshots
    `${home}/data/rollback`,       // deploy rollback snapshots
    // knowledge/ — akm knowledge (skills, env, secrets, agents); knowledge/tasks/ for scheduled automations
    `${home}/knowledge`,
    `${home}/knowledge/env`,
    `${home}/knowledge/secrets`,
    `${home}/knowledge/tasks`,

    // workspace/ — shared assistant work area
    `${home}/workspace`,

    // system/ — managed tree (release-shipped assets, overwritten); state/ — app-written records
    `${home}/system/stack`,         // fixed compose files (managed, overwritten on update)
    `${home}/system/assistant`,     // MANAGED assistant OpenCode config (OPENCODE_CONFIG_DIR)
    `${home}/system/guardian`,      // MANAGED guardian OpenCode config (OPENCODE_CONFIG_DIR)
    `${home}/state`,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
