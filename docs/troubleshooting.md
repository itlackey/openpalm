# Troubleshooting

Start with the host control plane rather than reconstructing a Compose command:

```bash
openpalm doctor
openpalm status
openpalm validate
```

If you operate Docker Compose directly, inspect the managed files under
`system/stack/` (three core files, plus a voice overlay when voice LAN access
is on), the user overlay, the sole env file, and the exact active profiles. See
the [Manual Compose Runbook](operations/manual-compose-runbook.md).

> Existing 0.10.x installation? Use the historical
> [0.10.x to 0.11.0 upgrade guide](operations/upgrade-0.10-to-0.11.md) for that
> layout transition.

## Docker Is Unavailable

Symptoms include `docker: command not found`, daemon connection failures, or a
missing Compose plugin.

```bash
docker info
docker compose version
```

Install/start Docker and ensure the current host user can access it. On Linux,
group membership changes normally require logging out and back in.

## Port Conflict

Common defaults are:

| Port | Service |
|---|---|
| `3800` | Assistant UI |
| `3810` | Assistant OpenCode |
| `3821` | Guardian-compatible API |
| `3830` | Guardian direct ingress |
| `3831` | Guardian principal admin |
| `3880` | Host UI/admin process |
| `8880` | Voice API |

There is no separate chat port. For a container listener, change the matching
`OP_*_PORT` value in `state/stack.env` and reapply the stack. For host UI port
`3880`, change `OP_HOST_UI_PORT` and restart the host UI process.

```bash
lsof -i :3800
```

## Assistant UI Does Not Load

The normal UI is served by the assistant container at
<http://localhost:3800/>. Check both the UI and OpenCode probes:

```bash
curl -fsS http://127.0.0.1:3800/health
curl -fsS http://127.0.0.1:3810/health
openpalm logs assistant
```

The UI is baked into the assistant image. Do not place an npm UI tarball in the
knowledge stash. `openpalm update` refreshes both the assistant image and the
host-managed skeleton assets.

## openpalm.local Stopped Resolving

`<name>.local` (`openpalm.local` by default) is advertised over mDNS by
whichever host `openpalm` process is currently running (bare `openpalm`,
`openpalm app`, `openpalm admin`, or Electron) — never by a container. The
assistant container's UI keeps serving `:3800` under Docker's `unless-stopped`
restart policy independent of any host process, so after a reboot (or any time
no host `openpalm` process is running) the name can stop resolving while the
service itself is still up and reachable.

```bash
curl -fsS http://<host-ip>:3800/health
```

