# Paperclip Addon Design

**Status:** Implemented
**Date:** 2026-08-04
**Upstream package:** `paperclipai@2026.722.0`

Paperclip is a normal first-party service addon. OpenPalm runs the upstream
application and does not reimplement its control plane or introduce an
OpenPalm-specific agent adapter.

## Runtime Contract

Paperclip uses the same addon path as other built-in services:

- `paperclip` is present in `BUILTIN_ADDON_IDS`.
- Enablement is recorded only in `OP_ENABLED_ADDONS`.
- `openpalm addon enable paperclip` calls the generic `setAddonEnabled()` path.
- The admin add-on API and UI discover the same `addon.paperclip` profile.
- Disable stops the discovered service and removes only the enablement record.
- There is no `openpalm paperclip` command or Paperclip lifecycle/status API.

The managed stack declares one service:

```yaml
paperclip:
  profiles: ["addon.paperclip"]
  image: ${OP_IMAGE_NAMESPACE:-openpalm}/paperclip:${OP_PAPERCLIP_VERSION:-2026.722.0}
  ports:
    - "127.0.0.1:${OP_PAPERCLIP_PORT:-3840}:3100"
  volumes:
    - ${OP_HOME}/data/paperclip:/paperclip
  env_file:
    - ${OP_HOME}/private/env/paperclip.env
  networks: [addon_net]
```

Paperclip uses its upstream embedded PostgreSQL database. There is no database
sidecar, route overlay, Guardian principal, or connection to `assistant_net` or
`portal_net`.

## Image

`containers/paperclip/Dockerfile` installs the exact upstream npm release at
image build time. It adds no OpenPalm application code, adapter, verifier, or
wrapper entrypoint. The server starts through the upstream published
`@paperclipai/server` package.

The upstream embedded-Postgres package creates compatibility symlinks in its
native library directory on first start. The image creates those aliases while
building so the runtime can remain non-root and the installed package tree can
remain immutable.

`.github/workflows/publish-paperclip.yml` publishes signed multi-architecture
`openpalm/paperclip:<upstream-version>` images independently from the platform
release. Existing immutable tags are never overwritten.

## Security

Paperclip is fixed to host loopback. `OP_PAPERCLIP_PORT` changes only the host
port; there is no configurable bind address. The service runs with:

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
- `PAPERCLIP_TELEMETRY_DISABLED=1`
- `DO_NOT_TRACK=1`

The container joins only `addon_net`. It cannot address the assistant or
Guardian. Operators configure agents through Paperclip's supported upstream
interfaces; OpenPalm does not give Paperclip an assistant credential.

## Secrets

Upstream requires `BETTER_AUTH_SECRET` and
`PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` as environment variables and does not
offer `*_FILE` alternatives. Before generic enablement,
`preparePaperclipAddon()` creates exactly one private file:

```text
$OP_HOME/private/env/paperclip.env
```

The directory is `0700` and the file is `0600`. Existing values are preserved;
unknown keys fail closed. The Compose secret audit grants a narrow exception
only for this service and path, and resolved secret values must exactly match
the hardened file.

The file is not under `knowledge/`, is never mounted into the assistant, and is
included in OpenPalm lifecycle safety backups through the existing `private/`
backup contract.

## Persistence

All Paperclip instance state, including its embedded database, is stored under
`$OP_HOME/data/paperclip`. Normal addon disable does not remove it. As with all
service-owned `data/`, OpenPalm lifecycle safety backups exclude it; operators
must use Paperclip's own backup/export facilities for application data.

## Verification

The implementation is covered by tests for:

- generic addon discovery and enablement;
- idempotent secret generation and file modes;
- rejection of unsupported private-env keys;
- exact resolved-secret audit matching;
- literal loopback publication and network isolation;
- absence of Guardian and database-sidecar services;
- pinned upstream image packaging; and
- a real image build and `/api/health` runtime smoke.
