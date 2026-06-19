import type { FeatureFlags } from '$lib/types.js';

/**
 * Compute feature flags from environment variables.
 * Called server-side on every request via +layout.server.ts.
 *
 * admin: enabled when the UI is hosted inside the Electron harness
 * (OP_INSIDE_ELECTRON=1, injected by packages/electron/src/main.ts) or when
 * OP_ENABLE_ADMIN=1 is set explicitly (local dev / testing without Electron).
 */
export function computeFeatureFlags(): FeatureFlags {
  return {
    admin:
      process.env.OP_INSIDE_ELECTRON === '1' ||
      process.env.OP_ENABLE_ADMIN === '1',
  };
}
