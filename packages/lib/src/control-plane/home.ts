/**
 * Home directory layout for the OpenPalm control plane (v0.10.0+).
 *
 * Replaces the XDG three-tier model with a single ~/.openpalm/ root:
 *   config/  — user-editable, non-secret configuration
 *   vault/   — secrets boundary (user.env, system.env)
 *   data/    — service-managed persistent data
 *   logs/    — consolidated audit/debug output
 *
 * Cache and rollback data live in ~/.cache/openpalm/ (ephemeral).
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

export function resolveVaultDir(): string {
  return `${resolveOpenPalmHome()}/vault`;
}

export function resolveDataDir(): string {
  return `${resolveOpenPalmHome()}/data`;
}

export function resolveLogsDir(): string {
  return `${resolveOpenPalmHome()}/logs`;
}

export function resolveCacheHome(): string {
  return `${resolveHome()}/.cache/openpalm`;
}

export function resolveRollbackDir(): string {
  return `${resolveCacheHome()}/rollback`;
}

export function resolveRegistryDir(): string {
  return `${resolveOpenPalmHome()}/registry`;
}

export function resolveRegistryAddonsDir(): string {
  return `${resolveRegistryDir()}/addons`;
}

export function resolveRegistryAutomationsDir(): string {
  return `${resolveRegistryDir()}/automations`;
}

export function resolveStackDir(): string {
  return `${resolveOpenPalmHome()}/stack`;
}

export function resolveBackupsDir(): string {
  return `${resolveOpenPalmHome()}/backups`;
}

export function resolveWorkspaceDir(): string {
  return `${resolveOpenPalmHome()}/data/workspace`;
}

// ── Directory Setup ──────────────────────────────────────────────────

/**
 * Create the full ~/.openpalm/ directory tree and cache directories.
 */
export function ensureHomeDirs(): void {
  const home = resolveOpenPalmHome();
  const cache = resolveCacheHome();

  for (const dir of [
    // config/ — user-editable, non-secret
    `${home}/config`,
    `${home}/config/automations`,
    `${home}/config/assistant`,
    `${home}/config/guardian`,

    // vault/ — secrets boundary
    `${home}/vault`,
    `${home}/vault/stack`,
    `${home}/vault/user`,

    // data/ — service-managed persistent data
    `${home}/data`,
    `${home}/data/assistant`,
    `${home}/data/admin`,
    `${home}/data/memory`,
    `${home}/data/guardian`,
    `${home}/data/stash`,

    // stack/ — compose files
    `${home}/stack`,
    `${home}/stack/addons`,

    // registry/ — available catalog
    `${home}/registry`,
    `${home}/registry/addons`,
    `${home}/registry/automations`,

    // backups/ — user backups
    `${home}/backups`,

    // data/workspace/ — shared assistant workspace (compose: $OP_HOME/data/workspace:/work)
    `${home}/data/workspace`,

    // logs/ — consolidated audit/debug
    `${home}/logs`,
    `${home}/logs/opencode`,

    // cache/ — ephemeral, regenerable
    cache,
    `${cache}/rollback`,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
