/**
 * Re-export state for Bun server routes.
 * Phase 2: delegates to the SvelteKit lib state singleton.
 */
export { getState, _replaceState } from "$lib/server/state.js";
