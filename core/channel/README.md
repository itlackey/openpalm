# core/channel — Unified Channel Image

A single Docker image used by every channel adapter (discord, slack, api, …). It
bundles the `@openpalm/channels-sdk` **framework** and a startup script that
installs and runs any npm-published `BaseChannel` adapter at container start.

This split is deliberate:

- **The framework (`@openpalm/channels-sdk`) ships *in* the image.** It rarely
  changes and provides `BaseChannel`, the guardian client, secret loading, and the
  `channel-entrypoint.ts` runner.
- **Adapters are installed at *runtime* from npm** (not baked into the image).
  Adapters change most often, so this keeps them tiny, independently-published npm
  packages that you can update **without rebuilding or republishing the channel
  image** — just publish the adapter and restart the container.

## How it works

1. `start.sh` runs on container startup.
2. If `CHANNEL_PACKAGE` is set, it runs `bun add --exact "$CHANNEL_PACKAGE"` to
   install the adapter (the value may carry a version or dist-tag, e.g. `@next`).
3. It executes `channel-entrypoint.ts` from the **bundled** `@openpalm/channels-sdk`.
4. The entrypoint imports the adapter **by its bare package name** (it strips any
   `@<version>`/`@<tag>` from `CHANNEL_PACKAGE` — the install spec is not a valid
   module specifier), validates the default export extends `BaseChannel`, and calls
   `channel.start()`.

## Adapter contract (required)

An adapter is an npm package whose default export is a zero-arg `BaseChannel`
subclass. It **must declare `@openpalm/channels-sdk` as an _optional_ peer**:

```jsonc
{
  "peerDependencies":     { "@openpalm/channels-sdk": ">=0.8.0 <1.0.0" },
  "peerDependenciesMeta": { "@openpalm/channels-sdk": { "optional": true } }
}
```

Why optional: the image already provides `channels-sdk`. Without
`optional: true`, `bun add <adapter>` resolves the peer to the latest **stable**
release (semver ranges exclude prereleases) and installs it **over** the bundled
framework — so the running entrypoint becomes the wrong version. Marking it
optional tells the installer "the host provides the framework; don't install your
own copy."

## CHANNEL_PACKAGE pinning / auto-roll

`CHANNEL_PACKAGE` is both the **install spec** (`bun add`) and the source of the
import name. Use a dist-tag so adapter updates roll to users on container restart:

- **Beta:** `@openpalm/channel-discord@next` — prereleases publish under the npm
  `next` tag; restart re-resolves to the newest beta adapter.
- **Stable:** `@openpalm/channel-discord@latest` (or a caret range).
- **Never leave it unpinned/`@latest` during beta** — `latest` points at the old
  `0.10.x` adapters (env-based secret convention) and the channel crashes with
  `CHANNEL_<NAME>_SECRET is not set`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `CHANNEL_PACKAGE` | — | npm install spec for the adapter (e.g. `@openpalm/channel-discord@next`) |
| `CHANNEL_FILE` | `/app/channel.ts` | Path to a local `.ts` file (fallback when `CHANNEL_PACKAGE` is unset) |
| `CHANNEL_SECRET_FILE` | — | Path to the channel↔guardian HMAC secret file (e.g. `/run/secrets/channel_discord_secret`) |

> Secrets are **file-based** (granted via compose `secrets:`), not env vars.
> Adapter-specific secrets follow the same pattern, e.g. `DISCORD_BOT_TOKEN_FILE`.

## Registry usage

```yaml
services:
  discord:
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/channel:${OP_IMAGE_TAG:-latest}
    environment:
      CHANNEL_PACKAGE: "@openpalm/channel-discord@next"
      CHANNEL_SECRET_FILE: /run/secrets/channel_discord_secret
      DISCORD_BOT_TOKEN_FILE: /run/secrets/discord_bot_token
    secrets: [channel_discord_secret, discord_bot_token]
```

## Building

Built as part of the monorepo Docker build. `packages/channels-sdk` is copied into
the image at `/app/node_modules/@openpalm/channels-sdk` during the build, so the
framework version is fixed at image-build time. Adapters are resolved at runtime
from npm.

See [`packages/channels-sdk/README.md`](../../packages/channels-sdk/README.md) and
[`docs/channels/community-channels.md`](../../docs/channels/community-channels.md)
for the full channel development guide.
