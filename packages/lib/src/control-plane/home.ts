/**
 * Home directory layout for the OpenPalm control plane (v0.11.0+).
 *
 * Single ~/.openpalm/ root:
 *   config/    — user-editable config + system config files (auth.json, akm/)
 *   config/stack/ — compose runtime + stack config (stack.env, guardian.env, stack.yml, addons/)
 *   cache/     — regenerable/semi-persistent data (akm cache, guardian cache, rollback)
 *   state/     — persistent service data (assistant, admin, guardian, logs, backups, registry)
 *   stash/     — akm knowledge (skills, vaults, agents)
 *   workspace/ — shared assistant work area
 *   config/stack/ — compose runtime assets + stack config (stack.env, guardian.env, stack.yml)
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

// Derived from stateDir — used by registry.ts, rollback.ts, backup.ts, core-assets.ts
export function resolveLogsDir(): string {
  return `${resolveStateDir()}/logs`;
}

export function resolveBackupsDir(): string {
  return `${resolveStateDir()}/backups`;
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
    `${home}/cache/akm`,            // akm registry index, downloaded artifacts
    `${home}/cache/guardian`,       // guardian cache
    `${home}/cache/rollback`,       // rollback snapshots

    // state/ — persistent service data
    `${home}/state`,
    `${home}/state/assistant`,      // assistant HOME bind mount
    `${home}/state/admin`,          // admin home bind mount
    `${home}/state/guardian`,       // guardian runtime data
    `${home}/state/guardian/stash`, // guardian-only akm stash (operator-isolated)
    `${home}/state/guardian/akm`,   // guardian akm operational data
    `${home}/state/guardian/akm/data`,
    `${home}/state/guardian/akm/state`,
    `${home}/state/akm`,            // shared akm operational data (NOT config)
    `${home}/state/akm/data`,
    `${home}/state/akm/state`,
    `${home}/state/logs`,
    `${home}/state/logs/opencode`,
    `${home}/state/backups`,
    `${home}/state/registry`,
    `${home}/state/registry/addons`,
    `${home}/state/registry/automations`,

    // stash/ — akm knowledge (skills, vaults, agents); stash/tasks/ for scheduled automations
    `${home}/stash`,
    `${home}/stash/tasks`,

    // workspace/ — shared assistant work area
    `${home}/workspace`,

    // config/stack/ — compose runtime (addon overlays + stack config files)
    `${home}/config/stack`,
    `${home}/config/stack/addons`,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
