/**
 * Client display-mode detection — plan ui-runtime-modes-plan.md §6.3
 * (issue #509). Browser-side ONLY: initialized in +layout.svelte, never
 * server-computed. On the server (no `navigator`/`window`) it returns the
 * 'browser' default.
 */
import type { ClientDisplayMode } from '$lib/types.js';

export function detectClientDisplayMode(): ClientDisplayMode {
  if (typeof navigator !== 'undefined' && /Electron/.test(navigator.userAgent)) return 'electron';
  if (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches)
    return 'standalone-pwa';
  return 'browser';
}
