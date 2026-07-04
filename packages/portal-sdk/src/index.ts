/**
 * @openpalm/portal-sdk — shared surface for OpenPalm chat portals.
 *
 * `runtime` re-exports the OpenCode client (`OcClient`), the native /event
 * interpreters, and the platform-agnostic helpers (logging, secret files, id
 * lists, message splitting, the conversation queue). `base-portal` adds the
 * `BasePortal` base class and the buffered-turn helpers built on top of them.
 * `render-turn` adds the shared rich-UX turn loop (`renderTurn`) and the
 * `ThrottledEditBuffer` both portals' streaming renderers build on.
 * `oc-event-hub` adds the per-principal shared /event subscription (`OcEventHub`)
 * that keeps concurrent same-principal turns on ONE upstream stream.
 */
export * from './runtime.ts';
export * from './base-portal.ts';
export * from './deliver-buffered.ts';
export * from './render-turn.ts';
export * from './oc-event-hub.ts';
