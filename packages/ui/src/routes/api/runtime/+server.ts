/**
 * GET /api/runtime — public runtime-context endpoint (issue #509).
 *
 * PUBLIC by design: no auth is consulted. The body is the ServerRuntimeContext
 * whose `version` field is the contract-version handshake remote/hosted
 * clients use to detect version skew before enabling features. It carries no
 * secrets — mode, capability names, versions, and route pointers only.
 */
import { json } from '@sveltejs/kit';
import { computeServerRuntimeContext, computeVoiceRuntime } from '$lib/server/features.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
  const ctx = computeServerRuntimeContext(event);
  const voice = computeVoiceRuntime();
  return json({
    ...ctx,
    ...(voice ? { voice } : {}),
  });
};
