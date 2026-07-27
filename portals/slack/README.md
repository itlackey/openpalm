# @openpalm/slack-portal

Slack Socket Mode adapter for OpenPalm — a standard OpenCode-SDK client. It
can run as part of the shipped OpenPalm stack (via the `addon.slack` Compose
profile) or standalone with Bun against any OpenCode server. Socket Mode
connects outbound to Slack, so no public inbound URL is required either way.

## Security model

Runs best behind the OpenPalm guardian (or another auth/rate-limiting reverse
proxy). Standalone is for personal / small-trusted-team use against your own
OpenCode server. Running standalone against a plain OpenCode server (no
guardian in front) means you lose:

- per-principal isolation (the guardian's Basic-auth principal boundary)
- rate limiting
- content moderation (the guardian's fail-closed inbound message screening)

Every Slack user talking to a standalone bot shares one session namespace on
the upstream OpenCode server — there is no per-user isolation without the
guardian in front.

## Standalone quick start

Requires **Bun ≥1.0** — this package ships TypeScript source (no build step,
no Node support); the `bunx`/`bun add` commands below fail fast at install
time on a non-Bun runtime via the `engines.bun` check.

```bash
bunx @openpalm/slack-portal
# or: bun add @openpalm/slack-portal && bunx openpalm-slack-portal
```

Minimal environment:

```bash
OPENCODE_BASE_URL=http://localhost:4096
PRINCIPAL_ID=my-slack-bot          # any free-form username
OPENCODE_PASSWORD=...              # the OpenCode server password, if OPENCODE_AUTH is set
SLACK_BOT_TOKEN=...
SLACK_APP_TOKEN=...
```

Client-side session reuse (`PORTAL_SESSION_REUSE=client`) is the **default** —
you do not need to set it against a plain OpenCode server. See the
`PORTAL_SESSION_REUSE` row below for why, and when you'd ever opt out.

## Deployment model (shipped stack)

- Shipped service definition: `.openpalm/config/stack/portals.compose.yml`, profile `addon.slack`
- Non-secret values: `~/.openpalm/state/stack.env`
- Secret values: files under `~/.openpalm/knowledge/secrets/`

Manual start example:

```bash
cd "$HOME/.openpalm/config/stack"
docker compose \
  --project-name openpalm \
  --env-file ../../state/stack.env \
  -f core.compose.yml \
  -f services.compose.yml \
  -f portals.compose.yml \
  -f custom.compose.yml \
  --profile addon.slack \
  up -d
```

The service definition uses explicit non-secret environment entries and Docker secret grants. It does not use service-level `env_file`.

See `docs/portals/slack-setup.md` for the full setup guide.

## Environment variables

Secrets accept BOTH a direct value and a `_FILE` path to a mounted secret
file — when both are set for the same variable, `_FILE` wins (the shipped
Compose stack always uses `_FILE`; the direct form is for standalone use where
there's no secret mount).

| Variable | Required | Purpose |
|---|---|---|
| `OPENCODE_BASE_URL` | no | OpenCode/guardian `/oc` base URL, default `http://guardian:8080/oc` |
| `PRINCIPAL_ID` | yes | Basic-auth username — the guardian principal id in the shipped stack, or any free-form username against a plain OpenCode server |
| `PRINCIPAL_SECRET` / `PRINCIPAL_SECRET_FILE` | yes (one of these, or `OPENCODE_PASSWORD`) | Basic-auth password |
| `OPENCODE_PASSWORD` / `OPENCODE_PASSWORD_FILE` | standalone fallback | Same Basic-auth password slot as `PRINCIPAL_SECRET`, under the natural standalone name — against a plain OpenCode server this IS the OpenCode server password (`OPENCODE_AUTH`) |
| `PORTAL_SESSION_REUSE` | no | `client` (default) or `server`. The client-side cache keys a session by `(userId, sessionKey)` so a stable thread reuses one session — works standalone AND behind the shipped guardian, which has no server-side reuse cache of its own (a plain OpenCode server also ignores the guardian's session-reuse hint header). Set `server` ONLY if your deployment has built its own server-side reuse authority; leaving both sides unset (the old default) meant NEITHER side reused sessions, and every turn silently minted a new one. |
| `PORTAL_SESSION_TTL_MS` | no | Client-mode session cache TTL in ms, default `900000` (15 min). Only relevant when `PORTAL_SESSION_REUSE=client`. |
| `SLACK_BOT_TOKEN` / `SLACK_BOT_TOKEN_FILE` | yes | Bot User OAuth token |
| `SLACK_APP_TOKEN` / `SLACK_APP_TOKEN_FILE` | yes | App-level Socket Mode token |
| `SLACK_BOT_NAME` | no | Display name used in modal titles and the App Home tab. Default `OpenPalm`. Slack callback/action IDs (`ask_openpalm`, …) stay fixed regardless — they are Slack app-manifest identifiers, not display text. |
| `SLACK_ALLOWED_CHANNELS` | no | Comma-separated channel allowlist |
| `SLACK_ALLOWED_USERS` | no | Comma-separated user allowlist |
| `SLACK_BLOCKED_USERS` | no | Comma-separated user blocklist |

In the shipped stack, secret values are stored as files and exposed only
through `*_FILE` variables. The schema may collect `SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN` for setup, but setup persists them under
`knowledge/secrets/` and the runtime receives `SLACK_BOT_TOKEN_FILE` and
`SLACK_APP_TOKEN_FILE`, not raw tokens.

The shipped Compose overlay exposes per-portal overrides through
`SLACK_OPENCODE_BASE_URL`, `SLACK_PRINCIPAL_ID`, and
`SLACK_PRINCIPAL_SECRET_FILE`; each defaults to the guardian-backed
first-party wiring. `PORTAL_SESSION_REUSE` is not set by the shipped Compose
overlay, so it resolves to the `client` default there too — the guardian
proxies `POST /session` transparently and has no reuse cache of its own.

## Interactive prompts compatibility

Interactive permission/question replies (`/permission/{id}/reply`,
`/question/{id}/reply|reject`) are guaranteed by the OpenPalm guardian's `/oc`
proxy, but are **not** part of the current upstream OpenCode SDK route map. If
your OpenCode server doesn't expose those routes, the portal logs
`permission_reply_failed` / `question_reply_failed` and the conversation turn
continues normally — interactive permission/question prompts just won't get a
reply delivered. Core buffered and streaming text flow (`/session`,
`/session/{id}/message`, `/event`) works against any OpenCode server.

## Slack app configuration

Required bot scopes:

- `app_mentions:read`
- `chat:write`
- `im:history`
- `channels:history`
- `groups:history`
- `users:read`
- `commands`

Required event subscriptions:

- `app_mention`
- `message.im`
- `message.channels`
- `message.groups`
- `app_home_opened`

Required Interactivity setup:

- Enable **Interactivity & Shortcuts** in your Slack app
- Add a global shortcut with callback ID `ask_openpalm`
- Add a message shortcut with callback ID `ask_openpalm_message`
- Socket Mode apps can use any placeholder Request URL for interactivity

The adapter does not require reaction scopes.

## Conversation behavior

- DMs are per-user sessions
- Channel mentions reply in a thread
- Follow-ups sent while a session is busy are queued
- `/clear` clears the active session and drops queued follow-ups

## See also

- [`docs/portals/community-portals.md`](../../docs/portals/community-portals.md)
- [`docs/portals/slack-setup.md`](../../docs/portals/slack-setup.md)
