import { test, expect } from '@playwright/test'

// ── Health endpoint ──────────────────────────────────────────────────

test.describe('health endpoint', () => {
  test('GET /api/health returns service info', async ({ request }) => {
    const res = await request.get('/api/health')
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.service).toBe('channel-voice')
    expect(body.stt).toBeDefined()
    expect(body.tts).toBeDefined()
    expect(body.stt.model).toBe('whisper-1')
    expect(body.tts.model).toBe('tts-1')
    expect(body.tts.voice).toBe('alloy')
  })

  test('STT/TTS show as not configured without API keys', async ({ request }) => {
    const res = await request.get('/api/health')
    const body = await res.json()
    expect(body.stt.configured).toBe(false)
    expect(body.tts.configured).toBe(false)
  })
})

// ── Pipeline validation ─────────────────────────────────────────────

test.describe('pipeline endpoint', () => {
  test('rejects request with no audio or text', async ({ request }) => {
    const res = await request.post('/api/pipeline', {
      multipart: {},
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Missing audio file or text')
  })

  test('rejects oversized audio', async ({ request }) => {
    // Create a buffer just over 25MB
    const bigBuffer = Buffer.alloc(26 * 1024 * 1024, 0)
    const res = await request.post('/api/pipeline', {
      multipart: {
        audio: {
          name: 'big.wav',
          mimeType: 'audio/wav',
          buffer: bigBuffer,
        },
      },
    })
    expect(res.status()).toBe(413)
    const body = await res.json()
    expect(body.error).toContain('max 25MB')
  })

  test('returns stt_not_configured when sending audio without STT key', async ({ request }) => {
    // Small valid audio-sized file (server has no STT key configured)
    const smallAudio = Buffer.alloc(1024, 0)
    const res = await request.post('/api/pipeline', {
      multipart: {
        audio: {
          name: 'test.webm',
          mimeType: 'audio/webm',
          buffer: smallAudio,
        },
      },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('stt_not_configured')
  })

  test('accepts text field (browser STT path) and returns a response', async ({ request }) => {
    const res = await request.post('/api/pipeline', {
      multipart: {
        text: 'Hello from browser STT',
      },
      timeout: 60_000,
    })
    // Either guardian responds (200) or LLM fallback responds (200) or both fail (502)
    const body = await res.json()
    if (res.ok()) {
      expect(body.transcript).toBe('Hello from browser STT')
      expect(body.response).toBeDefined()
    } else {
      expect(body.error).toBeDefined()
    }
  })

  test('returns empty response for blank text', async ({ request }) => {
    const res = await request.post('/api/pipeline', {
      multipart: {
        text: '   ',
      },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.transcript).toBe('')
    expect(body.response).toBe('')
    expect(body.audio).toBeNull()
  })
})

// ── Static file serving ─────────────────────────────────────────────

test.describe('static file serving', () => {
  test('serves index.html at root', async ({ request }) => {
    const res = await request.get('/')
    expect(res.ok()).toBe(true)
    expect(res.headers()['content-type']).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('OpenPalm Voice')
    expect(html).toContain('record-btn')
  })

  test('serves styles.css', async ({ request }) => {
    const res = await request.get('/styles.css')
    expect(res.ok()).toBe(true)
    expect(res.headers()['content-type']).toContain('text/css')
  })

  test('serves app.js', async ({ request }) => {
    const res = await request.get('/app.js')
    expect(res.ok()).toBe(true)
    expect(res.headers()['content-type']).toContain('javascript')
  })

  test('serves manifest.webmanifest', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest')
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.name).toBe('OpenPalm Voice')
    expect(body.theme_color).toBe('#ff9d00')
  })

  test('returns 404 for nonexistent files', async ({ request }) => {
    const res = await request.get('/does-not-exist.xyz')
    expect(res.status()).toBe(404)
  })

  test('blocks path traversal', async ({ request }) => {
    const res = await request.get('/../../etc/passwd')
    // URL normalization may resolve this to /etc/passwd (404) or the guard catches it (403)
    expect([403, 404]).toContain(res.status())
  })
})

// ── Web UI ──────────────────────────────────────────────────────────

test.describe('web UI', () => {
  test('page loads with all required elements', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#record-btn')).toBeVisible()
    await expect(page.locator('#status')).toBeVisible()
    await expect(page.locator('#settings-btn')).toBeVisible()
    await expect(page.locator('.brand-slash')).toHaveText('/')
    await expect(page.locator('.brand-name')).toHaveText('voice')
  })

  test('record button starts in idle state', async ({ page }) => {
    await page.goto('/')
    const btn = page.locator('#record-btn')
    await expect(btn).toHaveAttribute('data-state', 'idle')
    await expect(btn).toHaveAttribute('aria-label', 'Start recording')
  })

  test('status shows ready on load', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#status')).toHaveText('ready')
  })

  test('shows system log on init', async ({ page }) => {
    await page.goto('/')
    // Wait for the init log message
    await expect(page.locator('.log-entry[data-level="SYS"]').first()).toBeVisible()
    const firstLog = page.locator('.log-entry[data-level="SYS"]').first()
    await expect(firstLog).toContainText('Voice channel ready')
  })

  test('shows capability status after health check', async ({ page }) => {
    await page.goto('/')
    // Wait for the capabilities log (async, may take a moment)
    const capsLog = page.locator('.log-entry[data-level="SYS"]', { hasText: 'STT:' })
    await expect(capsLog).toBeVisible({ timeout: 5000 })
    // Without API keys, should show browser fallback
    await expect(capsLog).toContainText('browser')
  })

  test('settings dialog opens and closes', async ({ page }) => {
    await page.goto('/')
    const dialog = page.locator('#settings-dialog')
    await expect(dialog).not.toBeVisible()

    await page.locator('#settings-btn').click()
    await expect(dialog).toBeVisible()

    // Submit form to close
    await page.locator('#settings-dialog .btn-primary').click()
    await expect(dialog).not.toBeVisible()
  })

  test('settings persist in localStorage', async ({ page }) => {
    await page.goto('/')
    await page.locator('#settings-btn').click()

    // Change voice setting
    await page.locator('#setting-voice').fill('nova')
    await page.locator('#setting-haptic').uncheck()
    await page.locator('#settings-dialog .btn-primary').click()

    // Verify localStorage
    const settings = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('voice-settings') || '{}')
    })
    expect(settings.voice).toBe('nova')
    expect(settings.haptic).toBe(false)
  })

  test('footer shows pipeline description', async ({ page }) => {
    await page.goto('/')
    const footer = page.locator('.footer')
    await expect(footer).toContainText('STT')
    await expect(footer).toContainText('LLM')
    await expect(footer).toContainText('TTS')
  })

  test('PWA manifest link is present', async ({ page }) => {
    await page.goto('/')
    const manifest = page.locator('link[rel="manifest"]')
    await expect(manifest).toHaveAttribute('href', '/manifest.webmanifest')
  })
})
