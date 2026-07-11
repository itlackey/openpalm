/**
 * Landing resolver — the single place that decides where a session lands
 * (plan ui-runtime-modes-plan.md §6.5, Phase 3 step 1).
 *
 * PURE by contract: reads `ctx.effectiveCapabilities` — never the global
 * `runtimeContext` store — so hooks.server.ts can call it per-request on the
 * server (where no client store exists) and +layout/svelte code can call it
 * with the store's value. Capability RESOLUTION stays in
 * `resolveCapabilities()` (plan §8.6); this function only reads the
 * already-resolved list.
 *
 * Landing matrix (plan §6.5):
 *   host:setup capability present:
 *     migration pending          → /attention (precedence over local state)
 *     local not_installed        → /setup — unless an accessible connection
 *                                  exists, then /chat (the authoritative #440
 *                                  remote-only rule: nothing local to set up
 *                                  is no reason to block a working remote)
 *     local setup_incomplete     → /setup
 *     local installed_offline    → HOST_ADMIN_LANDING
 *     local installed_broken     → HOST_ADMIN_LANDING?tab=diagnostics
 *     otherwise (running)        → /chat
 *   no host:setup capability:
 *     assistant-container        → /chat (always — no host stack in view)
 *     pwa-static, 0 connections  → /connections/new
 *     pwa-static, ≥1 connection  → /chat
 *     anything else              → /chat
 */
import type { LocalStackState } from '@openpalm/lib';
import type { RuntimeContext } from '$lib/types.js';

/**
 * Where the host admin surface lives. Phase 4 moved it from /admin to /host
 * (/admin/* is a dead namespace — router 404, no alias).
 */
export const HOST_ADMIN_LANDING = '/host';

/**
 * The blocking-migration landing surface.
 *
 * K4 (review 2026-07-11): callers that need to know whether a resolved
 * landing is BLOCKING (usage routes must not bypass it) must check
 * membership in BLOCKING_LANDINGS below — never string-compare against this
 * literal directly. Blocking-ness is a property of the landing STATE, not a
 * magic string duplicated at each call site; encoding it only as a literal
 * comparison means a future second blocking landing would return a new
 * string and every literal-match call site would silently keep exempting
 * usage routes from it.
 */
export const HOST_ATTENTION_LANDING = '/attention';

/**
 * Landings that block the usage routes (/chat, /advanced, /connections)
 * from bypassing the launch-routing redirect (hooks.server.ts). Today only
 * HOST_ATTENTION_LANDING is blocking; adding a future second blocking
 * landing means adding it here — the usage-route gate then covers it
 * automatically, with no call-site changes required.
 */
export const BLOCKING_LANDINGS: ReadonlySet<string> = new Set([HOST_ATTENTION_LANDING]);

/** Blocking-migration gate: 'pending' blocks; anything else does not.
 *  Nothing produces 'pending' yet — the gate (and the /attention surface it
 *  routes to) is wired ahead of the first blocking OP_HOME migration. */
export type MigrationStatus = 'pending' | 'none';

/**
 * Launch facts, derived from the launch-status probes that used to feed the
 * /splash page (`local.state` is @openpalm/lib's LocalStackState). On the
 * server, `connections` is the list of connections usable right now
 * (accessible remotes, plus the local assistant when it is running); the
 * static client feeds its own stored connection list.
 */
export type LaunchState = {
  migration: { status: MigrationStatus };
  local: { state: LocalStackState };
  connections: ReadonlyArray<{ id: string }>;
};

/** Resolve the landing path for a session (plan §6.5). Pure — no I/O, no
 *  global state; the gate is CAPABILITY-driven, not hostMode-driven. */
export function resolveLanding(ctx: RuntimeContext, state: LaunchState): string {
  if (ctx.effectiveCapabilities.includes('host:setup')) {
    if (state.migration.status === 'pending') return HOST_ATTENTION_LANDING;
    if (state.local.state === 'not_installed') {
      return state.connections.length === 0 ? '/setup' : '/chat';
    }
    if (state.local.state === 'setup_incomplete') return '/setup';
    if (state.local.state === 'installed_offline') return HOST_ADMIN_LANDING;
    if (state.local.state === 'installed_broken') return `${HOST_ADMIN_LANDING}?tab=diagnostics`;
    return '/chat';
  }
  if (ctx.hostMode === 'assistant-container') return '/chat';
  if (ctx.hostMode === 'pwa-static') {
    return state.connections.length === 0 ? '/connections/new' : '/chat';
  }
  return '/chat';
}
