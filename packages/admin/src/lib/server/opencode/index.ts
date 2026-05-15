/**
 * Back-compat barrel for `$lib/server/opencode`.
 *
 * Routes import from this barrel so the module split stays an internal
 * implementation detail. New consumers may import from the focused modules
 * (`./config`, `./catalog`, `./oauth`, `./results`) directly.
 */
export { getCurrentConfig, normalizeProviderConfig, patchConfig, setProviderEnabled } from './config.js';
export type { JsonRecord, RawConfig } from './config.js';
export { loadProviderPage } from './catalog.js';
export { finishOauthFlowAtBase, startOauthFlowAtBase } from './oauth.js';
export { actionFailure, actionSuccess } from './results.js';
