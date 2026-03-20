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
import { mkdirSync, existsSync } from "node:fs";
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

export function resolveRegistryCacheDir(): string {
  return `${resolveCacheHome()}/registry`;
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
    `${home}/config/components`,
    `${home}/config/automations`,
    `${home}/config/assistant`,

    // vault/ — secrets boundary
    `${home}/vault`,
    `${home}/vault/stack`,
    `${home}/vault/stack/addons`,
    `${home}/vault/user`,

    // data/ — service-managed persistent data
    `${home}/data`,
    `${home}/data/assistant`,
    `${home}/data/admin`,
    `${home}/data/memory`,
    `${home}/data/guardian`,
    `${home}/data/stash`,
    `${home}/data/workspace`,

    // logs/ — consolidated audit/debug
    `${home}/logs`,
    `${home}/logs/opencode`,

    // cache/ — ephemeral, regenerable
    cache,
    `${cache}/registry`,
    `${cache}/rollback`,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── Legacy Layout Detection ──────────────────────────────────────────

export type LegacyLayout = {
  detected: boolean;
  configHome?: string;
  dataHome?: string;
  stateHome?: string;
};

/**
 * Detect whether the host has a pre-0.10.0 XDG directory layout.
 *
 * Checks for custom env vars first (OPENPALM_CONFIG_HOME, etc.),
 * then falls back to default XDG locations.
 */
export function detectLegacyLayout(): LegacyLayout {
  const home = resolveHome();

  const candidates = {
    configHome: process.env.OPENPALM_CONFIG_HOME ?? `${home}/.config/openpalm`,
    dataHome: process.env.OPENPALM_DATA_HOME ?? `${home}/.local/share/openpalm`,
    stateHome: process.env.OPENPALM_STATE_HOME ?? `${home}/.local/state/openpalm`,
  };

  const found: Partial<Pick<LegacyLayout, "configHome" | "dataHome" | "stateHome">> = {};
  let detected = false;

  if (existsSync(candidates.configHome)) {
    found.configHome = candidates.configHome;
    detected = true;
  }
  if (existsSync(candidates.dataHome)) {
    found.dataHome = candidates.dataHome;
    detected = true;
  }
  if (existsSync(candidates.stateHome)) {
    found.stateHome = candidates.stateHome;
    detected = true;
  }

  return { detected, ...found };
}

/**
 * Check whether legacy XDG environment variables are set.
 * The migration tool refuses to proceed when these are present.
 */
export function hasLegacyEnvVars(): string[] {
  const vars: string[] = [];
  if (process.env.OPENPALM_CONFIG_HOME) vars.push("OPENPALM_CONFIG_HOME");
  if (process.env.OPENPALM_DATA_HOME) vars.push("OPENPALM_DATA_HOME");
  if (process.env.OPENPALM_STATE_HOME) vars.push("OPENPALM_STATE_HOME");
  return vars;
}
