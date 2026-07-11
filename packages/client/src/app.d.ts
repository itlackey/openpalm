// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  interface Window {
    /**
     * Electron's preload bridge (mirrors packages/ui/src/app.d.ts — trimmed
     * to the one member the client SPA consumes, §B12 desktop
     * notifications). Absent when running as a plain browser tab/PWA, which
     * is why `notifyAssistantReply`/`notifyAssistantError`
     * ($lib/desktop-notifications.ts) feature-detect it and fall back to the
     * standard web `Notification` API.
     */
    openpalm?: {
      notify?: (title: string, body: string) => void;
    };
  }
}

export {};
