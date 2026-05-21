/**
 * OpenPalm Channel Voice — Voice chat web UI.
 *
 * Serves the static voice chat app which talks directly to OpenCode's
 * session API from the browser. No guardian pipeline — the app handles
 * agent, STT, and TTS provider selection client-side.
 *
 * Endpoints:
 *   GET /health           — Health check
 *   GET /config/defaults  — Operator-supplied STT/TTS defaults (from container env)
 *   GET /*                — Static file serving from web/ directory
 */

import { extname, join, resolve, sep } from 'node:path'
import { createLogger } from '@openpalm/channels-sdk'

const logger = createLogger('channel-voice')

// ── MIME types for static file serving ──────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
}

// ── Static file serving ─────────────────────────────────────────────────

const WEB_ROOT = resolve(import.meta.dir, '../web')

function serveStatic(pathname: string): Response | null {
  let filePath = join(WEB_ROOT, pathname)
  if (!filePath.startsWith(WEB_ROOT + sep) && filePath !== WEB_ROOT) return null

  const file = Bun.file(filePath)
  if (!file.size) {
    // Try index.html for directory requests
    filePath = join(filePath, 'index.html')
    const indexFile = Bun.file(filePath)
    if (!indexFile.size) return null
    return new Response(indexFile, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }

  const ext = extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  return new Response(file, { headers: { 'content-type': contentType } })
}

// ── Server ──────────────────────────────────────────────────────────────

const PORT = Number(Bun.env.PORT ?? 8186)

// Operator-supplied STT/TTS defaults — the voice browser app fetches
// this on first load (when no localStorage entry exists) and seeds its
// settings from these values. Provider is derived: if a base URL is set
// we default to the openai-compatible HTTP provider; otherwise the
// in-browser Web Speech API. Set by writeVoiceVars() via stack.env.
function defaultsResponse(): Response {
  const env = Bun.env
  const sttUrl = (env.STT_BASE_URL ?? '').trim()
  const ttsUrl = (env.TTS_BASE_URL ?? '').trim()
  return Response.json({
    stt: {
      provider: sttUrl ? 'openai' : 'browser',
      url: sttUrl,
      apiKey: (env.STT_API_KEY ?? '').trim(),
      model: (env.STT_MODEL ?? '').trim(),
      language: (env.STT_LANGUAGE ?? '').trim(),
    },
    tts: {
      provider: ttsUrl ? 'openai' : 'browser',
      url: ttsUrl,
      apiKey: (env.TTS_API_KEY ?? '').trim(),
      model: (env.TTS_MODEL ?? '').trim(),
      voice: (env.TTS_VOICE ?? '').trim(),
    },
  })
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url)
    const pathname = decodeURIComponent(url.pathname)

    // Health check
    if (pathname === '/health') {
      return Response.json({ status: 'ok', service: 'voice' })
    }

    // STT/TTS defaults seeded from container env
    if (pathname === '/config/defaults') {
      return defaultsResponse()
    }

    // Serve static files
    const staticResp = serveStatic(pathname === '/' ? '/index.html' : pathname)
    if (staticResp) return staticResp

    return new Response('Not found', { status: 404 })
  },
})

logger.info('started', { port: PORT })
