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

- Compose overlay: `~/.openpalm/stack/addons/api/compose.yml`
- Default host URL: `http://localhost:3821`
- Container port: `8182`
- System-managed HMAC secret: `CHANNEL_API_SECRET` in `~/.openpalm/vault/stack/guardian.env`

Manual start example:

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  --project-name openpalm \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
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
| `GUARDIAN_URL` | Guardian forwarding target |
| `CHANNEL_API_SECRET` | Guardian HMAC secret |
| `OPENAI_COMPAT_API_KEY` | Optional incoming Bearer or `x-api-key` auth token; the shipped addon overlay reads it from `vault/user/user.env` via `env_file` |
