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

- Shipped addon source: `.openpalm/state/registry/addons/api/compose.yml`
- Enabled runtime overlay: `~/.openpalm/config/stack/addons/api/compose.yml`
- Default host URL: `http://localhost:3821`
- Container port: `8182`
- System-managed HMAC secret: file under `~/.openpalm/stash/vaults/secrets/`, mounted into both the API channel and guardian

Manual start example:

```bash
cd "$HOME/.openpalm/config/stack"
docker compose \
  --project-name openpalm \
  --env-file stack.env \
  -f core.compose.yml \
  -f addons/api/compose.yml \
  up -d
```

If you use the optional admin addon, manage the addon through the admin UI or
current install API instead of editing the compose file list by hand.

## Environment variables

| Variable | Scope | Purpose |
|---|---|---|
| `PORT` | API channel | Container listen port, default `8182` |
| `CHANNEL_SECRET_FILE` | API channel | Outbound guardian HMAC secret file path |
| `OPENAI_COMPAT_API_KEY_FILE` | API channel | Optional incoming Bearer or `x-api-key` auth token file path |
| `CHANNEL_API_SECRET_FILE` | guardian | Verification HMAC secret file path for the API channel |

Secret values are stored as files and exposed only through `*_FILE` variables. Do not put raw API keys or HMAC secrets in `stack.env` or service-level `env_file` entries.
