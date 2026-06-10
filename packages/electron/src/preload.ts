// Preload script — exposes a minimal API to the renderer over contextBridge.
// The UI prefers HTTP (via /api/electron/update-status) but can also call
// `window.openpalm.updateStatus()` when running inside the Electron shell.

import { contextBridge, ipcRenderer } from 'electron';

interface UpdateStatus {
  inElectron: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  latestUrl: string | null;
  updateAvailable: boolean;
}

interface LaunchOnLoginStatus {
  supported: boolean;
  enabled: boolean;
}

type VoidCallback = () => void;

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
   * Usage: window.openpalm?.notify('OpenPalm', 'Assistant replied')
   */
  notify(title: string, body: string): void {
    ipcRenderer.send('notify', { title, body });
  },

  /** Restart the Electron app (relaunch + quit). Only works inside Electron. */
  restart(): Promise<void> {
    return ipcRenderer.invoke('restart-app');
  },

  launchOnLoginStatus(): Promise<LaunchOnLoginStatus> {
    return ipcRenderer.invoke('launch-on-login-status');
  },

  setLaunchOnLogin(enabled: boolean): Promise<LaunchOnLoginStatus> {
    return ipcRenderer.invoke('set-launch-on-login', enabled);
  },

  setTrayMicRecording(recording: boolean): Promise<void> {
    return ipcRenderer.invoke('set-tray-mic-recording', recording);
  },

  /**
   * Request microphone access from the OS (macOS TCC permission dialog).
   * Call when the user first clicks the mic button — the OS only shows the
   * prompt in response to a real user gesture, not at app startup.
   * Returns: 'granted' | 'denied' | 'restricted' | 'denied-no-prompt' | 'unknown'
   * ('denied-no-prompt' = macOS refused without consulting TCC — the build
   *  lacks the audio-input entitlement and won't appear in Settings.)
   */
  requestMicPermission(): Promise<string> {
    return ipcRenderer.invoke('request-mic-permission');
  },

  onGlobalMicToggle(callback: VoidCallback): VoidCallback {
    const listener = () => callback();
    ipcRenderer.on('global-mic-toggle', listener);
    return () => {
      ipcRenderer.removeListener('global-mic-toggle', listener);
    };
  },
});
