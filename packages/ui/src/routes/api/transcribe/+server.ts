/**
 * POST /api/transcribe — proxy a browser-recorded audio Blob to the
 * configured OpenAI-compatible STT endpoint (Whisper-style).
 *
 * Browser-native STT path: the navbar mic records via MediaRecorder and POSTs
 * the resulting Blob here. The server forwards to ${STT_BASE_URL}/v1/audio/transcriptions
 * with `file`, `model`, `language`, `response_format=json`, and returns
 * `{ text }`.
 */
import type { RequestHandler } from './$types';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
} from '$lib/server/helpers.js';

const DEFAULT_MODEL = 'whisper-1';
const UPSTREAM_TIMEOUT_MS = 60_000;

function redactKey(s: string): string {
  // Best-effort redact api keys before logging upstream errors.
  return s
    .replace(/(sk-[A-Za-z0-9_-]{4,})/g, 'sk-***')
    .replace(/(hf_[A-Za-z0-9_-]{4,})/gi, 'hf_***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***');
}

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  // OP_ prefix is mandatory — unprefixed STT_*/TTS_* vars are owned by
  // other ecosystems and operators routinely have them in their shell
  // pointing at unrelated endpoints. Reading only the namespaced names
  // keeps a leaked shell var from silently overriding saved settings.
  const sttBaseURL = (process.env.OP_STT_BASE_URL ?? '').trim();
  const sttModel = (process.env.OP_STT_MODEL ?? '').trim() || DEFAULT_MODEL;
  const sttLanguageEnv = (process.env.OP_STT_LANGUAGE ?? '').trim();
  const sttApiKey = (process.env.OP_STT_API_KEY ?? '').trim();

  if (!sttBaseURL) {
    return errorResponse(
      503,
      'stt_not_configured',
      'Configure an STT engine in Admin → Voice settings.',
      {},
      requestId,
    );
  }

  let inboundForm: FormData;
  try {
    inboundForm = await event.request.formData();
  } catch {
    return errorResponse(400, 'bad_request', 'Body must be multipart/form-data', {}, requestId);
  }

  const audio = inboundForm.get('audio');
  if (!(audio instanceof Blob)) {
    return errorResponse(400, 'bad_request', 'Missing "audio" field (Blob)', {}, requestId);
  }

  const languageReq = inboundForm.get('language');
  const promptReq = inboundForm.get('prompt');
  const language = typeof languageReq === 'string' && languageReq.trim()
    ? languageReq.trim()
    : sttLanguageEnv;

  // Build the outgoing multipart per the OpenAI Whisper API.
  const outForm = new FormData();
  // Whisper expects a filename so the upstream can sniff the codec.
  const filename = (audio as File).name || 'recording.webm';
  outForm.append('file', audio, filename);
  outForm.append('model', sttModel);
  outForm.append('response_format', 'json');
  if (language) outForm.append('language', language);
  if (typeof promptReq === 'string' && promptReq.trim()) {
    outForm.append('prompt', promptReq.trim());
  }

  const upstreamUrl = sttBaseURL.replace(/\/+$/, '') + '/v1/audio/transcriptions';
  const headers: Record<string, string> = {};
  if (sttApiKey) headers['authorization'] = `Bearer ${sttApiKey}`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: outForm,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(
      502,
      'upstream_error',
      `Could not reach STT endpoint: ${redactKey(msg)}`,
      { upstream: upstreamUrl },
      requestId,
    );
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    const snippet = redactKey(body).slice(0, 500);
    return errorResponse(
      502,
      'upstream_error',
      `STT endpoint returned ${upstream.status}`,
      { upstreamStatus: upstream.status, body: snippet },
      requestId,
    );
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return errorResponse(
      502,
      'upstream_error',
      'STT endpoint returned a non-JSON response',
      { upstreamStatus: upstream.status },
      requestId,
    );
  }

  const text = typeof (payload as { text?: unknown })?.text === 'string'
    ? ((payload as { text: string }).text)
    : '';

  return jsonResponse(200, { text }, requestId);
};
