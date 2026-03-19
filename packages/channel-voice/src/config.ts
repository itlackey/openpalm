/**
 * Typed environment configuration for the voice channel.
 * Bun loads .env automatically. Uses Bun.env, not process.env.
 */

import { resolve } from 'node:path'

interface Config {
  server: { webRoot: string }
  stt: { baseUrl: string; apiKey: string; model: string; timeoutMs: number }
  tts: { baseUrl: string; apiKey: string; model: string; voice: string; timeoutMs: number }
}

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com'

function env(key: string, fallback = ''): string {
  return Bun.env[key] ?? fallback
}

function envInt(key: string, fallback: number): number {
  const v = Bun.env[key]
  if (!v) return fallback
  const n = parseInt(v, 10)
  return Number.isNaN(n) ? fallback : n
}

function normalizeApiBaseUrl(value: string): string {
  return value.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

// Resolve API key: check dedicated key first, then shared OPENAI_API_KEY.
// If the dedicated key is present, even as an empty string, respect it so
// callers can intentionally disable the shared fallback for keyless providers.
function resolveApiKey(dedicatedKey: string): string {
  const dedicated = Bun.env[dedicatedKey]
  if (dedicated !== undefined) return dedicated
  return Bun.env.OPENAI_API_KEY ?? ''
}

export function hasConfiguredProvider(baseUrl: string, apiKey: string): boolean {
  if (!baseUrl) return false
  return apiKey !== '' || baseUrl !== DEFAULT_OPENAI_BASE_URL
}

export const config: Config = {
  server: {
    webRoot: resolve(env('WEB_ROOT', new URL('../web', import.meta.url).pathname)),
  },
  stt: {
    baseUrl: normalizeApiBaseUrl(env('STT_BASE_URL', DEFAULT_OPENAI_BASE_URL)),
    apiKey: resolveApiKey('STT_API_KEY'),
    model: env('STT_MODEL', 'whisper-1'),
    timeoutMs: envInt('STT_TIMEOUT_MS', 30_000),
  },
  tts: {
    baseUrl: normalizeApiBaseUrl(env('TTS_BASE_URL', DEFAULT_OPENAI_BASE_URL)),
    apiKey: resolveApiKey('TTS_API_KEY'),
    model: env('TTS_MODEL', 'tts-1'),
    voice: env('TTS_VOICE', 'alloy'),
    timeoutMs: envInt('TTS_TIMEOUT_MS', 30_000),
  },
}
