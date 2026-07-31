// Preload script — exposes a minimal API to the renderer over contextBridge.
// `window.openpalm.updater` is the desktop's full-application update surface
// (#572): live status pushed from the main process, plus the explicit check,
// download and restart-and-install actions. Absent in a browser, which is how
// the UI knows to hide the desktop-only update controls.

import { contextBridge, ipcRenderer } from 'electron';

/** Mirrors UpdaterState in src/updater.ts. */
interface UpdaterState {
  status:
    | 'idle' | 'checking' | 'available' | 'not-available'
    | 'downloading' | 'downloaded' | 'error' | 'unsupported';
  currentVersion: string;
  availableVersion: string | null;
  percent: number | null;
  error: string | null;
  channel: 'stable' | 'beta';
  supported: boolean;
  releasesUrl: string;
}

interface LaunchOnLoginStatus {
  supported: boolean;
  enabled: boolean;
}

type VoidCallback = () => void;

contextBridge.exposeInMainWorld('openpalm', {
  updater: {
    /** Current updater state. Cheap — no network. */
    state(): Promise<UpdaterState> {
      return ipcRenderer.invoke('updater-state');
    },
    /** User-initiated check. Unlike the silent ones, this reports errors. */
    check(): Promise<UpdaterState> {
      return ipcRenderer.invoke('updater-check');
    },
    /** The consent step — nothing is downloaded until this is called. */
    download(): Promise<UpdaterState> {
      return ipcRenderer.invoke('updater-download');
    },
    /** Install the staged update now; no-op unless a download completed. */
    quitAndInstall(): Promise<boolean> {
      return ipcRenderer.invoke('updater-quit-and-install');
    },
    /** Subscribe to pushed state (download progress). Returns an unsubscribe. */
    onState(callback: (state: UpdaterState) => void): VoidCallback {
      const listener = (_event: unknown, state: UpdaterState) => callback(state);
      ipcRenderer.on('updater-state', listener);
      return () => {
        ipcRenderer.removeListener('updater-state', listener);
      };
    },
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

  openLocalApp(): Promise<void> {
    return ipcRenderer.invoke('open-local-app');
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
