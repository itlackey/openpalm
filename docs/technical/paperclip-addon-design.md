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
    - ${OP_HOME:?}/data/paperclip:/paperclip
    - ${OP_HOME:?}/config/paperclip/opencode:/paperclip/.config/opencode:ro
    - ${OP_HOME:?}/system/paperclip:/opt/openpalm/paperclip:ro
    - ${OP_HOME:?}/cache/paperclip-opencode/runtime:/etc/opencode
    - ${OP_HOME:?}/config/paperclip/akm:/etc/akm
    - ${OP_HOME:?}/knowledge:/stash
    - ${OP_HOME:?}/data/paperclip-akm/cache:/opt/akm/cache
    - ${OP_HOME:?}/data/paperclip-akm/data:/opt/akm/data
  env_file:
    - ${OP_HOME:?}/state/env/paperclip.env
  environment:
    XDG_CONFIG_HOME: /paperclip/.config
    OPENCODE_CONFIG_DIR: /etc/opencode
    AKM_BUNDLE_DIR: /stash
    AKM_CONFIG_DIR: /etc/akm
    AKM_CACHE_DIR: /opt/akm/cache
    AKM_DATA_DIR: /opt/akm/data
    AKM_STATE_DIR: /opt/akm/data/state
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

AKM is added through standard OpenCode configuration rather than an image
layer. Managed `system/paperclip/` contains:

- exact dependencies `akm-opencode@0.9.9202609021827` and `akm-cli@0.9.9`;
- `plugins/akm.ts`, which re-exports only the plugin function;
- `bin/bun`, which sets `BUN_BE_BUN=1` and executes `opencode`, exposing the
  Bun runtime already embedded in Paperclip's OpenCode binary;
- `bin/opencode`, which removes long-lived Paperclip server secrets before
  executing the pinned upstream OpenCode binary;
- `security.md`, which tells agents to use injected Paperclip API variable
  references without enumerating or logging their environment.

The AKM export adapter and embedded-Bun launcher are necessary for the currently
pinned upstream runtime. Its OpenCode `1.3.0` loader invokes every module
export, while the published AKM plugin also exports helpers, and its image has
no standalone `bun` command even though OpenCode internally runs as Bun
`1.3.10`. Listing the npm plugin directly therefore crashes config loading, and
invoking the installed `akm` shim directly cannot resolve its shebang. The local
adapter removes the extra exports; the launcher supplies that already-present runtime.
This is deliberate compatibility complexity, not a second Paperclip runtime,
and must be re-tested whenever the upstream image digest changes.

The managed launcher atomically publishes changed config, plugin, instruction,
and manifest files into `cache/paperclip-opencode/runtime` before OpenCode
starts. OpenCode then performs its normal exact-pinned config dependency install
there on first use. Its mutable manifest, lockfile, and `node_modules` remain
regenerable cache, not managed or user configuration, and are not included in
backups. The read-only managed launcher stays first in `PATH`; the writable
cache is never trusted as launcher source, and an unavailable managed tree fails
closed. Before republishing the managed files, the launcher removes everything
from the runtime config except the dependency manifest, lockfile, installed
packages, and bootstrap lock, so retired auto-discovered plugins or tools cannot
survive an update. There is no Paperclip entrypoint wrapper and no boot-time
global package install.

The managed manifest deliberately omits `@opencode-ai/plugin`: OpenCode adds
its own exact matching API package to the runtime copy. The launcher keeps a
managed-manifest snapshot in the cache, resets the runtime manifest when the
release pin changes or either required package is absent, and serializes that
bootstrap with `flock`. Installation is bounded below Paperclip's model-discovery
timeout; the exact installed versions, executable `akm` shim, plugin
initialization, and required `akm_search`, `akm_show`, `akm_curate`,
`akm_feedback`, and `akm_remember` hooks are verified before the successful
manifest snapshot is published.
`OPENCODE_STRICT_CONFIG_DEPS=1` makes installation fail closed instead of
silently starting without AKM.

User OpenCode settings remain separate at `config/paperclip/opencode/`, mounted
read-only at `/paperclip/.config/opencode`. `OPENCODE_CONFIG_DIR=/etc/opencode`
gives the managed plugin bootstrap precedence without letting the service
rewrite operator settings.

The managed permission layer grants external-directory access to `/stash` and
to Paperclip's own generated instruction and agent-workspace trees under
`/paperclip/instances/`. Paperclip passes instruction files from outside each
project cwd and sets `AGENT_HOME` to its managed workspace; without those narrow
wildcards, noninteractive OpenCode asks for approval and immediately
auto-rejects mandatory instruction and memory reads. Both paths remain inside
Paperclip's own `/paperclip` data mount.

