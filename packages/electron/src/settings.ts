// Harness-local desktop settings (NOT part of the harness contract surface, NOT
// operator stack config). A tiny JSON file under OP_HOME/data so a user's
// desktop-only preferences survive restarts. Kept deliberately separate from
// knowledge/env/stack.env (operator-managed control-plane config) and from
// Electron's login-item API (OS-managed): this is purely the native shell's own
// notify behaviour.
//
// Today it holds two fields: whether the app's GitHub update check should
// surface PRERELEASE versions (#504, notify-only — it changes what the update
// check looks for, never how an update is installed), and whether the window
// should prefer the @openpalm/client SPA chat over the host UI chat (A1 —
// the client chat fails the plan's §12.2 parity contract, so it stays an
// explicit opt-in until that contract passes; see resolveInitialUrl).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface DesktopSettings {
  /**
   * When true, the GitHub update check polls the full releases list and surfaces
   * the newest matching the user's channel (including prereleases). When false
   * (default), it polls `/releases/latest`, which GitHub excludes prereleases
   * from. Notify-only either way.
   */
  checkPrerelease: boolean;
  /**
   * A1 opt-in: when true, the window prefers the @openpalm/client SPA chat
   * (once healthy) over the host UI chat. Defaults to false — the client
   * chat fails all six items of the plan's §12.2 parity contract (no voice,
   * no streaming, no stop, no history, ...), so Electron defaults to the
   * full host chat until that contract passes. Also settable per-launch via
   * the OP_CLIENT_CHAT_OPT_IN=1 env var (see resolveInitialUrl in main.ts);
   * either source enables it.
   */
  preferClientChat: boolean;
}

const DEFAULT_SETTINGS: DesktopSettings = {
  checkPrerelease: false,
  preferClientChat: false,
};

const SETTINGS_FILENAME = 'electron-settings.json';

/** Absolute path to the settings file for a given OP_HOME/data dir. */
export function settingsPath(dataDir: string): string {
  return join(dataDir, SETTINGS_FILENAME);
}

/**
 * Read desktop settings, falling back to defaults for a missing/corrupt file or
 * any individual missing/mistyped field. Never throws — a bad settings file must
 * not block app launch.
 */
export function loadSettings(dataDir: string): DesktopSettings {
  try {
    const raw = readFileSync(settingsPath(dataDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DesktopSettings>;
    return {
      checkPrerelease:
        typeof parsed.checkPrerelease === 'boolean'
          ? parsed.checkPrerelease
          : DEFAULT_SETTINGS.checkPrerelease,
      preferClientChat:
        typeof parsed.preferClientChat === 'boolean'
          ? parsed.preferClientChat
          : DEFAULT_SETTINGS.preferClientChat,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist desktop settings (merged over the current on-disk values so callers
 * can update one field without clobbering others). Best-effort: a write failure
 * is logged, not thrown.
 */
export function saveSettings(dataDir: string, patch: Partial<DesktopSettings>): DesktopSettings {
  const next: DesktopSettings = { ...loadSettings(dataDir), ...patch };
  try {
    const file = settingsPath(dataDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  } catch (err) {
    console.warn(
      'Failed to persist desktop settings (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }
  return next;
}
