# @openpalm/channel-voice

Voice-driven conversational channel for [OpenPalm](https://github.com/itlackey/openpalm). Provides a web-based recording interface with a server-side pipeline that chains STT, LLM, and TTS using OpenAI-compatible APIs.

## How it works

```
mic → STT → LLM → TTS → speaker
```

1. User speaks into the microphone (browser captures audio)
2. Audio is transcribed to text (server STT or browser Speech Recognition)
3. Text is forwarded to the assistant via the guardian (or direct LLM fallback)
4. Response is synthesized to audio (server TTS or browser speechSynthesis)
5. Audio plays back to the user

Every step has a browser fallback — the channel works with zero API keys using only the Web Speech API.

## Quick start

```bash
# Install dependencies
bun install

# Run locally (defaults to Ollama at localhost:11434)
bun run dev
```

Open `http://localhost:8090` in your browser. Tap the microphone or press Space to start talking.

## Configuration

Copy `.env.example` to `.env` and adjust as needed. All settings use OpenAI-compatible API formats.

### LLM (direct fallback)

When the guardian is unavailable (e.g. running outside Docker), the channel calls the LLM directly.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BASE_URL` | `http://localhost:11434` | LLM API base URL (Ollama default) |
| `LLM_API_KEY` | `ollama` | API key |
| `LLM_MODEL` | `qwen2.5:3b` | Model name |
| `LLM_SYSTEM_PROMPT` | *(conversational)* | System prompt for voice responses |
| `LLM_TIMEOUT_MS` | `60000` | Request timeout |

### STT (Speech-to-Text)

Server-side transcription. If not configured, the browser's `SpeechRecognition` API is used.

| Variable | Default | Description |
|----------|---------|-------------|
| `STT_BASE_URL` | *(empty)* | STT API base URL |
| `STT_API_KEY` | *(empty)* | API key |
| `STT_MODEL` | `whisper-1` | Model name |
| `STT_TIMEOUT_MS` | `30000` | Request timeout |

### TTS (Text-to-Speech)

Server-side speech synthesis. If not configured, the browser's `speechSynthesis` API is used.

| Variable | Default | Description |
|----------|---------|-------------|
| `TTS_BASE_URL` | *(empty)* | TTS API base URL |
| `TTS_API_KEY` | *(empty)* | API key |
| `TTS_MODEL` | `tts-1` | Model name |
| `TTS_VOICE` | `alloy` | Voice name |
| `TTS_TIMEOUT_MS` | `30000` | Request timeout |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8186` | HTTP server port |
| `GUARDIAN_URL` | `http://guardian:8080` | Guardian service URL (Docker) |
| `CHANNEL_VOICE_SECRET` | *(required)* | HMAC secret for guardian signing |
| `OPENAI_API_KEY` | *(empty)* | Shared fallback key for STT/TTS/LLM |

## Docker Compose

The voice channel runs in the unified `openpalm/channel` image. Install it from the registry:

```bash
# Install via admin API
curl -X POST http://localhost:8100/api/registry/voice/install \
  -H "x-admin-token: $ADMIN_TOKEN"
```

The component definition lives at `registry/components/voice/compose.yml`.

The web UI is served at the channel's port (default 8186).

## API

### `GET /api/health`

Returns service status and provider configuration.

```json
{
  "ok": true,
  "service": "channel-voice",
  "stt": { "model": "whisper-1", "configured": false },
  "tts": { "model": "tts-1", "voice": "alloy", "configured": false },
  "llm": { "model": "qwen2.5:3b", "configured": true }
}
```

### `POST /api/pipeline`

Full voice pipeline. Accepts `multipart/form-data` with either:

- `audio` — audio file (server STT transcribes it)
- `text` — pre-transcribed text (browser STT path)

Response:

```json
{
  "transcript": "What is the capital of France?",
  "response": "The capital of France is Paris.",
  "audio": "<base64 mp3 or null>"
}
```

## Features

- **Browser fallback** — Works without any API keys using Web Speech APIs
- **Continuous listening** — Toggle auto-restart to keep the mic open between responses
- **Markdown rendering** — AI responses render bold, italic, code blocks in the UI
- **Markdown stripping** — TTS reads clean prose, not syntax characters
- **LLM fallback** — Direct LLM call when the guardian/assistant is unreachable
- **PWA** — Installable with offline shell caching
- **Accessible** — Keyboard nav (Space to toggle), screen reader announcements, focus outlines

## Development

```bash
bun run dev          # Start with hot reload (port 8090)
bun run test         # Unit tests (bun:test)
bun run test:e2e     # Playwright e2e tests (22 tests)
bun run typecheck    # TypeScript check
```

## License

[MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/)
