/**
 * POST /api/speak — proxy text → audio via the configured TTS endpoint.
 *
 * Body: { text: string, voice?: string, format?: string }
 * Response: streamed audio bytes (audio/wav by default) on 200,
 *           or 503 if TTS isn't configured server-side.
 *
 * Mirrors /api/transcribe: the voice container binds to loopback
 * (127.0.0.1:8880), so the browser can't reach it directly under CORS.
 * The UI server hops on the operator's behalf.
 */
import type { RequestHandler } from './$types';
import { readStackEnv } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  requireAdmin,
} from '$lib/server/helpers.js';

const DEFAULT_MODEL = 'kokoro';
const DEFAULT_VOICE = 'bf_isabella';
// WAV is universal across browsers and Electron builds; mp3 fails on some
// Linux/Firefox configs and bare Electron without ffmpeg. Voice container
// (kokoro-fastapi) supports wav via `response_format`.
const DEFAULT_FORMAT = 'wav';
const UPSTREAM_TIMEOUT_MS = 60_000;

function redactKey(s: string): string {
  return s
    .replace(/(sk-[A-Za-z0-9_-]{4,})/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***');
}

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  // Read saved Voice settings from stack.env ON DISK (source of truth written
  // by the wizard / Admin → Voice). The UI host process isn't started with
  // stack.env loaded, and the wizard writes voice config after the UI starts —
  // so process.env alone was empty and 503'd even when voice was configured
  // (the "voice broken after install" bug). process.env stays a dev fallback.
  // OP_ prefix only — a leaked unprefixed shell TTS_* var must never override
  // the saved selection.
  const stackEnv = readStackEnv(getState().stackDir);
  // `||` not `??`: an empty value on disk must fall back to process.env, not
  // shadow it (see transcribe/+server.ts for the desktop-install rationale).
  const ttsBaseURL = (stackEnv.OP_TTS_BASE_URL || process.env.OP_TTS_BASE_URL || '').trim();
  const ttsModel = (stackEnv.OP_TTS_MODEL || process.env.OP_TTS_MODEL || '').trim() || DEFAULT_MODEL;
  const ttsVoice = (stackEnv.OP_TTS_VOICE || process.env.OP_TTS_VOICE || '').trim() || DEFAULT_VOICE;
  // API key (if any) is a secret — not in non-secret stack.env — so it stays on
  // process.env. The bundled OpenPalm Voice needs no key.
  const ttsApiKey = (process.env.OP_TTS_API_KEY ?? '').trim();

  if (!ttsBaseURL) {
    return errorResponse(
      503,
      'tts_not_configured',
      'Configure a TTS engine in Admin → Voice settings.',
      {},
      requestId,
    );
  }

  let body: unknown;
  try {
    body = await event.request.json();
  } catch {
    return errorResponse(400, 'bad_request', 'Invalid JSON body', {}, requestId);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) {
    return errorResponse(400, 'bad_request', '"text" is required', {}, requestId);
  }
  const voice = typeof b.voice === 'string' && b.voice.trim() ? b.voice.trim() : ttsVoice;
  const format = typeof b.format === 'string' && b.format.trim() ? b.format.trim() : DEFAULT_FORMAT;

  const upstreamUrl = ttsBaseURL.replace(/\/+$/, '') + '/v1/audio/speech';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ttsApiKey) headers['authorization'] = `Bearer ${ttsApiKey}`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: ttsModel, voice, input: text, response_format: format }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(
      502,
      'upstream_error',
      `Could not reach TTS endpoint: ${redactKey(msg)}`,
      { upstream: upstreamUrl },
      requestId,
    );
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    return errorResponse(
      502,
      'upstream_error',
      `TTS endpoint returned ${upstream.status}`,
      { upstreamStatus: upstream.status, body: redactKey(body).slice(0, 500) },
      requestId,
    );
  }

  // Stream the audio response back unchanged.
  const responseHeaders = new Headers();
  responseHeaders.set('content-type', upstream.headers.get('content-type') ?? 'audio/wav');
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) responseHeaders.set('content-length', contentLength);
  responseHeaders.set('x-request-id', requestId);

  return new Response(upstream.body, {
    status: 200,
    headers: responseHeaders,
  });
};