If that succeeds, the container is fine and only the advertisement is missing.
Start a host process (`openpalm`, `openpalm app`, or `openpalm admin`) to
resume advertising, or just use the IP URL — it does not depend on mDNS at
all. See [Setup Guide → Reaching OpenPalm from Another Device](setup-guide.md#reaching-openpalm-from-another-device).

Also confirm the client device supports mDNS: some routers block multicast
between LAN segments/VLANs, and some Android builds do not resolve `.local`
names in the browser at all — the IP URL is the only guaranteed path there.

## Host Admin UI Does Not Load

The admin-capable UI is a host process, not a container:

```bash
openpalm admin
```

It opens at <http://127.0.0.1:3880/host> by default. If port `3880` changed,
check `OP_HOST_UI_PORT` in `state/stack.env`.

Requests to `/admin/*` correctly return `404`. Current UI API routes use
`/api/auth/*`, `/api/host/*`, and `/api/assistant/*`.

## Addon Is Missing

OpenPalm translates `OP_ENABLED_ADDONS` into Compose profiles only when an
OpenPalm control-plane command runs. A raw Compose invocation must include the
profiles explicitly.

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

Alternatively, let the control plane resolve profiles:

```bash
openpalm addon enable discord
openpalm start
```

## Assistant Does Not Answer

1. Check `openpalm status` and `openpalm logs assistant`.
2. Confirm `knowledge/secrets/auth.json` contains valid OpenCode provider auth.
3. Confirm the configured provider/model is reachable from the container.
4. Recreate the assistant after changing cached auth or model configuration.

For a host model server, a container cannot use the host's `localhost`. Use
`host.docker.internal` where supported, for example:

```text
http://host.docker.internal:11434/v1
```

## Model List Is Empty / "Unexpected server error" on Reload

`knowledge/secrets/auth.json` holds one entry per connected provider. If it
holds an entry for a provider OpenCode cannot resolve — one that is absent from
models.dev and undeclared in any `opencode.json`/`opencode.jsonc` — then
`Provider.list` throws and **every** provider request fails, not just that one.
The model picker goes empty and reloads report an unexpected server error.

This happens when a provider you connected is later renamed or dropped from
OpenCode's catalog: the credential outlives the provider.

Find the orphans:

```bash
docker exec openpalm-assistant-1 node -e 'const f=require("fs"),h=process.env.HOME,d=JSON.parse(f.readFileSync(h+"/.cache/opencode/models.json","utf8")),a=JSON.parse(f.readFileSync(h+"/.local/share/opencode/auth.json","utf8"));console.log(Object.keys(a).filter(p=>!d[p]))'
```

Any provider printed that you have not declared yourself under `provider` in
`config/assistant/opencode.jsonc` is orphaned. Remove it from
`knowledge/secrets/auth.json` and recreate the assistant.

## Connecting Another OpenCode Client

Point external clients at the **assistant** port, not the UI:

```text
http://127.0.0.1:3810
```

Username `opencode`; password is the contents of
`private/secrets/op_opencode_password`. This is **not** the UI login password —
that one only signs in to the OpenPalm UI and Opencode will reject it.

Two things that look right but are not:

- `.../oc` is the UI's own same-origin proxy. It authenticates with the browser
  session cookie only, strips `Authorization`, and answers `405` to `OPTIONS`,
  so no external client can use it.
- `localhost` resolves to `::1` first on many systems, while the UI listens on
  IPv4 `127.0.0.1` only. Clients that do not fall back to IPv4 report "could
  not connect". Always use the literal `127.0.0.1`.

## Portal Authentication Fails

For `401` or `403` responses:

- Confirm the portal and Guardian are running under the same active profile set.
- Confirm the relevant `portal_<id>_secret` exists in `private/secrets/`.
- Confirm bot credentials also live in `private/secrets/`.
- Recreate Guardian and the portal after rotating startup-only secrets.
- Check `openpalm logs guardian` and `openpalm logs <portal>`.

Delegated credentials do not belong under `knowledge/secrets/`. That directory
retains only assistant-readable provider `auth.json`.

## Content Is Blocked or Moderation Is Unavailable

Guardian content validation is on by default in code and Compose. Suspicious
messages are escalated to its local moderator and fail closed when a verdict
cannot be obtained.

```bash
openpalm logs guardian
```

Check provider auth in `knowledge/secrets/auth.json`, the model configured in
`config/guardian/opencode.json`, and Guardian readiness. Explicitly setting
`GUARDIAN_CONTENT_VALIDATION=0` opts out; an unset value remains on.

## Voice Does Not Start

Voice is defined in `system/stack/services.compose.yml`, uses an
`addon.voice.*` profile, joins `addon_net`, and publishes only
`127.0.0.1:8880` by default.

By default, voice only works from a **host** UI (bare `openpalm`, `openpalm
app`, `openpalm admin`, or Electron) — not from the assistant-served UI that
`access.networkAccess` publishes to your LAN at `:3800`. That co-process only
has a loopback path to its own container, never the sibling voice container,
so its entrypoint sets `OP_UI_NO_LOCAL_VOICE=1` and `/voice` `503`s there by
design.

To let LAN devices use voice through the published UI, turn on **Let devices
on your network use voice through the published UI** in the voice addon's
settings drawer (writes `OP_VOICE_LAN_ACCESS=true` to `state/stack.env`),
then recreate both the assistant and voice containers (`openpalm start`, or
`openpalm start assistant voice`) so the change actually takes effect —
saving the addon setting alone only writes the file. This grants the voice
container `assistant_net` (`voice.compose.lan.yml`, a static opt-in overlay)
so the assistant's served UI can reach it over Docker DNS
(`OP_VOICE_URL=http://voice:8880`) instead of failing closed. It is off by
default because, besides Ollama, it is the one case where an addon crosses
the normal addon-network boundary — see `services.compose.yml`'s header
comment and `voice.compose.lan.yml` for the reasoning.

```bash
openpalm addon enable voice
openpalm logs voice
curl -fsS http://127.0.0.1:8880/health
```

The default models are image-baked. Hardware selection uses managed voice
profiles and control-plane host checks, which may select managed CDI/rootless
fallbacks without an operator-authored GPU overlay.

## Permission Denied on Mounted Paths

```bash
openpalm repair-ownership
```

Also compare `OP_UID` and `OP_GID` in `state/stack.env` with `id -u` and
`id -g`. Avoid running normal lifecycle commands with `sudo`, which can create
root-owned host files.

## Update Left the Stack Unhealthy

Use the managed update path rather than copying a new skeleton over the home:

```bash
openpalm update
openpalm status
openpalm rollback
```

Raw copying is incomplete because install/update also generates state, private
secrets, caches, and runtime files.

## Factory Reset

Back up first. Then remove the stack and all OpenPalm-owned trees:

```bash
openpalm uninstall --purge
```

`--purge` removes every tree under `OP_HOME`, but not the installer's own
artifacts: the `openpalm` CLI binary, the PATH entry `setup.sh`/`setup.ps1`
added to your shell profile, or the `op` alias. There is no command that
undoes those; remove them by hand if you want them gone too.

Linux/macOS:

```bash
rm "${OP_INSTALL_DIR:-$HOME/.local/bin}/openpalm"
```

Then remove the `# OpenPalm CLI` block (the `PATH` export and/or `alias
op=openpalm` line) from your shell profile (`~/.bashrc`, `~/.zshrc`,
`~/.profile`, etc., depending on your shell).

Windows: delete `%LOCALAPPDATA%\openpalm\bin\openpalm.exe` (or your
`OP_INSTALL_DIR`), then remove the matching entry from your User `Path` under
**Settings → System → About → Advanced system settings → Environment
Variables**.

Reinstall with `setup.sh`, `setup.ps1`, or `openpalm install --file`. Do not
replace this with a copy of `packages/skeleton/`.
