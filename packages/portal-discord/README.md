# @openpalm/discord-portal

Discord bot adapter for OpenPalm — a standard OpenCode-SDK client. It can run
as part of the shipped OpenPalm stack (behind the guardian, via the
`addon.discord` Compose profile) or standalone with Bun against any OpenCode
server.

## Security model

Runs best behind the OpenPalm guardian (or another auth/rate-limiting reverse
proxy). Standalone is for personal / small-trusted-team use against your own
OpenCode server. Running standalone against a plain OpenCode server (no
guardian in front) means you lose:

- per-principal isolation (the guardian's Basic-auth principal boundary)
- rate limiting
- content validation (on by default; the guardian's fail-closed inbound message screening)

Every Discord user talking to a standalone bot shares one session namespace on
the upstream OpenCode server — there is no per-user isolation without the
guardian in front.

## Standalone quick start

Requires **Bun ≥1.0** — this package ships TypeScript source (no build step,
no Node support); the `bunx`/`bun add` commands below fail fast at install
time on a non-Bun runtime via the `engines.bun` check.

```bash
bunx @openpalm/discord-portal
# or: bun add @openpalm/discord-portal && bunx openpalm-discord-portal
```

Minimal environment:

```bash
OPENCODE_BASE_URL=http://localhost:4096
PRINCIPAL_ID=opencode              # configured OpenCode Basic username; default is opencode
OPENCODE_PASSWORD=...              # the OpenCode server password, if the server sets one
DISCORD_BOT_TOKEN=...
```

Client-side session reuse (`PORTAL_SESSION_REUSE=client`) is the **default** —
you do not need to set it against a plain OpenCode server. See the
`PORTAL_SESSION_REUSE` row below for why, and when you'd ever opt out.

## Deployment model (shipped stack)

- Shipped service definition: `system/stack/portals.compose.yml`, profile `addon.discord`
- Non-secret values: `~/.openpalm/state/stack.env`
- Bot and principal secrets: files under `~/.openpalm/private/secrets/`

Manual start example:

```bash
OP_HOME="${OP_HOME:-$HOME/.openpalm}"
docker compose \
  --project-name openpalm \
  --env-file "$OP_HOME/state/stack.env" \
  -f "$OP_HOME/system/stack/core.compose.yml" \
  -f "$OP_HOME/system/stack/services.compose.yml" \
  -f "$OP_HOME/system/stack/portals.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile addon.discord \
  up -d
```

`OP_ENABLED_ADDONS` is translated to profiles only by OpenPalm control-plane
commands. Raw Compose requires the explicit profile above or a
`COMPOSE_PROFILES` value.

See the [Discord setup guide](../../docs/portals/discord-setup.md) for the full
walkthrough.

The service definition uses explicit non-secret environment entries and Docker secret grants. It does not use service-level `env_file`.

## Environment variables

Secrets accept BOTH a direct value and a `_FILE` path to a mounted secret
file — when both are set for the same variable, `_FILE` wins (the shipped
Compose stack always uses `_FILE`; the direct form is for standalone use where
there's no secret mount).

| Variable | Required | Purpose |
|---|---|---|
| `OPENCODE_BASE_URL` | no | OpenCode/guardian `/oc` base URL, default `http://guardian:8080/oc` |
| `PRINCIPAL_ID` | yes | Basic-auth username: an issued principal ID for Guardian, or the plain OpenCode server's configured username (default `opencode`) |
| `PRINCIPAL_SECRET` / `PRINCIPAL_SECRET_FILE` | yes (one of these, or `OPENCODE_PASSWORD`) | Basic-auth password |
| `OPENCODE_PASSWORD` / `OPENCODE_PASSWORD_FILE` | standalone fallback | Same Basic-auth password slot as `PRINCIPAL_SECRET`, under the natural standalone name — against a plain OpenCode server this IS the OpenCode server password (`OPENCODE_SERVER_PASSWORD`) |
| `PORTAL_SESSION_REUSE` | no | `client` (default) or `server`. The client-side cache keys a session by `(userId, sessionKey)` so a stable thread reuses one session — works standalone AND behind the shipped guardian, which has no server-side reuse cache of its own (a plain OpenCode server also ignores the guardian's session-reuse hint header). Set `server` ONLY if your deployment has built its own server-side reuse authority; leaving both sides unset (the old default) meant NEITHER side reused sessions, and every turn silently minted a new one. |
| `PORTAL_SESSION_TTL_MS` | no | Client-mode session cache TTL in ms, default `900000` (15 min). Only relevant when `PORTAL_SESSION_REUSE=client`. |
| `DISCORD_APPLICATION_ID` | yes for command registration | Discord application ID |
| `DISCORD_BOT_TOKEN` / `DISCORD_BOT_TOKEN_FILE` | yes | Bot token |
| `DISCORD_REGISTER_COMMANDS` | no | Disable startup command registration when `false` |
| `DISCORD_ALLOWED_GUILDS` | no | Comma-separated guild allowlist |
| `DISCORD_ALLOWED_ROLES` | no | Comma-separated role allowlist |
| `DISCORD_ALLOWED_USERS` | no | Comma-separated user allowlist |
| `DISCORD_BLOCKED_USERS` | no | Comma-separated user blocklist |
| `DISCORD_CUSTOM_COMMANDS` | no | JSON array of custom command definitions |

In the shipped stack, secret values are stored as files and exposed only
through `*_FILE` variables. The schema may collect `DISCORD_BOT_TOKEN` for
setup, but setup persists it under `private/secrets/` and the runtime
receives `DISCORD_BOT_TOKEN_FILE`, not the raw token.

The shipped Compose overlay exposes per-portal overrides through
`DISCORD_OPENCODE_BASE_URL`, `DISCORD_PRINCIPAL_ID`, and
`DISCORD_PRINCIPAL_SECRET_FILE`; each defaults to the guardian-backed
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

## Conversation behavior

- Mentioning the bot in a normal channel starts or reuses a Discord thread
- Replies inside that tracked thread keep the same backend session
- `/ask` replies inline and does not create a thread
- `/clear` clears the active conversation scope and drops queued follow-ups for that scope

## See also

- [`docs/portals/community-portals.md`](../../docs/portals/community-portals.md)
- [`docs/portals/discord-setup.md`](../../docs/portals/discord-setup.md)
