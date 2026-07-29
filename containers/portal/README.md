# containers/portal — Unified Portal Image

A single Docker image used by every first-party portal adapter (`discord`,
`slack`). At build time, the production Dockerfile packs the local portal SDK
and adapter candidates, then installs those tarballs with their external
dependencies.

## How it works

1. `start.sh` runs on container startup.
2. `PORTAL_PACKAGE` selects one of the baked adapter packages.
3. `portal-entrypoint.ts` imports that package.
4. The adapter is instantiated and its `start()` method is called.

There is no runtime `bun add` and no adapter npm install at boot.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `PORTAL_PACKAGE` | — | baked adapter package to run (for example `@openpalm/discord-portal`) |
| `OPENCODE_BASE_URL` | `http://guardian:8080/oc` | OpenCode/guardian `/oc` base URL used by the portal |
| `PRINCIPAL_ID` | — | guardian principal id used for Basic auth |
| `PRINCIPAL_SECRET_FILE` | — | shared secret file used as the Basic auth password |

Adapter-specific secrets follow the same `*_FILE` pattern, for example
`DISCORD_BOT_TOKEN_FILE` or `SLACK_BOT_TOKEN_FILE`.

OpenAI/Anthropic-compatible endpoints are served by the profile-gated Guardian
service itself, not by the portal image or a separate API service.

## Example

```yaml
services:
  discord:
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/portal:${OP_PORTAL_VERSION:-latest}
    environment:
      PORTAL_PACKAGE: "@openpalm/discord-portal"
      PRINCIPAL_ID: discord
      PRINCIPAL_SECRET_FILE: /run/secrets/portal_discord_secret
      DISCORD_BOT_TOKEN_FILE: /run/secrets/discord_bot_token
    secrets: [portal_discord_secret, discord_bot_token]
```

## Building

The same Dockerfile serves live builds and coordinated dry runs. It does not
depend on standalone npm publication; those packages remain independently
publishable for users who install them outside the image.
