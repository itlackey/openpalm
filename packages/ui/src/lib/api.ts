// ── OpenPalm admin API client (barrel) ────────────────────────────────────────
//
// The former 975-line god-client has been split into a shared transport core
// (`./api/core.ts`) plus one cohesive domain client module per feature area
// (`./api/voice.ts`, `./api/versions.ts`, `./api/akm.ts`, …). Each module owns
// its own endpoint functions AND the DTOs those endpoints return.
//
// This barrel re-exports every public symbol so existing call sites keep
// importing from `$lib/api` (`import { fetchVersions, type AkmHealth } from
// '$lib/api.js'`) unchanged. Prefer importing from the specific domain module
// in new code (e.g. `$lib/api/chat.js`); the barrel exists for compatibility.

export {
  buildHeaders,
  request,
  requireOk,
  readErrorMessage,
  requireJsonBody,
} from './api/core.js';

export * from './api/health.js';
export * from './api/containers.js';
export * from './api/versions.js';
export * from './api/backups.js';
export * from './api/automations.js';
export * from './api/addons.js';
export * from './api/secrets.js';
export * from './api/voice.js';
export * from './api/akm.js';
export * from './api/endpoints.js';
export * from './api/chat.js';
export * from './api/providers.js';
export * from './api/errors.js';
