# Voice Channel

The `channel-voice` adapter accepts voice transcriptions (pre-converted to text) and forwards them through the Gateway to the assistant. Real-time WebSocket streaming is not yet implemented.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health status |
| `POST /voice/transcription` | Submit a voice transcription |
| `GET /voice/stream` | Returns 501 — WebSocket streaming not yet implemented |

### POST /voice/transcription

```json
{ "userId": "...", "text": "...", "audioRef": "...", "language": "en" }
```

- `text` — required: the transcribed text
- `audioRef` — optional: reference ID for the original audio file
- `language` — optional: language code (default `en`)
- when `VOICE_INBOUND_TOKEN` is configured, include header `x-voice-token: <token>`

## Caddy ingress

- Route: `/channels/voice*` → rewrites to `/voice/transcription`
- Access: LAN by default (togglable to public via Admin API)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8183` | Port the server listens on |
| `GATEWAY_URL` | `http://gateway:8080` | Gateway URL |
| `CHANNEL_VOICE_SECRET` | (required) | HMAC shared secret for signing payloads |
| `VOICE_INBOUND_TOKEN` | (optional) | Reject transcription requests unless `x-voice-token` matches |

## Setup

This channel accepts pre-transcribed text. Pair it with a speech-to-text service that can `POST` to `/voice/transcription`. No platform credentials are required by the channel itself.

Manage credentials via `POST /channels/config` with `service: "channel-voice"`.

## Related

- [API Reference](../../dev/docs/api-reference.md#voice-channel-voice-8183) — Full endpoint and payload details
- [Gateway README](../../core/gateway/README.md) — How signed payloads are processed
