# core/channel — Unified Portal Image

A single Docker image used by every first-party portal adapter (`api`, `discord`,
`slack`). The image bakes the first-party adapter packages from the workspace at
build time.

## How it works

1. `start.sh` runs on container startup.
2. `CHANNEL_PACKAGE` selects one of the baked adapter packages.
3. `channel-entrypoint.ts` imports that package.
4. The adapter is instantiated and its `start()` method is called.

There is no runtime `bun add`, no adapter npm install at boot, and no separate
`channels-sdk` package.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `CHANNEL_PACKAGE` | — | baked adapter package to run (for example `@openpalm/discord-portal`) |
| `PRINCIPAL_ID` | — | guardian principal id used for Basic auth |
| `PRINCIPAL_SECRET_FILE` | — | shared secret file used as the Basic auth password |

Adapter-specific secrets follow the same `*_FILE` pattern, for example
`DISCORD_BOT_TOKEN_FILE` or `SLACK_BOT_TOKEN_FILE`.

## Example

```yaml
services:
  discord:
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/portal:${OP_PORTAL_IMAGE_TAG:-${OP_IMAGE_TAG:-latest}}
    environment:
      CHANNEL_PACKAGE: "@openpalm/discord-portal"
      PRINCIPAL_ID: discord
      PRINCIPAL_SECRET_FILE: /run/secrets/channel_discord_secret
      DISCORD_BOT_TOKEN_FILE: /run/secrets/discord_bot_token
    secrets: [channel_discord_secret, discord_bot_token]
```

## Building

The portal image is built from the monorepo. The first-party adapter packages are
copied into the image during the Docker build, so the adapters stay version-locked
to the image tag.
