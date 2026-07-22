import { BrowserWindow } from 'electron';
import { readAssetText, resolveAssetPath } from './assets.js';

// Minimal inline fallback used only if assets/splash.html can't be read (e.g. a
// packaging regression). Keeps the app bootable rather than crashing on startup.
const SPLASH_FALLBACK_HTML =
  '<!doctype html><meta charset="utf-8"><body style="background:#0f172a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">Starting OpenPalm…</body>';

/** Render an HTML string into a frameless data: URL the splash window can load. */
export function htmlDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Owns the frameless startup/splash window.
 */
export class SplashWindow {
  private win: BrowserWindow | null = null;

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

  /** Close the splash window if it's still open. */
  close(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.close();
      this.win = null;
    }
  }
}
