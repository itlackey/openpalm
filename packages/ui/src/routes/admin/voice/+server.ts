/**
 * GET /admin/voice  — Return current TTS/STT env vars from stack.env
 * PUT /admin/voice  — Write TTS/STT env vars to stack.env
 */
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import { readStackEnv, writeVoiceVars } from '@openpalm/lib';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
} from '$lib/server/helpers.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const env = readStackEnv(state.stackDir);

  return jsonResponse(200, {
    tts: {
      enabled: true,
      engine: env['TTS_ENGINE'] ?? '',
      provider: env['TTS_PROVIDER'] ?? '',
      baseURL: env['TTS_BASE_URL'] ?? '',
      model: env['TTS_MODEL'] ?? '',
      voice: env['TTS_VOICE'] ?? '',
    },
    stt: {
      enabled: true,
      engine: env['STT_ENGINE'] ?? '',
      provider: env['STT_PROVIDER'] ?? '',
      baseURL: env['STT_BASE_URL'] ?? '',
      model: env['STT_MODEL'] ?? '',
      language: env['STT_LANGUAGE'] ?? '',
    },
  }, requestId);
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();

  let body: unknown;
  try {
    body = await event.request.json();
  } catch {
    return errorResponse(400, 'Bad Request', 'Invalid JSON body', {}, requestId);
  }
  if (!body || typeof body !== 'object') {
    return errorResponse(400, 'Bad Request', 'Body must be an object', {}, requestId);
  }

  const b = body as Record<string, unknown>;
  const ttsRaw = b.tts as Record<string, unknown> | undefined;
  const sttRaw = b.stt as Record<string, unknown> | undefined;

  const config: Parameters<typeof writeVoiceVars>[0] = {};

  if (ttsRaw && typeof ttsRaw === 'object') {
    config.tts = {
      enabled: ttsRaw.enabled !== false,
      engine: typeof ttsRaw.engine === 'string' ? ttsRaw.engine : undefined,
      provider: typeof ttsRaw.provider === 'string' ? ttsRaw.provider : undefined,
      baseURL: typeof ttsRaw.baseURL === 'string' ? ttsRaw.baseURL : undefined,
      model: typeof ttsRaw.model === 'string' ? ttsRaw.model : undefined,
      voice: typeof ttsRaw.voice === 'string' ? ttsRaw.voice : undefined,
    };
  }
  if (sttRaw && typeof sttRaw === 'object') {
    config.stt = {
      enabled: sttRaw.enabled !== false,
      engine: typeof sttRaw.engine === 'string' ? sttRaw.engine : undefined,
      provider: typeof sttRaw.provider === 'string' ? sttRaw.provider : undefined,
      baseURL: typeof sttRaw.baseURL === 'string' ? sttRaw.baseURL : undefined,
      model: typeof sttRaw.model === 'string' ? sttRaw.model : undefined,
      language: typeof sttRaw.language === 'string' ? sttRaw.language : undefined,
    };
  }

  writeVoiceVars(config, state.stackDir);

  return jsonResponse(200, { ok: true }, requestId);
};
