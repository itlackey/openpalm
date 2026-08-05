# Paperclip Addon Design

**Status:** Implemented
**Date:** 2026-08-04
**Upstream image:** `ghcr.io/paperclipai/paperclip`, pulled and digest-pinned

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
  image: ghcr.io/paperclipai/paperclip:sha-<commit>@sha256:<digest>
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

OpenPalm does **not** build a Paperclip image. The upstream image is pulled and
pinned by digest, the same way `ollama` and `tunnel` consume third-party
software. Upstream publishes no semver tag, so the digest is the pin and the
`sha-<commit>` tag records which upstream commit it came from.

That upstream runtime already provides everything the addon needs, which is
precisely why rebuilding it was a liability rather than a feature:

- the agent CLIs Paperclip's local adapters spawn by bare name — `claude`,
  `codex`, `opencode`, `gemini` — plus `ripgrep`, `python3`, `openssh-client`,
  `jq`;
- an entrypoint that remaps the runtime UID/GID and chowns the instance tree,
  including the root-owned-fresh-volume case;
- `prepareEmbeddedPostgresNativeRuntime()` invoked by the server at startup, so
  the embedded database needs no build-time preparation.

An earlier revision packaged the upstream npm release into an
`openpalm/paperclip` image. It shipped two defects that both reduce to the same
cause — owning the reproduction of someone else's runtime — and neither is
detectable by a test that does not build and run the image: every local agent
adapter failed on a missing binary while `/api/health` still returned 200, and
~560 MB of unloadable `opencode` binaries rode along per amd64 image. Pulling
upstream removes that whole class, along with the Dockerfile, the publish
workflow, four CLI version pins, and the version-drift machinery that kept them
agreeing.

To bump: resolve the new digest and update the single `image:` line. The compose
contract test asserts the reference stays digest-pinned.

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
- the image reference staying a digest-pinned upstream pull rather than a
  rebuild.

**Not covered:** a runtime smoke of `/api/health`. No test starts the
container. This is now upstream's image, tested upstream, so the residual risk
is a bad digest rather than a mis-assembled runtime — the failure mode the
rebuild introduced and this design removes.
