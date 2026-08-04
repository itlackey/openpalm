/**
 * Landing resolver — the single place that decides where a session lands.
 *
 * PURE by contract: reads `ctx.effectiveCapabilities` — never the global
 * `runtimeContext` store — so hooks.server.ts can call it per-request on the
 * server (where no client store exists) and +layout/svelte code can call it
 * with the store's value. Capability RESOLUTION stays in
 * `resolveCapabilities()`; this function only reads the
 * already-resolved list.
 *
 * Landing matrix:
 *   host:setup capability present:
 *     migration pending          → /attention (precedence over local state)
 *     local not_installed        → /start
 *     local setup_incomplete     → /setup
 *     local installed_offline    → HOST_ADMIN_LANDING
 *     local installed_broken     → HOST_ADMIN_LANDING?tab=diagnostics
 *     otherwise (running)        → /chat
 *   no host:setup capability (non-admin process):
 *     local not_installed        → /start
 *     0 connections              → /connections/new
 *     ≥1 connection              → /chat
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
 * (accessible remotes, plus the local assistant when it is running); in the
 * browser, the connection store supplies its own persisted list.
 */
export type LaunchState = {
  migration: { status: MigrationStatus };
  local: { state: LocalStackState };
  connections: ReadonlyArray<{ id: string }>;
  /**
   * Whether this machine HOSTS a stack — recorded by an install, never
   * inferred (`readHostEnabled`, @openpalm/lib).
   *
   * This is the question `local.state` cannot answer. The managed system/ tree
   * is re-seeded on every launch, so its files say only "the app has run here",
   * not "someone chose to install". Reading intent out of them pinned anyone
   * using a REMOTE assistant to a local-install wizard on every restart.
   */
  hostEnabled?: boolean;
  /**
   * Whether the REQUESTING BROWSER has connections of its own saved.
   *
   * A separate question from `hostEnabled`, with a separate mechanism, because
   * it has a separate owner: connections live in the browser, and one server
   * can be serving many of them. `connections` above answers only "is something
   * reachable from the SERVER right now", which says nothing about what this
   * particular browser has stored.
   *
   * Server-side this arrives as a client hint cookie and is therefore untrusted
   * (see $lib/connections/landing-hint.ts) — it only ever picks between two
   * public client routes.
   */
  browserConnections?: boolean;
};

/** Resolve the landing path for a session. Pure — no I/O, no
 *  global state; the gate is CAPABILITY-driven, not admin-flag-driven. */
export function resolveLanding(ctx: RuntimeContext, state: LaunchState): string {
  // Being ABLE to host (the capability) and actually hosting (the record) are
  // different things, and only both together mean the host landings apply. A
  // host-capable process that hosts nothing wants exactly what a plain client
  // wants, which is why the two branches below collapsed into one.
  const isHost = ctx.effectiveCapabilities.includes('host:setup') && state.hostEnabled === true;

  if (isHost) {
    // OP_HOME migrations only concern a machine that has an OP_HOME worth
    // migrating, so this gate belongs inside the host branch.
    if (state.migration.status === 'pending') return HOST_ATTENTION_LANDING;
    if (state.local.state === 'installed_broken') return `${HOST_ADMIN_LANDING}?tab=diagnostics`;
    if (state.local.state === 'installed_offline') return HOST_ADMIN_LANDING;
    if (state.local.state === 'running') return '/chat';
    // not_installed | setup_incomplete — this machine is meant to host a stack
    // and does not have a working one yet. The wizard is the right place, and
    // it is no longer a trap: nobody who did not ask to host arrives here.
    return '/setup';
  }

  // Not a host: a pure client, wherever it happens to be running. Land on the
  // add-connection surface only when there is nowhere to chat from EITHER
  // source — a reachable local assistant, or connections this browser has
  // saved. Without the second, a browser that already has a remote assistant
  // would be sent to "add a connection" on every launch.
  const somewhereToChat = state.connections.length > 0 || state.browserConnections === true;
  // `?onboarding=1` is what marks this as a first run rather than a deliberate
  // "add another connection" from settings: it is what shows the
  // install-or-connect question (where a stack could be installed at all) and
  // what makes Back a step rather than a way out of the flow.
  return somewhereToChat ? '/chat' : '/connections/new?onboarding=1';
}
