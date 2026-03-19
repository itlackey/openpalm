/**
 * Typed environment configuration for the voice channel.
 * Bun loads .env automatically. Uses Bun.env, not process.env.
 */

import { resolve } from 'node:path'

interface Config {
  server: { webRoot: string }
  stt: { baseUrl: string; apiKey: string; model: string; timeoutMs: number; configured: boolean }
  tts: { baseUrl: string; apiKey: string; model: string; voice: string; timeoutMs: number; configured: boolean }
  llm: { baseUrl: string; apiKey: string; model: string; timeoutMs: number; systemPrompt: string }
}

// env uses ?? so an explicit empty value (KEY=) clears the default.
// envOrDefault uses || so empty strings still get the fallback (for models, voices, etc).
function env(key: string, fallback = ''): string {
  return Bun.env[key] ?? fallback
}

function envOrDefault(key: string, fallback: string): string {
  return Bun.env[key] || fallback
}

function envInt(key: string, fallback: number): number {
  const v = Bun.env[key]
  if (v === undefined || v === '') return fallback
  const n = parseInt(v, 10)
  return Number.isNaN(n) ? fallback : n
}

// Resolve API key: check dedicated key first, then shared OPENAI_API_KEY.
// Falls back to OPENAI_API_KEY only when the dedicated key is absent or
// explicitly empty — an empty dedicated key means "no key" (keyless provider).
function resolveApiKey(dedicatedKey: string): string {
  const dedicated = Bun.env[dedicatedKey]
  if (dedicated !== undefined && dedicated !== '') return dedicated
  return Bun.env.OPENAI_API_KEY ?? ''
}

// STT/TTS are considered "configured" when a base URL is set (even without
// a key — local providers like whisper-local, kokoro, piper are keyless).
function isProviderConfigured(baseUrl: string): boolean {
  return baseUrl !== ''
}

const sttBaseUrl = env('STT_BASE_URL').replace(/\/$/, '')
const ttsBaseUrl = env('TTS_BASE_URL').replace(/\/$/, '')

export const config: Config = {
  server: {
    webRoot: resolve(env('WEB_ROOT', new URL('../web', import.meta.url).pathname)),
  },
  stt: {
    baseUrl: sttBaseUrl,
    apiKey: resolveApiKey('STT_API_KEY'),
    model: envOrDefault('STT_MODEL', 'whisper-1'),
    timeoutMs: envInt('STT_TIMEOUT_MS', 30_000),
    configured: isProviderConfigured(sttBaseUrl),
  },
  tts: {
    baseUrl: ttsBaseUrl,
    apiKey: resolveApiKey('TTS_API_KEY'),
    model: envOrDefault('TTS_MODEL', 'tts-1'),
    voice: envOrDefault('TTS_VOICE', 'alloy'),
    timeoutMs: envInt('TTS_TIMEOUT_MS', 30_000),
    configured: isProviderConfigured(ttsBaseUrl),
  },
  llm: {
    baseUrl: envOrDefault('LLM_BASE_URL', 'http://localhost:11434').replace(/\/$/, ''),
    apiKey: envOrDefault('LLM_API_KEY', 'ollama'),
    model: envOrDefault('LLM_MODEL', 'qwen2.5:3b'),
    timeoutMs: envInt('LLM_TIMEOUT_MS', 60_000),
    systemPrompt: env('LLM_SYSTEM_PROMPT', 'You are a helpful voice assistant. Respond conversationally and concisely. Do not use markdown formatting.'),
  },
}
