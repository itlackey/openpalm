# @openpalm/channel-api

Broader OpenAI- and Anthropic-compatible API facade for OpenPalm.
Use this addon when clients need model discovery in addition to chat/completions endpoints.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI chat completions |
| `POST` | `/v1/completions` | Legacy completions |
| `POST` | `/v1/messages` | Anthropic messages |
| `GET` | `/v1/models` | List available models |
| `GET` | `/health` | Health check |

Streaming is not supported.

## Deployment model

- Shipped service definition: `.openpalm/config/stack/channels.compose.yml`, profile `addon.api`
- Default host URL: `http://localhost:3821`
- Container port: `8182`
- System-managed HMAC secret: file under `~/.openpalm/knowledge/secrets/`, mounted into both the API channel and guardian

Manual start example:

```bash
cd "$HOME/.openpalm/config/stack"
docker compose \
  --project-name openpalm \
  --env-file stack.env \
  -f core.compose.yml \
  -f services.compose.yml \
  -f channels.compose.yml \
  -f custom.compose.yml \
  --profile addon.api \
  up -d
```

Use `openpalm addon enable api` (CLI) or the admin UI to enable the channel; manual profile flags are only needed for ad-hoc compose invocations.

## Environment variables

| Variable | Scope | Purpose |
|---|---|---|
| `PORT` | API channel | Container listen port, default `8182` |
| `CHANNEL_SECRET_FILE` | API channel | Outbound guardian HMAC secret file path |
| `OPENAI_COMPAT_API_KEY_FILE` | API channel | Optional incoming Bearer or `x-api-key` auth token file path |
| `CHANNEL_API_SECRET_FILE` | guardian | Verification HMAC secret file path for the API channel |

Secret values are stored as files and exposed only through `*_FILE` variables. Do not put raw API keys or HMAC secrets in `stack.env` or service-level `env_file` entries.
