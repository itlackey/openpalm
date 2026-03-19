/**
 * OpenPalm Channel Voice — Voice-driven conversational channel.
 *
 * Receives audio, transcribes it (STT), forwards the transcript to the
 * guardian via the channels SDK, gets the LLM response, synthesizes it
 * to audio (TTS), and returns everything.
 *
 * Endpoints:
 *   POST /api/pipeline  — Full voice pipeline (audio in -> text + audio out)
 *   GET  /api/health    — Health check with STT/TTS config info
 *   GET  /*             — Static file serving from web/ directory
 */

import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { BaseChannel, type HandleResult, createLogger } from '@openpalm/channels-sdk'
import type { GuardianSuccessResponse } from '@openpalm/channels-sdk'
import { config, hasConfiguredProvider } from './config'
import { transcribe, synthesize } from './providers'

// ── MIME types for static file serving ──────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
}

function getSessionKey(req: Request): string | undefined {
  const raw = req.headers.get('x-openpalm-session-key')?.trim()
  if (!raw) return undefined
  if (raw.length > 256) return undefined
  return raw
}

function getUserId(req: Request, sessionKey?: string): string {
  const forwardedFor = req.headers.get('x-forwarded-for')
  const forwardedIp = forwardedFor?.split(',')[0]?.trim()
  const realIp = req.headers.get('x-real-ip')?.trim()
  const clientIp = forwardedIp || realIp
  if (clientIp) return clientIp
  if (sessionKey) return `voice:${sessionKey}`
  return `voice:${crypto.randomUUID()}`
}

// ── Channel ─────────────────────────────────────────────────────────────

export default class VoiceChannel extends BaseChannel {
  name = 'voice'

  async route(req: Request, url: URL): Promise<Response | null> {
    // POST /api/pipeline — full voice pipeline
    if (url.pathname === '/api/pipeline' && req.method === 'POST') {
      return this.handlePipeline(req)
    }

    // GET /api/health — health check with provider info
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return this.json(200, {
        ok: true,
        service: 'channel-voice',
        stt: { model: config.stt.model, configured: hasConfiguredProvider(config.stt.baseUrl, config.stt.apiKey) },
        tts: { model: config.tts.model, voice: config.tts.voice, configured: hasConfiguredProvider(config.tts.baseUrl, config.tts.apiKey) },
      })
    }

    // GET /* — serve static files from web/ directory
    if (req.method === 'GET' || req.method === 'HEAD') {
      return this.serveStatic(req, url)
    }

    return null
  }

  // ── Pipeline ────────────────────────────────────────────────────────

  private async handlePipeline(req: Request): Promise<Response> {
    // Parse FormData
    let form: FormData
    try {
      form = await req.formData()
    } catch {
      return this.json(400, { error: 'Invalid form data' })
    }

    const audioFile = form.get('audio') ?? form.get('file')
    const textField = form.get('text')

    // Must provide either audio or text
    if (!(audioFile instanceof File) && !textField) {
      return this.json(400, { error: 'Missing audio file or text' })
    }
    if (audioFile instanceof File && audioFile.size > 25 * 1024 * 1024) {
      return this.json(413, { error: 'Audio too large (max 25MB)' })
    }

    const sessionKey = getSessionKey(req)
    const userId = getUserId(req, sessionKey)

    // Step 1: STT — transcribe audio, or use provided text (browser STT fallback)
    let transcript: string
    if (typeof textField === 'string' && textField.trim()) {
      transcript = textField.trim()
    } else if (audioFile instanceof File) {
      if (!hasConfiguredProvider(config.stt.baseUrl, config.stt.apiKey)) {
        return this.json(400, { error: 'STT not configured', code: 'stt_not_configured' })
      }
      try {
        transcript = await transcribe(audioFile)
      } catch (err) {
        this.log('error', 'STT failed', { error: (err as Error).message })
        return this.json(502, { error: `Transcription failed: ${(err as Error).message}`, code: 'stt_error' })
      }
    } else {
      transcript = ''
    }

    if (!transcript.trim()) {
      return this.json(200, { transcript: '', response: '', audio: null })
    }

    // Step 2: Forward transcript to guardian via channels SDK
    let answer: string
    try {
      const guardianResp = await this.forward({
        userId,
        text: transcript,
        metadata: sessionKey ? { sessionKey } : undefined,
      })

      if (!guardianResp.ok) {
        this.log('error', 'Guardian error', { status: guardianResp.status })
        return this.json(502, { error: `Guardian error (${guardianResp.status})` })
      }

      const data = (await guardianResp.json()) as GuardianSuccessResponse
      if (typeof data.answer !== 'string') {
        this.log('error', 'Guardian returned invalid response shape')
        return this.json(502, { error: 'Guardian returned an invalid response', code: 'guardian_bad_response' })
      }

      answer = data.answer
    } catch (err) {
      this.log('error', 'Guardian communication error', { error: (err as Error).message })
      return this.json(502, { error: 'Guardian unavailable' })
    }

    // Step 3: TTS — synthesize response to audio (non-fatal)
    const audio = await synthesize(answer).catch((err) => {
      this.log('warn', 'TTS failed', { error: (err as Error).message })
      return null
    })

    return this.json(200, { transcript, response: answer, audio })
  }

  // ── Static file serving ─────────────────────────────────────────────

  private async serveStatic(_req: Request, url: URL): Promise<Response> {
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname
    const filePath = resolve(join(config.server.webRoot, pathname.replace(/^\/+/, '')))
    const relativePath = relative(config.server.webRoot, filePath)

    // Prevent path traversal
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return new Response('Forbidden', { status: 403 })
    }

    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      // SPA fallback: serve index.html for HTML navigation requests
      if (_req.headers.get('accept')?.includes('text/html')) {
        const indexPath = join(config.server.webRoot, 'index.html')
        const indexFile = Bun.file(indexPath)
        if (await indexFile.exists()) {
          return new Response(indexFile, {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
          })
        }
      }
      return new Response('Not found', { status: 404 })
    }

    const ext = extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    const isVolatile = ext === '.html' || ext === '.webmanifest' || pathname === '/sw.js'
    const cacheControl = isVolatile ? 'no-cache' : 'public, max-age=31536000, immutable'

    return new Response(file, {
      headers: { 'Content-Type': contentType, 'Cache-Control': cacheControl },
    })
  }

  // handleRequest is not used — all logic is in route()
  async handleRequest(_req: Request): Promise<HandleResult | null> {
    return null
  }
}

// Self-start when run directly (not via channel entrypoint)
if (import.meta.main) {
  const log = createLogger('channel-voice')
  log.info('config', {
    stt: hasConfiguredProvider(config.stt.baseUrl, config.stt.apiKey) ? `${config.stt.baseUrl} (${config.stt.model})` : 'not configured — browser fallback',
    tts: hasConfiguredProvider(config.tts.baseUrl, config.tts.apiKey) ? `${config.tts.baseUrl} (${config.tts.model}, ${config.tts.voice})` : 'not configured — browser fallback',
  })
  const channel = new VoiceChannel()
  channel.start()
}
