/**
 * Home directory layout for the OpenPalm control plane (v0.11.0+).
 *
 * Single ~/.openpalm/ root:
 *   config/    — user-editable config + system config files (akm/)
 *   config/stack/ — fixed compose files (no stack.env/secrets/stack.yml)
 *   data/      — persistent service data, logs, backups, rollback
 *   knowledge/ — akm knowledge (env, secrets, tasks); env/stack.env is the
 *                authoritative stack composition + versions record
 *   workspace/ — shared assistant work area
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
  return `${resolveConfigDir()}/stack`;
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

/** A fixed compose file in the stack dir. */
export function composeFilePath(home: string, name: string): string {
  return `${home}/config/stack/${name}`;
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

    // config/stack/ — compose runtime + stack config files
    `${home}/config/stack`,

    // system/ — managed tree (release-shipped assets, overwritten); state/ — app-written records
    `${home}/system`,
    `${home}/state`,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
