/**
 * Client display-mode detection (#511 D8 consumer). A 5-line hand-maintained
 * twin of packages/ui/src/lib/client-context.ts — packages/client never
 * imports packages/ui (purity gate). Browser-side ONLY: initialized in
 * +layout.svelte, never server-computed. On the server (no
 * `navigator`/`window`) it returns the 'browser' default and never throws.
 */
export type ClientDisplayMode = 'electron' | 'standalone-pwa' | 'browser';

export function detectClientDisplayMode(): ClientDisplayMode {
  if (typeof navigator !== 'undefined' && /Electron/.test(navigator.userAgent)) return 'electron';
  if (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches)
    return 'standalone-pwa';
  return 'browser';
}
