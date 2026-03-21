# core/channel — Unified Channel Image

Docker image used by all registry-backed channel adapters. It bundles the `@openpalm/channels-sdk` and a startup script that installs and runs any npm-published `BaseChannel` implementation at container start.

## How it works

1. `start.sh` runs on container startup
2. If `CHANNEL_PACKAGE` is set, it runs `bun add <package>` to install the channel
3. It then executes `channel-entrypoint.ts` from `@openpalm/channels-sdk`
4. The entrypoint dynamically imports the channel class, validates it extends `BaseChannel`, and calls `channel.start()`

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `CHANNEL_PACKAGE` | — | npm package to install and run (e.g. `@openpalm/channel-chat`) |
| `CHANNEL_FILE` | `/app/channel.ts` | Path to a local `.ts` file (fallback when `CHANNEL_PACKAGE` is unset) |
| `GUARDIAN_URL` | `http://guardian:8080` | Guardian forwarding target |
| `CHANNEL_<NAME>_SECRET` | — | HMAC secret for the channel |

## Registry usage

Each channel in `registry/components/` uses this image:

```yaml
services:
  channel-chat:
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/channel:${OP_IMAGE_TAG:-latest}
    environment:
      CHANNEL_PACKAGE: "@openpalm/channel-chat"
```

## Building

Built as part of the monorepo Docker build. The `packages/channels-sdk` directory is copied into the image at `/app/node_modules/@openpalm/channels-sdk` during the build.

See [`packages/channels-sdk/README.md`](../../packages/channels-sdk/README.md) and [`docs/community-channels.md`](../../docs/community-channels.md) for the full channel development guide.
