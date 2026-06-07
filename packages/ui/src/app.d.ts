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
      updateStatus?: () => {
        inElectron: boolean;
        currentVersion: string | null;
        latestVersion: string | null;
        latestUrl: string | null;
        updateAvailable: boolean;
      };
      notify?: (title: string, body: string) => void;
      restart?: () => Promise<void>;
      onGlobalMicToggle?: (callback: () => void) => (() => void) | void;
    };
  }
}

export {};
