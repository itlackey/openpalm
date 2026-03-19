/**
 * STT and TTS API calls. Both use OpenAI-compatible APIs.
 */

import { createLogger } from '@openpalm/channels-sdk'
import { config } from './config'

const log = createLogger('channel-voice')

// ── Timeout helper ──────────────────────────────────────────────────────

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

function buildAuthHeaders(apiKey: string): HeadersInit | undefined {
  if (!apiKey) return undefined
  return { Authorization: `Bearer ${apiKey}` }
}

// ── STT ─────────────────────────────────────────────────────────────────

/**
 * Transcribe audio via OpenAI-compatible STT API.
 * Accepts the raw File from the client's FormData.
 */
export async function transcribe(audioFile: File): Promise<string> {
  const form = new FormData()
  form.set('model', config.stt.model)
  form.set('file', audioFile, audioFile.name || 'audio.webm')

  const res = await fetchWithTimeout(
    `${config.stt.baseUrl}/v1/audio/transcriptions`,
    {
      method: 'POST',
      headers: buildAuthHeaders(config.stt.apiKey),
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
 * Returns base64-encoded mp3 string, or null if TTS is not configured or fails.
 * TTS failure is non-fatal — the client still gets the text response.
 */
export async function synthesize(text: string): Promise<string | null> {
  if (!text.trim()) return null

  let res: Response
  try {
    res = await fetchWithTimeout(
      `${config.tts.baseUrl}/v1/audio/speech`,
      {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(config.tts.apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.tts.model,
          input: text,
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
