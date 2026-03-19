/**
 * STT and TTS API calls. Both use OpenAI-compatible APIs.
 * Auth headers are only sent when an API key is configured,
 * allowing keyless local providers (whisper-local, kokoro, piper).
 */

import { createLogger } from '@openpalm/channels-sdk'
import { config } from './config'

const log = createLogger('channel-voice')

// ── Helpers ────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Build auth headers only when a key is present (keyless providers get none). */
function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

/** Strip markdown syntax so TTS reads clean prose. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── STT ─────────────────────────────────────────────────────────────────

/**
 * Transcribe audio via OpenAI-compatible STT API.
 * Auth header is omitted for keyless providers (e.g. local whisper).
 */
export async function transcribe(audioFile: File): Promise<string> {
  const form = new FormData()
  form.set('model', config.stt.model)
  form.set('file', audioFile, audioFile.name || 'audio.webm')

  const res = await fetchWithTimeout(
    `${config.stt.baseUrl}/v1/audio/transcriptions`,
    {
      method: 'POST',
      headers: authHeaders(config.stt.apiKey),
      body: form,
    },
    config.stt.timeoutMs,
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`STT failed (${res.status}): ${body || res.statusText}`)
  }

  const data = (await res.json()) as { text?: string }
  return data.text || ''
}

// ── TTS ─────────────────────────────────────────────────────────────────

/**
 * Synthesize text to audio via OpenAI-compatible TTS API.
 * Returns base64-encoded mp3, or null if TTS is not configured or fails.
 * Auth header is omitted for keyless providers (e.g. kokoro, piper).
 */
export async function synthesize(text: string): Promise<string | null> {
  if (!text.trim() || !config.tts.configured) return null

  const cleanText = stripMarkdown(text)
  if (!cleanText) return null

  let res: Response
  try {
    res = await fetchWithTimeout(
      `${config.tts.baseUrl}/v1/audio/speech`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(config.tts.apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.tts.model,
          input: cleanText,
          voice: config.tts.voice,
          response_format: 'mp3',
        }),
      },
      config.tts.timeoutMs,
    )
  } catch (err) {
    log.error('TTS request error', { error: (err as Error).message })
    return null
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    log.error('TTS API error', { status: res.status, body: body || res.statusText })
    return null
  }

  const buffer = await res.arrayBuffer()
  return Buffer.from(buffer).toString('base64')
}

// ── LLM (direct fallback when guardian is unavailable) ─────────────────

/**
 * Direct LLM call via OpenAI-compatible chat completions API.
 * Used as fallback when the guardian/assistant pipeline is unreachable.
 */
export async function chatCompletion(prompt: string): Promise<string> {
  if (!config.llm.apiKey) throw new Error('No LLM API key configured and guardian unavailable')

  const res = await fetchWithTimeout(
    `${config.llm.baseUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(config.llm.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.llm.model,
        messages: [
          { role: 'system', content: config.llm.systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
    },
    config.llm.timeoutMs,
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`LLM failed (${res.status}): ${body || res.statusText}`)
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error('Empty response from LLM')
  return text
}
