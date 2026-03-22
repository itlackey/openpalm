# @openpalm/channel-voice

Voice web UI and STT -> assistant -> TTS pipeline for OpenPalm.
In the full stack it is exposed on `http://localhost:3810` and runs behind guardian.

## How it works

```text
mic -> STT -> assistant -> TTS -> speaker
```

- Browser audio is transcribed locally or by a configured STT provider
- Text is forwarded through guardian to the assistant
- The reply is rendered in the UI and optionally synthesized back to audio
- Browser speech APIs remain available as fallbacks for local/dev use

## Deployment model

- Compose overlay: `~/.openpalm/stack/addons/voice/compose.yml`
- Default host URL: `http://localhost:3810`
- Container port: `8186`
- System-managed HMAC secret: `CHANNEL_VOICE_SECRET` in `~/.openpalm/vault/stack/stack.env`

Manual start example:

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  --project-name openpalm \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  -f core.compose.yml \
  -f addons/voice/compose.yml \
  up -d
```

If you use the optional admin addon, manage the addon through the admin UI or
current install API instead of editing the compose file list by hand.

## Local dev only

Package-local dev remains standalone and intentionally different from the deployed addon:

```bash
cd packages/channel-voice
bun install
bun run dev
```

That starts the package directly with a dev secret and its own local port.

## Configuration

These env vars matter when running the package directly or when overriding addon defaults:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8186` | HTTP server port |
| `GUARDIAN_URL` | `http://guardian:8080` | Guardian URL in Docker |
| `CHANNEL_VOICE_SECRET` | - | Guardian HMAC secret |
| `OPENAI_API_KEY` | - | Shared fallback API key |
| `LLM_BASE_URL` | `http://localhost:11434` | Standalone/dev LLM URL |
| `LLM_API_KEY` | `ollama` | Standalone/dev LLM key |
| `LLM_MODEL` | `qwen2.5:3b` | Standalone/dev model |
| `STT_BASE_URL` | - | Optional STT provider URL |
| `STT_API_KEY` | - | Optional STT provider key |
| `TTS_BASE_URL` | - | Optional TTS provider URL |
| `TTS_API_KEY` | - | Optional TTS provider key |

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Service and provider status |
| `POST` | `/api/pipeline` | Multipart voice pipeline request |
