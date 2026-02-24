# OpenAI-Compatible Channel

The `channel-openai` adapter exposes a thin OpenAI API-compatible HTTP facade and forwards requests to the OpenPalm gateway using the standard signed channel flow.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health status |
| `POST /v1/chat/completions` | OpenAI-style chat completions |
| `POST /v1/completions` | OpenAI-style text completions |
| `POST /v1/messages` | Anthropic-style messages |
| `POST /v1/complete` | Anthropic-style completions |

## Behavior

- Accepts OpenAI-like and Anthropic-like request bodies.
- Extracts user prompt text and forwards it to the gateway as a normal channel message.
- Returns OpenAI-shaped JSON responses with assistant output populated from gateway `answer`.
- `stream: true` is currently rejected (`400`), since this facade is non-streaming.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8186` | Port the server listens on |
| `GATEWAY_URL` | `http://gateway:8080` | Gateway URL |
| `CHANNEL_OPENAI_SECRET` | (required) | HMAC signing key for gateway communication |
| `OPENAI_COMPAT_API_KEY` | (empty) | Optional API key checked against `Authorization: Bearer <key>` |
| `ANTHROPIC_COMPAT_API_KEY` | (empty) | Optional API key checked against `x-api-key` for Anthropic-compatible endpoints |

## Example

```bash
curl http://localhost:8186/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      { "role": "user", "content": "Say hello" }
    ]
  }'
```

## Related

- [Gateway README](../../core/gateway/README.md) — channel verification, intake, and forwarding
- [API Reference](../../dev/docs/api-reference.md#openai-compatible-channel-channel-openai-8186)
