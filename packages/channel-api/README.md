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
- System-managed HMAC secret: file under `~/.openpalm/config/stack/secrets/`

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

| Variable | Purpose |
|---|---|
| `PORT` | Container listen port, default `8182` |
| `CHANNEL_API_SECRET_FILE` | Guardian HMAC secret file path |
| `OPENAI_COMPAT_API_KEY_FILE` | Optional incoming Bearer or `x-api-key` auth token file path |
