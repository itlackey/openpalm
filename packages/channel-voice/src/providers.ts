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
      headers: { Authorization: `Bearer ${config.stt.apiKey}` },
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
/** Strip markdown syntax so TTS reads clean prose. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')       // remove code blocks
    .replace(/`([^`]+)`/g, '$1')          // inline code → plain text
    .replace(/\*\*([^*]+)\*\*/g, '$1')    // bold → plain
    .replace(/\*([^*]+)\*/g, '$1')        // italic → plain
    .replace(/^#{1,6}\s+/gm, '')          // headings → plain
    .replace(/^\s*[-*+]\s+/gm, '')        // list markers → plain
    .replace(/^\s*\d+\.\s+/gm, '')        // numbered lists → plain
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → text only
    .replace(/\n{3,}/g, '\n\n')           // collapse excess newlines
    .trim()
}

export async function synthesize(text: string): Promise<string | null> {
  if (!text.trim() || !config.tts.apiKey) return null

  const cleanText = stripMarkdown(text)
  if (!cleanText) return null

  let res: Response
  try {
    res = await fetchWithTimeout(
      `${config.tts.baseUrl}/v1/audio/speech`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.tts.apiKey}`,
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
        Authorization: `Bearer ${config.llm.apiKey}`,
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
