/**
 * @openpalm/portal-sdk — shared surface for OpenPalm chat portals.
 *
 * `runtime` re-exports the OpenCode client (`OcClient`), the native /event
 * interpreters, and the platform-agnostic helpers (logging, secret files, id
 * lists, message splitting, the conversation queue). `base-portal` adds the
 * `BasePortal` base class and the buffered-turn helpers built on top of them.
 */
export * from './runtime.ts';
export * from './base-portal.ts';
