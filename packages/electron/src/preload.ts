// Preload script — exposes a minimal API to the renderer over contextBridge.
// The UI prefers HTTP (via /api/electron/update-status) but can also call
// `window.openpalm.updateStatus()` when running inside the Electron shell.

import { contextBridge } from 'electron';

interface UpdateStatus {
  inElectron: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  latestUrl: string | null;
  updateAvailable: boolean;
}

contextBridge.exposeInMainWorld('openpalm', {
  /** Synchronous read of update info from env vars set by main.ts. */
  updateStatus(): UpdateStatus {
    const latest = process.env.OP_ELECTRON_LATEST_VERSION ?? null;
    const url = process.env.OP_ELECTRON_LATEST_URL ?? null;
    const current = process.env.OP_ELECTRON_VERSION ?? null;
    return {
      inElectron: process.env.OP_INSIDE_ELECTRON === '1',
      currentVersion: current,
      latestVersion: latest,
      latestUrl: url,
      updateAvailable: !!latest,
    };
  },

  /**
   * Show a desktop notification from within the renderer.
   * Electron apps do not require OS permission for Notification on macOS/Windows.
   * Usage: window.openpalm?.notify('Setup complete', 'Your assistant is ready.')
   */
  notify(title: string, body: string): void {
    new Notification(title, { body });
  },
});
