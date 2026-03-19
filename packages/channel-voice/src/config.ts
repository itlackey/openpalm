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

function env(key: string, fallback = ''): string {
  return Bun.env[key] || fallback
}

function envInt(key: string, fallback: number): number {
  const v = Bun.env[key]
  if (!v) return fallback
  const n = parseInt(v, 10)
  return Number.isNaN(n) ? fallback : n
}

// Resolve API key: check dedicated key first, then shared OPENAI_API_KEY.
// Only use OPENAI_API_KEY if the dedicated key is truly unset (not present in env at all),
// to avoid shell-inherited vars overriding .env values unexpectedly.
function resolveApiKey(dedicatedKey: string): string {
  const dedicated = Bun.env[dedicatedKey]
  if (dedicated !== undefined && dedicated !== '') return dedicated
  return Bun.env.OPENAI_API_KEY || ''
}

export const config: Config = {
  server: {
    webRoot: resolve(env('WEB_ROOT', new URL('../web', import.meta.url).pathname)),
  },
  stt: {
    baseUrl: env('STT_BASE_URL', 'https://api.openai.com').replace(/\/$/, ''),
    apiKey: resolveApiKey('STT_API_KEY'),
    model: env('STT_MODEL', 'whisper-1'),
    timeoutMs: envInt('STT_TIMEOUT_MS', 30_000),
  },
  tts: {
    baseUrl: env('TTS_BASE_URL', 'https://api.openai.com').replace(/\/$/, ''),
    apiKey: resolveApiKey('TTS_API_KEY'),
    model: env('TTS_MODEL', 'tts-1'),
    voice: env('TTS_VOICE', 'alloy'),
    timeoutMs: envInt('TTS_TIMEOUT_MS', 30_000),
  },
}
