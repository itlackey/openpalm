# @openpalm/api-portal

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

Streaming is supported through the guardian `/oc/*` proxy.

## Deployment model

- Shipped service definition: `.openpalm/config/stack/channels.compose.yml`, profile `addon.api`
- Default host URL: `http://localhost:3821`
- Container port: `8182`
- System-managed principal secret: file under `~/.openpalm/knowledge/secrets/`, mounted into both the API portal and guardian

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

Use `openpalm addon enable api` (CLI) or the admin UI to enable the portal; manual profile flags are only needed for ad-hoc compose invocations.

## Environment variables

| Variable | Scope | Purpose |
|---|---|---|
| `PORT` | API portal | Container listen port, default `8182` |
| `OPENCODE_BASE_URL` | API portal | OpenCode/guardian `/oc` base URL, default `http://guardian:8080/oc` |
| `PRINCIPAL_ID` | API portal | Guardian principal id used for Basic auth |
| `PRINCIPAL_SECRET_FILE` | API portal | Shared secret file path used for Basic auth |
| `OPENAI_COMPAT_API_KEY_FILE` | API portal | Optional incoming Bearer or `x-api-key` auth token file path |

Secret values are stored as files and exposed only through `*_FILE` variables. Do not put raw API keys or principal secrets in `stack.env` or service-level `env_file` entries.

The shipped Compose overlay exposes per-portal overrides through `API_OPENCODE_BASE_URL`, `API_PRINCIPAL_ID`, and `API_PRINCIPAL_SECRET_FILE`; each defaults to the guardian-backed first-party wiring.
