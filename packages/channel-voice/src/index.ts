/**
 * OpenPalm Channel Voice — Voice chat web UI.
 *
 * Serves the static voice chat app which talks directly to OpenCode's
 * session API from the browser. No guardian pipeline — the app handles
 * agent, STT, and TTS provider selection client-side.
 *
 * Endpoints:
 *   GET /health  — Health check
 *   GET /*       — Static file serving from web/ directory
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

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url)
    const pathname = decodeURIComponent(url.pathname)

    // Health check
    if (pathname === '/health') {
      return Response.json({ status: 'ok', service: 'voice' })
    }

    // Serve static files
    const staticResp = serveStatic(pathname === '/' ? '/index.html' : pathname)
    if (staticResp) return staticResp

    return new Response('Not found', { status: 404 })
  },
})

logger.info('started', { port: PORT })
