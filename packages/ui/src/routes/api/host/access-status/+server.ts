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
 *  - `reachable`— …"does it currently work": a loopback self-probe of the
 *                 published UI port (`checkExistingUiInstance`) that fetches
 *                 `/api/runtime` and confirms it is OUR non-admin container
 *                 UI, not merely that something answers the port.
 *
 * Guarded exactly like the neighbouring `GET /api/host/stack`:
 * `host:stack:read` capability, then `requireAdmin`.
 */
import type { RequestHandler } from './$types';
import {
  STACK_DEFAULTS,
  buildLanUrls,
  checkExistingUiInstance,
  fetchAccessStatusActual,
  readAccessToggles,
  readStackEnv,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { getRequestId, jsonResponse, requireAdmin, requireCapability } from '$lib/server/helpers.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:read', requestId);
  if (capabilityError) return capabilityError;
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  const state = getState();
  const env = readStackEnv(state.homeDir);
  const port = Number(env.OP_UI_PORT) || STACK_DEFAULTS.ports.ui;

  // Docker query and the self-probe are independent of each other — run them
  // together rather than serially. Both are internally never-throwing
  // (fetchAccessStatusActual degrades to null; checkExistingUiInstance
  // degrades to `{status: 'absent'}`), so nothing here needs its own
  // try/catch.
  const [actual, instance] = await Promise.all([
    fetchAccessStatusActual(state),
    checkExistingUiInstance(port, /* expectedAdmin */ false),
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
      // that happens to own it) must not read as reachable.
      reachable: { status: instance.status, ok: instance.status === 'match' },
    },
    requestId,
  );
};
