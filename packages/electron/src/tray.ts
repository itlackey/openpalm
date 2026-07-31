import { Menu, nativeImage, Tray, type NativeImage } from 'electron';
import { resolveAssetPath } from './assets.js';
import type { LaunchOnLoginStatus } from './launch-on-login.js';

// Target menu-bar/tray icon size (points). The source asset is much larger;
// macOS otherwise renders it at full bitmap height (#455).
const TRAY_ICON_SIZE = 18;
const RECORDING_FRAME_MS = 280;
const RECORDING_ALPHAS = [1, 0.72, 0.42, 0.72];

/** Callbacks the tray menu invokes; supplied by the app so the tray owns no app state. */
export interface TrayCallbacks {
  /** "Open OpenPalm" — show/focus the main window. */
  onOpen: () => void;
  /** Open the canonical UI chat in the system browser. */
  onOpenChatInBrowser: () => void;
  /** "Open Admin Dashboard" — open the host UI's /host admin surface (A2). */
  onOpenAdmin: () => void;
  /** "Show Logs" — reveal the log directory. */
  onShowLogs: () => void;
  /** Current launch-on-login status (drives the checkbox state + enablement). */
  getLaunchOnLoginStatus: () => LaunchOnLoginStatus;
  /** "Start at Login" toggle. */
  onSetLaunchOnLogin: (enabled: boolean) => void;
  /** Whether the prerelease-update opt-in is currently on. */
  isPrereleaseEnabled: () => boolean;
  /** "Check for prerelease versions" toggle. */
  onTogglePrerelease: (enabled: boolean) => void;
  /** Whether the global Ctrl/Cmd+Shift+M mic shortcut opt-in is currently on (review E3). */
  isMicShortcutEnabled: () => boolean;
  /** "Global Mic Shortcut" toggle. */
  onToggleMicShortcut: (enabled: boolean) => void;
  /** "Quit" — tear down and exit. */
  onQuit: () => void;
}

function createTrayIconVariant(icon: NativeImage, alpha: number): NativeImage {
  // Rebuild the recording-animation frame at the menu-bar target size. Without
  // this resize the variant would reintroduce the oversized source bitmap and
  // undo the menu-bar sizing applied to the base icon (#455).
  const base = icon.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  const bitmap = base.toBitmap();
  const variant = Buffer.from(bitmap);

  for (let i = 3; i < variant.length; i += 4) {
    variant[i] = Math.round(variant[i] * alpha);
  }

  const size = base.getSize();
  const result = nativeImage.createFromBitmap(variant, {
    width: size.width,
    height: size.height,
    scaleFactor: 1,
  });
  if (process.platform === 'darwin') {
    result.setTemplateImage(true);
  }
  return result;
}

/**
 * Owns the menu-bar/tray icon: its base image, the recording-animation frames
 * and timer, and the context menu. Encapsulates all tray state so `main.ts`
 * only supplies menu callbacks and toggles the recording animation.
 */
export class TrayController {
  private tray: Tray | null = null;
  private baseIcon: NativeImage | null = null;
  private recordingIcons: NativeImage[] = [];
  private animationTimer: ReturnType<typeof setInterval> | null = null;
  private animationFrame = 0;
  private callbacks: TrayCallbacks | null = null;

  /**
   * Create the tray icon (idempotent — reuses an existing Tray so a rebuild
   * after a settings toggle never leaks a duplicate menu-bar icon). No-ops when
   * the tray-icon asset is missing, AND degrades to the same no-op if the
   * platform's tray protocol itself refuses the icon (review E1: vanilla GNOME
   * ships no StatusNotifier host, so `new Tray()` can fail there) — either way
   * `isActive()` reports false afterward, which is what main.ts's window
   * 'close' handler consults to decide whether hiding to tray is even
   * reachable, instead of assuming create() always succeeds.
   */
  create(callbacks: TrayCallbacks): void {
    const iconPath = resolveAssetPath('tray-icon.png');
    if (!iconPath) {
      return;
    }
    this.callbacks = callbacks;

    try {
      // The source asset is 128×122 RGBA; passing it straight to Tray renders it
      // ~128pt tall in the macOS menu bar (#455). Resize to a menu-bar-appropriate
      // size, and on macOS mark it as a template image so it adopts the menu bar's
      // monochrome light/dark treatment. Follow-up polish: ship a dedicated
      // monochrome trayTemplate.png/@2x asset rather than recolouring this one.
      this.baseIcon = nativeImage.createFromPath(iconPath).resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
      if (process.platform === 'darwin') {
        this.baseIcon.setTemplateImage(true);
      }
      this.recordingIcons = RECORDING_ALPHAS.map((alpha) => createTrayIconVariant(this.baseIcon as NativeImage, alpha));
      // Reuse an existing Tray (e.g. a menu rebuild after a settings toggle) so we
      // never leak a duplicate menu-bar icon or reset the recording animation.
      if (!this.tray) {
        this.tray = new Tray(this.baseIcon);
      }

      this.rebuildMenu();

      this.tray.setToolTip('OpenPalm');
      // NOTE: No tray.on('click', ...) handler — a plain tray-icon click should
      // NOT open/restore the window.  The window is always accessible via the
      // "Open OpenPalm" item in the context menu (right-click or left-click the
      // tray icon to see it, depending on the OS).  Removing the click handler
      // prevents the surprise "tray icon pops my window" behavior reported in #427.
    } catch (err) {
      // No usable tray protocol on this desktop — degrade to "no tray" rather
      // than crashing app startup over a menu-bar icon.
      console.warn('Tray icon unavailable (no-op):', err instanceof Error ? err.message : String(err));
      this.tray = null;
    }
  }

