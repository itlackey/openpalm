/**
 * Home directory layout for the OpenPalm control plane (v0.11.0+).
 *
 * Single ~/.openpalm/ root:
 *   config/    — user-editable config + system config files (auth.json, akm/)
 *   config/stack/ — compose runtime + stack config (stack.env, stack.yml, fixed compose files)
 *   data/      — persistent service data, logs, backups, rollback
 *   knowledge/ — akm knowledge (skills, vaults, agents)
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

export function resolveLogsDir(): string {
  return `${resolveDataDir()}/logs`;
}

export function resolveBackupsDir(): string {
  return `${resolveDataDir()}/backups`;
}

export function resolveRegistryDir(): string {
  return `${resolveDataDir()}/registry`;
}

export function resolveRegistryAddonsDir(): string {
  return `${resolveRegistryDir()}/addons`;
}

export function resolveRegistryAutomationsDir(): string {
  return `${resolveRegistryDir()}/automations`;
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
    `${home}/data/admin`,          // admin home bind mount
    `${home}/data/guardian`,       // guardian runtime data
    `${home}/data/akm/cache`,      // akm cache
    `${home}/data/akm/data`,       // akm durable data
    `${home}/data/logs`,           // service logs and audit files
    `${home}/data/backups`,        // lifecycle backup snapshots
    `${home}/data/rollback`,       // deploy rollback snapshots
    // knowledge/ — akm knowledge (skills, vaults, agents); knowledge/tasks/ for scheduled automations
    `${home}/knowledge`,
    `${home}/knowledge/vaults`,
    `${home}/knowledge/vaults/secrets`,
    `${home}/knowledge/tasks`,

    // workspace/ — shared assistant work area
    `${home}/workspace`,

    // config/stack/ — compose runtime + stack config files
    `${home}/config/stack`,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
