/**
 * Home directory layout for the OpenPalm control plane (v0.11.0+).
 *
 * Single ~/.openpalm/ root:
 *   config/    — user-editable config + system config files (auth.json, akm/)
 *   config/stack/ — compose runtime + stack config (stack.env, stack.yml, fixed compose files)
 *   cache/     — regenerable/semi-persistent data (akm, guardian, rollback, logs, backups)
 *   state/     — persistent service data (assistant, admin, guardian)
 *   stash/     — akm knowledge (skills, vaults, agents)
 *   workspace/ — shared assistant work area
 *   config/stack/ — compose runtime assets + stack config (stack.env, stack.yml)
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
  return `${resolveOpenPalmHome()}/stash`;
}

export function resolveWorkspaceDir(): string {
  return `${resolveOpenPalmHome()}/workspace`;
}

export function resolveCacheDir(): string {
  return `${resolveOpenPalmHome()}/cache`;
}

export function resolveStateDir(): string {
  return `${resolveOpenPalmHome()}/state`;
}

export function resolveStackDir(): string {
  return `${resolveConfigDir()}/stack`;
}

export function resolveLogsDir(): string {
  return `${resolveCacheDir()}/logs`;
}

export function resolveBackupsDir(): string {
  return `${resolveCacheDir()}/backups`;
}

export function resolveRegistryDir(): string {
  return `${resolveStateDir()}/registry`;
}

export function resolveRegistryAddonsDir(): string {
  return `${resolveRegistryDir()}/addons`;
}

export function resolveRegistryAutomationsDir(): string {
  return `${resolveRegistryDir()}/automations`;
}

export function resolveRollbackDir(): string {
  return `${resolveCacheDir()}/rollback`;
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
    `${home}/config/akm`,           // AKM_CONFIG_DIR — akm setup config.json lives here

    // cache/ — regenerable/semi-persistent data
    `${home}/cache`,
    `${home}/cache/akm`,            // akm operational data and cache
    `${home}/cache/akm/data`,
    `${home}/cache/akm/state`,
    `${home}/cache/akm/cache`,
    `${home}/cache/rollback`,       // rollback snapshots
    `${home}/cache/logs`,           // service logs and audit files
    `${home}/cache/backups`,        // lifecycle backup snapshots

    // state/ — persistent service data
    `${home}/state`,
    `${home}/state/assistant`,      // assistant HOME bind mount
    `${home}/state/admin`,          // admin home bind mount
    `${home}/state/guardian`,       // guardian runtime data
    // stash/ — akm knowledge (skills, vaults, agents); stash/tasks/ for scheduled automations
    `${home}/stash`,
    `${home}/stash/vaults`,
    `${home}/stash/vaults/secrets`,
    `${home}/stash/tasks`,

    // workspace/ — shared assistant work area
    `${home}/workspace`,

    // config/stack/ — compose runtime + stack config files
    `${home}/config/stack`,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
