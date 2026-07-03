/**
 * Canonical list of built-in addon IDs.
 *
 * Single source of truth — imported by both addons.ts and migrations.ts.
 * Update THIS file (and only this file) when adding or removing a built-in addon.
 *
 * Intentionally a pure-constants file with no imports so it can be safely
 * imported from anywhere without risk of circular dependencies.
 */
export const BUILTIN_ADDON_IDS: ReadonlyArray<string> = [
  'api', 'chat', 'discord', 'gateway', 'ollama', 'slack', 'voice',
] as const;