  /**
   * Whether the tray icon actually exists right now. False when the icon
   * asset was missing, or the platform's tray protocol rejected creation
   * (review E1 — hide-to-tray-on-close must not assume a tray is reachable).
   */
  isActive(): boolean {
    return this.tray !== null;
  }

  /** (Re)build the tray context menu from current settings/state. */
  rebuildMenu(): void {
    if (!this.tray || !this.callbacks) return;
    const cb = this.callbacks;
    const loginSettings = cb.getLaunchOnLoginStatus();
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Open OpenPalm', click: () => cb.onOpen() },
      {
        label: 'Open Chat in Browser',
        click: () => cb.onOpenChatInBrowser(),
      },
      {
        label: 'Open Admin Dashboard',
        click: () => cb.onOpenAdmin(),
      },
      { label: 'Show Logs', click: () => cb.onShowLogs() },
      { type: 'separator' },
      {
        // "Start at Login" checkbox — reads and writes Electron's cross-platform
        // login-item API (macOS LaunchAgent, Windows Run registry key).
        // Default OFF; the user's current setting drives the initial checked state.
        label: 'Start at Login',
        type: 'checkbox',
        checked: loginSettings.enabled,
        enabled: loginSettings.supported,
        click: (menuItem) => {
          cb.onSetLaunchOnLogin(menuItem.checked);
        },
      },
      {
        // "Check for prerelease versions" opt-in (#504). When on, the GitHub
        // update check surfaces rc's matching the user's channel. Notify-only —
        // it never auto-installs. Persisted to desktop settings and re-checked
        // immediately so the user gets feedback without restarting.
        label: 'Check for prerelease versions',
        type: 'checkbox',
        checked: cb.isPrereleaseEnabled(),
        click: (menuItem) => {
          cb.onTogglePrerelease(menuItem.checked);
        },
      },
      {
        // Opt-in (review E3): Ctrl/Cmd+Shift+M is Teams' global mute chord.
        // Registering it system-wide unconditionally on first launch silently
        // took it away from every other app with no setting and no prompt.
        // Default OFF; this is the only way to turn it on.
        label: 'Global Mic Shortcut (Ctrl/Cmd+Shift+M)',
        type: 'checkbox',
        checked: cb.isMicShortcutEnabled(),
        click: (menuItem) => {
          cb.onToggleMicShortcut(menuItem.checked);
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => cb.onQuit(),
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  /** Start or stop the recording animation from the renderer's mic state. */
  setMicRecording(recording: boolean): void {
    if (recording) {
      this.startAnimation();
      return;
    }
    this.stopAnimation();
  }

  /** Stop the recording animation and restore the idle icon/tooltip. */
  stopAnimation(): void {
    if (this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }
    this.animationFrame = 0;
    if (this.tray && this.baseIcon) {
      this.tray.setImage(this.baseIcon);
      this.tray.setToolTip('OpenPalm');
    }
  }

  private startAnimation(): void {
    if (!this.tray || this.recordingIcons.length === 0) {
      return;
    }

    this.stopAnimation();
    this.tray.setToolTip('OpenPalm — recording');
    this.tray.setImage(this.recordingIcons[0]);
    this.animationTimer = setInterval(() => {
      if (!this.tray || this.recordingIcons.length === 0) {
        this.stopAnimation();
        return;
      }

      this.animationFrame = (this.animationFrame + 1) % this.recordingIcons.length;
      this.tray.setImage(this.recordingIcons[this.animationFrame]);
    }, RECORDING_FRAME_MS);
  }
}
