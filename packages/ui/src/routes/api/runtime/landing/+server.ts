/**
 * GET /api/runtime/landing — public landing-resolver endpoint (review
 * findings J2/J3, plan ui-runtime-modes-plan.md §6.5).
 *
 * PUBLIC by design (same posture as /api/setup/status and /api/runtime): no
 * auth is consulted. Wraps the SAME `resolveRequestLanding()` the host UI's
 * own hooks.server.ts navigation guard uses, so any external caller —
 * Electron's `resolveInitialUrl`, `openpalm app`/`openpalm admin`, a future
 * client — can ask "where should a session land right now?" without issuing
 * a document navigation and parsing a redirect.
 *
 * J2: this is what lets Electron's default surface reach the landing
 * matrix's recovery branches (installed_offline -> /host, installed_broken ->
 * /host?tab=diagnostics) instead of only ever seeing /setup or /chat via the
 * old /api/setup/status probe.
 * J3: nothing produces a 'pending' migration status yet, but
 * resolveRequestLanding already routes that to /attention — this endpoint
 * needs no changes when the first blocking migration lands.
 *
 * Cache-Control: no-store — a stale landing (e.g. cached across a stack
 * restart) would misroute a launcher into a dead surface.
 */
import { json } from '@sveltejs/kit';
import { resolveRequestLanding } from '$lib/server/landing.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  const landing = await resolveRequestLanding(event);
  return json(
    { landing },
    { headers: { 'cache-control': 'no-store' } },
  );
};
