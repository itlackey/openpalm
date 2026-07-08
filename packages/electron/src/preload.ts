// Preload script — exposes a minimal API to the renderer over contextBridge.
// The UI prefers HTTP (via /api/electron/update-status) but can also call
// `window.openpalm.updateStatus()` when running inside the Electron shell.

import { contextBridge, ipcRenderer } from 'electron';
import { HARNESS_CONTRACT_VERSION } from './harness-contract.js';

interface UpdateStatus {
  inElectron: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  latestUrl: string | null;
  updateAvailable: boolean;
  /** Native harness contract version this shell provides (design §5.1/§5.3).
   *  The UI feature-detects new IPC/env against this; an absent/older value
   *  means "don't use post-N bridge members." */
  harnessContractVersion: number;
}

interface LaunchOnLoginStatus {
  supported: boolean;
  enabled: boolean;
}

type VoidCallback = () => void;

contextBridge.exposeInMainWorld('openpalm', {
  /**
   * The native harness contract version this shell implements (design §5.1).
   * Exposed as a dedicated field (not just inside updateStatus) so the UI can
   * cheaply feature-detect new IPC/env members and fall back to the HTTP path.
   */
  harnessContractVersion: HARNESS_CONTRACT_VERSION,

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
      harnessContractVersion: HARNESS_CONTRACT_VERSION,
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

  /**
   * Restart only the UI server child process (NOT the whole app) so a freshly
   * downloaded data/ui (new @openpalm/lib + migrations) takes effect without a
   * full relaunch. Resolves true once the new UI child is ready (design §6.2).
   */
  restartUiServer(): Promise<boolean> {
    return ipcRenderer.invoke('restart-ui-server');
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

  // ── Harness-internal screens (NOT part of the §5.1 control-plane contract) ──
  // These are used only by the harness's own Docker-missing splash screen (a
  // data: URL rendered before the control-plane UI exists). The SvelteKit UI
  // never calls them, so adding them does NOT change the harness↔control-plane
  // contract surface and does NOT bump HARNESS_CONTRACT_VERSION.

  /** Open the official Docker install page in the system browser. */
  openDockerInstall(): void {
    ipcRenderer.send('open-docker-install');
  },

  /** Re-run the Docker preflight after the user installs/starts Docker. */
  retryDockerPreflight(): void {
    ipcRenderer.send('retry-docker-preflight');
  },
});