To bump: resolve the new digest, update the single `image:` line, then re-run the
OpenCode/AKM acceptance because the compatibility adapters are tied to verified
behavior in the pinned image. The compose contract test asserts the image stays
digest-pinned and the AKM versions stay aligned with the assistant.

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

Paperclip receives the shared `knowledge/` tree at `/stash`, exactly as the
assistant does. It used to receive two nested overmounts on `/stash/env` and
`/stash/secrets` pointing at empty per-service directories — a boundary held up
by hiding one mount behind another, which the tree-name-equals-mount rule
forbids. Secret routing is default-deny into `state/secrets/` now, so nothing
agent-private is left under `knowledge/` for those overmounts to hide, and they
are gone.

Everything in `knowledge/` is therefore readable by every agent that gets
`/stash` — the assistant and Paperclip alike — and must not be treated as
delegated OpenPalm service credentials. `state/secrets/` and `state/env/` remain
unmounted. Granting an addon a narrower view is a `:ro` mount plus an AKM bundle
entry, not an overmount.

The pinned `opencode_local` adapter inherits the Paperclip server's complete
environment when it spawns OpenCode. The managed `bin/opencode` launcher
therefore removes `BETTER_AUTH_SECRET`, `PAPERCLIP_AGENT_JWT_SECRET`, and the
obsolete `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` before OpenCode starts. It
deliberately retains the short-lived, run-scoped `PAPERCLIP_API_KEY` used for
Paperclip API coordination. Managed agent instructions prohibit environment
enumeration and require using that variable by reference so its value does not
enter tool logs.

This is process-environment hygiene, not hostile-code isolation. Upstream local
agents still share Paperclip's container, UID, PID namespace, and durable data
mount. An agent intentionally trying to inspect the parent process or
Paperclip's own data is outside this addon's security boundary; that threat
model requires an upstream isolated-agent runtime or a separate container.

## Secrets

The pinned upstream image requires `BETTER_AUTH_SECRET` and
`PAPERCLIP_AGENT_JWT_SECRET` as environment variables and does not
offer `*_FILE` alternatives. Before generic enablement,
`preparePaperclipAddon()` creates exactly one delegated-credential file:

```text
$OP_HOME/state/env/paperclip.env
```

The directory is `0700` and the file is `0600`. Existing values are preserved;
unknown keys fail closed. The Compose secret audit grants a narrow exception
only for this service and path, and resolved secret values must exactly match
the hardened file.

The file is not under `knowledge/` and is never mounted into the assistant. It
is *excluded* from OpenPalm lifecycle safety backups, with `data/paperclip`:
a service's data and its credentials are one restore unit, and restoring
`BETTER_AUTH_SECRET` without the database it authenticates would give a working
login against empty data. Each snapshot names the file in its
`.backup-complete` marker; back it up with the database, per § Persistence.

AKM env and secret assets are a separate trust class. Values that Paperclip
agents are allowed to use go in the shared stash's own asset directories
(`knowledge/env/`, `knowledge/secrets/`), which every `/stash` holder can read.
They never replace or duplicate Paperclip's server authentication secrets in
`state/env/paperclip.env`.

## Persistence

All Paperclip instance state, including its embedded database, is stored under
`$OP_HOME/data/paperclip`. Normal addon disable does not remove it. As with all
service-owned `data/`, OpenPalm lifecycle safety backups exclude it — and
`state/env/paperclip.env` leaves with it, so the pair is never half-restored.
Operators must use Paperclip's own backup/export facilities for application
data, and archive that env file alongside them.

Paperclip's AKM state is isolated from the assistant:

- `config/paperclip/opencode/` and `config/paperclip/akm/` are user-owned and
  included in lifecycle safety backups;
- `system/paperclip/` is release-managed, read-only in the container, and
  refreshed on reconcile;
- `data/paperclip-akm/cache/` and `data/paperclip-akm/data/` hold AKM runtime
  state and are excluded with other service data;
- `cache/paperclip-opencode/runtime/` contains only regenerable OpenCode runtime
  config and dependencies and is excluded from backups.

## Verification

The implementation is covered by tests for:

- generic addon discovery and enablement;
- idempotent secret generation and file modes;
- rejection of unsupported private-env keys;
- exact resolved-secret audit matching;
- literal loopback publication and network isolation;
- absence of Guardian and database-sidecar services;
- the image reference staying a digest-pinned upstream pull rather than a
  rebuild;
- exact `/stash` overlay sources, OpenCode/AKM environment, and state mounts;
- exact AKM package pins, single-export compatibility adapter, and executable
  embedded-Bun and secret-scrubbing OpenCode launchers.

**Not covered by unit tests:** a runtime smoke of `/api/health` or the
first-use OpenCode dependency install. Manual acceptance must prove both the
plugin tool surface and bare `akm` command after every Paperclip image bump.
