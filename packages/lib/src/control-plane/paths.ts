/**
 * XDG path resolution and directory setup for the OpenPalm control plane.
 *
 * Directory model (XDG-compliant):
 *   CONFIG_HOME (~/.config/openpalm)      — user-editable: secrets.env, channels/, assistant/
 *   DATA_HOME   (~/.local/share/openpalm) — opaque service data (memory, etc.)
 *   STATE_HOME  (~/.local/state/openpalm) — assembled runtime, audit logs
 */
import { mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export function resolveHome(): string {
  return process.env.HOME ?? "/tmp";
}

export function resolveConfigHome(): string {
  const raw = process.env.OPENPALM_CONFIG_HOME;
  if (!raw) return `${resolveHome()}/.config/openpalm`;
  return resolvePath(raw);
}

export function resolveStateHome(): string {
  const raw = process.env.OPENPALM_STATE_HOME;
  if (!raw) return `${resolveHome()}/.local/state/openpalm`;
  return resolvePath(raw);
}

export function resolveDataHome(): string {
  const raw = process.env.OPENPALM_DATA_HOME;
  if (!raw) return `${resolveHome()}/.local/share/openpalm`;
  return resolvePath(raw);
}

/**
 * Create the full XDG directory tree.
 *
 * CONFIG_HOME (~/.config/openpalm)      — user-editable configuration
 * DATA_HOME   (~/.local/share/openpalm) — opaque persistent service data
 * STATE_HOME  (~/.local/state/openpalm) — generated artifacts, audit logs
 */
export function ensureXdgDirs(): void {
  const dataHome = resolveDataHome();
  const configHome = resolveConfigHome();
  const stateHome = resolveStateHome();

  for (const dir of [
    // CONFIG_HOME — user-editable
    configHome,
    `${configHome}/channels`,
    `${configHome}/connections`,
    `${configHome}/assistant`,
    `${configHome}/automations`,
    `${configHome}/stash`,

    // DATA_HOME — persistent service data (pre-created to avoid root-owned dirs)
    dataHome,
    `${dataHome}/admin`,
    `${dataHome}/memory`,
    `${dataHome}/assistant`,
    `${dataHome}/guardian`,
    `${dataHome}/caddy`,
    `${dataHome}/caddy/data`,
    `${dataHome}/caddy/config`,
    `${dataHome}/automations`,
    `${dataHome}/opencode`,

    // STATE_HOME — assembled runtime
    stateHome,
    `${stateHome}/artifacts`,
    `${stateHome}/audit`,
    `${stateHome}/artifacts/channels`,
    `${stateHome}/automations`,
    `${stateHome}/opencode`
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
