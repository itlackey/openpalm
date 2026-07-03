import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow } from 'electron';
import { readAssetText, resolveAssetPath } from './assets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal inline fallback used only if assets/splash.html can't be read (e.g. a
// packaging regression). Keeps the app bootable rather than crashing on startup.
const SPLASH_FALLBACK_HTML =
  '<!doctype html><meta charset="utf-8"><body style="background:#0f172a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">Starting OpenPalm…</body>';

/** Render an HTML string into a frameless data: URL the splash window can load. */
export function htmlDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Owns the frameless startup/splash window. Consolidates the window lifecycle so
 * the rest of the app (and the Docker preflight screen, which reuses this window)
 * never touches a shared `splashWindow` global.
 */
export class SplashWindow {
  private win: BrowserWindow | null = null;

  /** The live splash window, or null when closed. */
  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** True while the splash window exists and hasn't been destroyed. */
  isOpen(): boolean {
    return this.window !== null;
  }

  /** Show the initial spinner splash (loads assets/splash.html). */
  showStartup(): void {
    const icon = resolveAssetPath('icon.png') ?? undefined;
    this.win = new BrowserWindow({
      width: 380,
      height: 200,
      frame: false,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      show: true,
      icon,
      backgroundColor: '#0f172a',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    const html = readAssetText('splash.html', SPLASH_FALLBACK_HTML);
    void this.win.loadURL(htmlDataUrl(html));
    this.win.on('closed', () => { this.win = null; });
  }

  /**
   * Render arbitrary HTML into the splash window, reusing the existing window
   * when one is open (resized to the requested dimensions) or creating a fresh
   * one otherwise. `withPreload` attaches the app preload so the HTML can call
   * the `window.openpalm` bridge (used by the Docker-missing screen's buttons).
   */
  render(html: string, opts: { width: number; height: number; withPreload?: boolean }): void {
    const existing = this.window;
    if (!existing) {
      const icon = resolveAssetPath('icon.png') ?? undefined;
      this.win = new BrowserWindow({
        width: opts.width,
        height: opts.height,
        frame: false,
        resizable: false,
        movable: true,
        alwaysOnTop: true,
        show: true,
        icon,
        backgroundColor: '#0f172a',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          ...(opts.withPreload ? { preload: join(__dirname, 'preload.cjs') } : {}),
        },
      });
      this.win.on('closed', () => { this.win = null; });
    } else {
      existing.setSize(opts.width, opts.height);
    }
    void this.win?.loadURL(htmlDataUrl(html));
  }

  /** Close the splash window if it's still open. */
  close(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.close();
      this.win = null;
    }
  }
}
