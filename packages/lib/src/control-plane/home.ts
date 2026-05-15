/**
 * Home directory layout for the OpenPalm control plane (v0.11.0+).
 *
 * Single ~/.openpalm/ root:
 *   config/      — user-editable, non-secret configuration
 *   stash/       — akm knowledge (skills, vaults, knowledge, agents)
 *   workspace/   — shared assistant work area
 *   services/    — container bind mounts (per-service persistent data)
 *   state/       — system-managed state (replaces vault/ + data/ + logs/)
 *   stack/       — compose runtime assets
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

export function resolveServicesDir(): string {
  return `${resolveOpenPalmHome()}/services`;
}

export function resolveStateDir(): string {
  return `${resolveOpenPalmHome()}/state`;
}

export function resolveStackDir(): string {
  return `${resolveOpenPalmHome()}/stack`;
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
  return `${resolveStateDir()}/cache/rollback`;
}

// ── Directory Setup ──────────────────────────────────────────────────

/**
 * Create the full ~/.openpalm/ directory tree.
 */
export function ensureHomeDirs(): void {
  const home = resolveOpenPalmHome();

  for (const dir of [
    // config/ — user-editable, non-secret
    `${home}/config`,
    `${home}/config/automations`,
    `${home}/config/assistant`,
    `${home}/config/guardian`,

    // stash/ — akm asset content (skills, vaults, knowledge, agents)
    `${home}/stash`,

    // workspace/ — shared assistant work area
    `${home}/workspace`,

    // services/ — container bind mounts
    `${home}/services`,
    `${home}/services/assistant`,
    `${home}/services/admin`,
    `${home}/services/guardian`,
    `${home}/services/guardian/stash`,
    `${home}/services/guardian/akm`,
    `${home}/services/guardian/akm/config`,
    `${home}/services/guardian/akm/data`,
    `${home}/services/guardian/akm/state`,

    // state/ — system-managed state
    `${home}/state`,
    `${home}/state/akm`,
    `${home}/state/akm/config`,
    `${home}/state/akm/data`,
    `${home}/state/akm/state`,
    `${home}/state/scheduler`,
    `${home}/state/scheduler/triggers`,
    `${home}/state/logs`,
    `${home}/state/logs/opencode`,
    `${home}/state/backups`,
    `${home}/state/registry`,
    `${home}/state/registry/addons`,
    `${home}/state/registry/automations`,
    `${home}/state/cache`,
    `${home}/state/cache/akm`,
    `${home}/state/cache/guardian`,
    `${home}/state/cache/rollback`,

    // stack/ — compose files
    `${home}/stack`,
    `${home}/stack/addons`,

    // backups/ — user backups at root level
    `${home}/backups`,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
