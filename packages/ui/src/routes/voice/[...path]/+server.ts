/**
 * /voice/* — transparent same-origin pass-through to the local voice
 * container's OpenAI-compatible surface.
 *
 * The chat client's "OpenPalm Voice" provider calls this path (advertised as
 * `voice.url = '/voice'` in the runtime handshake) instead of the container's
 * host port directly. Same-origin is the point:
 *   - no CORS anywhere (the container stays a plain, unmodified upstream),
 *   - it works with the container's default loopback-only binding — a LAN
 *     browser reaches the UI origin, and this process makes the local hop —
 *     so no port ever needs to be opened for voice.
 *
 * Unlike the retired /api/speak and /api/transcribe relays, this holds NO
 * provider configuration and speaks no protocol of its own: the request
 * path/method/body/query pass through 1:1 (the same transparent-proxy
 * pattern as the guardian's /oc). Provider choice lives in the client.
 *
 * Availability mirrors the advertisement (computeVoiceRuntime): the voice
 * addon must be enabled in readable stack state. Every UI server is a host
 * process (`openpalm ui serve` / Electron) with a loopback path to the
 * container, so availability is deliberately NOT gated on admin capability —
 * using voice is not a privileged host operation and a served non-admin
 * process must still pass it through. Auth is the ordinary session check —
 * no host:* capability for the same reason.
 */
import type { RequestHandler } from './$types';
import { listEnabledAddonIds } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { canServeLocalVoice } from '$lib/server/features.js';
import { errorResponse, getRequestId, requireAdmin } from '$lib/server/helpers.js';
import { VOICE_ADDON, voiceHostPort } from '$lib/server/voice/bring-up.js';

// Bounds connection + response HEADERS, not the streamed body — see below.
const UPSTREAM_TIMEOUT_MS = 60_000;

/** The OpenAI-compatible surface the container serves — nothing else passes. */
const ALLOWED_PATHS = new Set(['v1/audio/speech', 'v1/audio/transcriptions', 'v1/models', 'health']);

function unavailable(requestId: string): Response | null {
  // A UI process with no loopback path to a voice container (the assistant
  // container's served co-process) must never claim to serve voice, even if
  // it can read stack state — see canServeLocalVoice.
  if (!canServeLocalVoice()) {
    return errorResponse(503, 'voice_unavailable', 'This process has no local voice service.', {}, requestId);
  }
  try {
    if (!listEnabledAddonIds(getState().homeDir).includes(VOICE_ADDON)) {
      return errorResponse(
        503,
        'voice_unavailable',
        'The voice capability is not enabled on this host (Admin → Capabilities).',
        {},
        requestId,
      );
    }
  } catch {
    return errorResponse(503, 'voice_unavailable', 'This process has no local voice service.', {}, requestId);
  }
  return null;
}

const handle: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const gate = unavailable(requestId);
  if (gate) return gate;

  const path = event.params.path.replace(/\/+$/, '');
  if (!ALLOWED_PATHS.has(path)) {
    return errorResponse(404, 'not_found', `No such voice endpoint: ${path}`, {}, requestId);
  }

  const upstreamUrl = `http://127.0.0.1:${voiceHostPort()}/${path}${event.url.search}`;
  // Buffer the body rather than streaming: the boundary-bearing content-type
  // header passes through untouched, so multipart uploads survive intact,
  // and node's fetch needs no duplex plumbing. GET and HEAD carry no body —
  // undici rejects a body on either, and SvelteKit routes HEAD through the
  // GET handler, so both must be treated as bodyless.
  const method = event.request.method;
  const body = method === 'GET' || method === 'HEAD' ? undefined : await event.request.arrayBuffer();
  const headers: Record<string, string> = {};
  const contentType = event.request.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;

  // Time out the CONNECTION + headers only. Aborting the shared signal once the
  // body is streaming would sever a long TTS synthesis (big text on a CPU
  // kokoro profile streams audio past 60s) mid-transfer — the client already
  // has a 200 and would get a truncated blob instead of a clean error. Clear
  // the timer as soon as headers arrive and let the body stream to completion.
  const controller = new AbortController();
  const headerTimeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch {
    clearTimeout(headerTimeout);
    return errorResponse(
      502,
      'voice_unreachable',
      'The voice container is not responding — it may still be starting.',
      {},
      requestId,
    );
  }
  clearTimeout(headerTimeout);

  const responseHeaders = new Headers();
  const upstreamType = upstream.headers.get('content-type');
  if (upstreamType) responseHeaders.set('content-type', upstreamType);
  // Deliberately NOT forwarding content-length: node's fetch transparently
  // decompresses a gzip/br upstream while exposing the ORIGINAL (compressed)
  // content-length, so forwarding it truncates the decompressed stream the
  // browser actually receives. Letting the adapter chunk the body is correct
  // for both buffered JSON and streamed audio.
  responseHeaders.set('x-request-id', requestId);

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
};

export const GET = handle;
export const POST = handle;
