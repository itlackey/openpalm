/**
 * GET /api/host/access-status — "what URL do I open on my phone, and does it
 * work?"
 *
 * No user-facing doc in this repo answers that question today (Phase 2 of
 * the LAN-access review, §"make the promise visible"), and the access
 * toggles alone cannot: a toggle is STORED INTENT, and intent can outrun
 * Compose reality — a save whose recreate failed partway, a restored
 * backup, or a hand `docker compose restart` all leave a toggle reading ON
 * while nothing is actually reachable. This endpoint answers with four
 * independently-sourced facts instead of one inferred one:
 *
 *  - `intent`   — the stored toggles (`readAccessToggles`), unchanged from
 *                 what `GET /api/host/stack` already reports.
 *  - `actual`   — what Docker's `compose ps` reports for the two containers
 *                 those toggles publish through (`fetchAccessStatusActual`).
 *                 Degrades to `null` per-container when Docker cannot be
 *                 asked at all — never thrown as an error.
 *  - `urls`     — the concrete addresses to type (`buildLanUrls`): the
 *                 derived `<project>.local` mDNS name plus every non-loopback
 *                 IPv4 address, always computed regardless of whether
 *                 `networkAccess` is currently on — the point is to pair
 *                 "what you would type" with…
 *  - `reachable`— …"does it currently work": a self-probe of the published UI
 *                 port (`checkExistingUiInstance`) that fetches `/api/runtime`
 *                 and confirms it is OUR non-admin container UI, not merely
 *                 that something answers the port.
 *
 *                 The probe targets the address the UI is ACTUALLY published
 *                 on, which is not always loopback. Probing 127.0.0.1
 *                 unconditionally answered a different question than the one
 *                 above it, in both directions: a default loopback-only install
 *                 answered its own probe and reported "reachable" beside LAN
 *                 URLs that reach nothing, while a deliberately narrowed bind
 *                 (`OP_UI_BIND_ADDRESS=192.168.1.50`) reported unreachable
 *                 because Docker publishes `bind:port:target` on that interface
 *                 ONLY and never also on loopback. Loopback-only now reports
 *                 `not_published` — an honest "there is nothing on the LAN to
 *                 reach", distinct from "something should be there and isn't".
 *
 * Guarded exactly like the neighbouring `GET /api/host/stack`:
 * `host:stack:read` capability, then `requireAdmin`.
 */
import type { RequestHandler } from './$types';
import {
  resolvePublishedUiPort,
  buildLanUrls,
  checkExistingUiInstance,
  fetchAccessStatusActual,
  isLoopback,
  readAccessToggles,
  readStackEnv,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { getRequestId, jsonResponse, requireAdmin, requireCapability } from '$lib/server/helpers.js';

/** `0.0.0.0` / `::` / `[::]` — published on every interface, so loopback is a
 *  valid stand-in for the LAN address. Anything else concrete is published on
 *  that interface ALONE and must be probed there. */
function isWildcardBind(bind: string): boolean {
  const v = bind.trim().replace(/^\[|\]$/g, '');
  return v === '0.0.0.0' || v === '::';
}

/**
 * Where to probe the published UI, or null when it is not published at all.
 * An absent bind means loopback — the generated row writes every bind
 * explicitly, so unset is a default and not "inherit from somewhere else".
 */
function probeHostForBind(bind: string | undefined): string | null {
  const value = bind?.trim();
  if (!value || isLoopback(value)) return null;
  return isWildcardBind(value) ? '127.0.0.1' : value;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:read', requestId);
  if (capabilityError) return capabilityError;
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  const state = getState();
  const env = readStackEnv(state.homeDir);
  const port = resolvePublishedUiPort(process.env, env);

  // Docker query and the self-probe are independent of each other — run them
  // together rather than serially. Both are internally never-throwing
  // (fetchAccessStatusActual degrades to null; checkExistingUiInstance
  // degrades to `{status: 'absent'}`), so nothing here needs its own
  // try/catch.
  const probeHost = probeHostForBind(env.OP_UI_BIND_ADDRESS);
  const [actual, instance] = await Promise.all([
    fetchAccessStatusActual(state),
    probeHost === null
      ? Promise.resolve(null)
      : checkExistingUiInstance(port, /* expectedAdmin */ false, { host: probeHost }),
  ]);

  return jsonResponse(
    200,
    {
      intent: readAccessToggles(env),
      actual,
      port,
      urls: buildLanUrls({ port, projectName: env.OP_PROJECT_NAME ?? '' }),
      // `ok` is true only on an EXACT identity match — something answering
      // the port that is NOT our non-admin container UI (a foreign service
      // that happens to own it) must not read as reachable. A loopback-only
      // bind is not a failed probe; there is simply nothing published to reach.
      reachable: instance === null
        ? { status: 'not_published' as const, ok: false, probedHost: null }
        : { status: instance.status, ok: instance.status === 'match', probedHost: probeHost },
    },
    requestId,
  );
};
