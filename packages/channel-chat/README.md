# @openpalm/channel-chat

OpenAI- and Anthropic-compatible chat edge for OpenPalm.
Use it when you want a simple chat/completions endpoint without the broader model-discovery facade from the `api` addon.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI chat completions |
| `POST` | `/v1/completions` | Legacy completions |
| `POST` | `/v1/messages` | Anthropic messages |
| `GET` | `/health` | Health check |

Streaming is not supported.

## Deployment model

- Compose overlay: `~/.openpalm/stack/addons/chat/compose.yml`
- Default host URL: `http://localhost:3820`
- Container port: `8181`
- System-managed HMAC secret: `CHANNEL_CHAT_SECRET` in `~/.openpalm/vault/stack/stack.env`

Manual start example:

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  --project-name openpalm \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  -f core.compose.yml \
  -f addons/chat/compose.yml \
  up -d
```

If you use the optional admin addon, manage the addon through the admin UI or
current install API instead of editing the compose file list by hand.

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Container listen port, default `8181` |
| `GUARDIAN_URL` | Guardian forwarding target |
| `CHANNEL_CHAT_SECRET` | Guardian HMAC secret |
| `OPENAI_COMPAT_API_KEY` | Optional incoming Bearer or `x-api-key` auth token; the shipped addon overlay reads it from `vault/user/user.env` via `env_file` |
