declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      /** Admin auth role resolved from the `op_session` cookie by hooks.server.ts. */
      role: 'admin' | null;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  /** Mirrors UpdaterState in packages/electron/src/updater.ts. */
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

  interface Window {
    openpalm?: {
      /** Full-application update surface (#572). Present only in the desktop
       *  shell — a browser has no `openpalm` object at all, which is how the
       *  UI knows to hide the desktop-only update controls. */
      updater?: {
        state: () => Promise<UpdaterState>;
        check: () => Promise<UpdaterState>;
        download: () => Promise<UpdaterState>;
        quitAndInstall: () => Promise<boolean>;
        onState: (callback: (state: UpdaterState) => void) => () => void;
      };
      notify?: (title: string, body: string) => void;
      restart?: () => Promise<void>;
      openLocalApp?: () => Promise<void>;
      launchOnLoginStatus?: () => Promise<{
        supported: boolean;
        enabled: boolean;
      }>;
      setLaunchOnLogin?: (enabled: boolean) => Promise<{
        supported: boolean;
        enabled: boolean;
      }>;
      setTrayMicRecording?: (recording: boolean) => Promise<void>;
      // biome-ignore lint/suspicious/noConfusingVoidType: registration may return an unsubscribe fn or nothing (void); switching to undefined would reject void-returning implementations.
      onGlobalMicToggle?: (callback: () => void) => (() => void) | void;
    };
  }
}

export {};
