// Harness-local desktop settings (NOT part of the harness contract surface, NOT
// operator stack config). A tiny JSON file under OP_HOME/data so a user's
// desktop-only preferences survive restarts. Kept deliberately separate from
// state/stack.env (operator-managed control-plane config) and from
// Electron's login-item API (OS-managed): this is purely the native shell's own
// notify behaviour. It currently holds whether the app's GitHub update check
// should surface PRERELEASE versions (#504, notify-only — it changes what the
// update check looks for, never how an update is installed).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface DesktopSettings {
  /**
   * When true, the GitHub update check includes prereleases that match the
   * user's channel. When false, it considers stable releases only. Both modes
   * scan paginated releases for installer assets. Notify-only either way.
   */
  checkPrerelease: boolean;
  /**
   * Opt-in for the global Ctrl/Cmd+Shift+M mic-toggle shortcut (review E3).
   * That chord is Teams' global mute/unmute — registering it system-wide
   * unconditionally on first launch silently took it away from every other
   * app on the machine, with no setting and no prompt. Default OFF; the tray
   * menu's "Global Mic Shortcut" checkbox is the only way to turn it on.
   */
  micShortcutEnabled: boolean;
  /**
   * Whether the one-time "OpenPalm is still running" tray-discoverability
   * notice has already been shown. Hide-to-tray silently rescues an ordinary
   * window close, but that alone gives no indication the app is still
   * running — the tray icon is the only way back, and a user who hasn't
   * noticed it reads the close as "the app quit". Shown at most once ever;
   * the tray menu's "Open OpenPalm" item (and, on Windows, a tray click) stay
   * available regardless of whether the notice fired.
   */
  hideToTrayNoticeShown: boolean;
}

const DEFAULT_SETTINGS: DesktopSettings = {
  checkPrerelease: false,
  micShortcutEnabled: false,
  hideToTrayNoticeShown: false,
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
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      checkPrerelease:
        typeof parsed.checkPrerelease === 'boolean'
          ? parsed.checkPrerelease
          : DEFAULT_SETTINGS.checkPrerelease,
      micShortcutEnabled:
        typeof parsed.micShortcutEnabled === 'boolean'
          ? parsed.micShortcutEnabled
          : DEFAULT_SETTINGS.micShortcutEnabled,
      hideToTrayNoticeShown:
        typeof parsed.hideToTrayNoticeShown === 'boolean'
          ? parsed.hideToTrayNoticeShown
          : DEFAULT_SETTINGS.hideToTrayNoticeShown,
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
