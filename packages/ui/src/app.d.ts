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

  interface Window {
    openpalm?: {
      /** Native harness contract version (design §5.1). Feature-detect new
       *  IPC/env members against this; absent ⇒ pre-contract harness. */
      harnessContractVersion?: number;
      updateStatus?: () => {
        inElectron: boolean;
        currentVersion: string | null;
        latestVersion: string | null;
        latestUrl: string | null;
        updateAvailable: boolean;
        harnessContractVersion?: number;
      };
      notify?: (title: string, body: string) => void;
      restart?: () => Promise<void>;
      restartUiServer?: () => Promise<boolean>;
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
