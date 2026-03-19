import { defineConfig } from '@playwright/test'

const PORT = 18_186
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `bun run src/index.ts`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
    env: {
      PORT: String(PORT),
      CHANNEL_VOICE_SECRET: 'test-secret',
      // Explicitly clear STT/TTS keys so tests run with browser fallback
      STT_API_KEY: '',
      TTS_API_KEY: '',
      OPENAI_API_KEY: '',
      STT_BASE_URL: '',
      TTS_BASE_URL: '',
    },
  },
})
