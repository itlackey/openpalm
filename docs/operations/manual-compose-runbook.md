# Manual Compose Runbook

This runbook is for operating an already-generated OpenPalm installation with
Docker Compose directly. Create the installation first with `setup.sh`,
`setup.ps1`, or `openpalm install --file`; copying `packages/skeleton/` is not a
complete install.

## Runtime Inputs

| Path | Purpose |
|---|---|
| `$OP_HOME/system/stack/core.compose.yml` | Core assistant service |
| `$OP_HOME/system/stack/services.compose.yml` | Profile-gated first-party services |
| `$OP_HOME/system/stack/portals.compose.yml` | Profile-gated Guardian and portals |
| `$OP_HOME/system/stack/voice.compose.lan.yml` | **Conditional** — only when `OP_VOICE_LAN_ACCESS=true` in `stack.env` (see below) |
| `$OP_HOME/system/stack/guardian.compose.api.yml` | **Conditional** — the OpenAI-compatible edge's host publish; only when `OP_ACCESS_OPENAI_API=true` or `api` is in `OP_ENABLED_ADDONS` (see below) |
| `$OP_HOME/config/stack/custom.compose.yml` | Sole user-owned Compose overlay |
| `$OP_HOME/state/stack.env` | Sole non-secret Compose env file |
| `$OP_HOME/private/secrets/` | Delegated service secret sources |
| `$OP_HOME/knowledge/secrets/auth.json` | Provider auth used by OpenCode |

The first three managed files are always present in a generated install and
are used by every command. Two overlays are not fixed: `voice.compose.lan.yml`
joins the list only when the voice addon's **Let devices on your network use
voice through the published UI** setting is on
(`OP_VOICE_LAN_ACCESS=true` in `state/stack.env`), and
`guardian.compose.api.yml` — the ONE host publish for the guardian's
OpenAI-compatible listener — joins only when **Enable the OpenAI-compatible
API** is on (`OP_ACCESS_OPENAI_API=true`) or the `api` addon is enabled.
Without it the edge has no host port at all. Every OpenPalm-driven
Compose invocation (`openpalm start`, an update, a settings-triggered
recreate) includes it automatically when that flag is set — a manual command
that leaves it out silently recreates the voice container without
`assistant_net`, breaking LAN voice access until the file is included again.
Check the current value with:

```bash
grep OP_VOICE_LAN_ACCESS "$OP_HOME/state/stack.env"
```

`system/stack/` also ships `voice.compose.rootless.yml` and
`voice.compose.cdi.yml`, hardware-specific fallbacks the voice bring-up flow
selects on its own for rootless Docker or CDI-only NVIDIA hosts. Prefer
`openpalm start`/the voice addon's bring-up flow over inventing an equivalent
manual overlay for those two.

## Profile Contract

OpenPalm reads `OP_ENABLED_ADDONS` and adds the matching Compose profiles when
its CLI or host UI invokes Compose. Raw Docker Compose does not perform that
translation.

For raw commands, either:

- pass every active `--profile addon.<id>` argument before the subcommand, or
- set `COMPOSE_PROFILES` explicitly

Voice and Ollama use hardware-specific profiles, for example
`addon.voice.cpu`, `addon.voice.cuda`, `addon.ollama.cpu`, or
`addon.ollama.cuda`.

## Shell Helper

For Bash or Zsh:

```bash
op() {
  local home="${OP_HOME:-$HOME/.openpalm}"
  local project="${OP_PROJECT_NAME:-openpalm}"
  local key value
  local -a files=(
    -f "$home/system/stack/core.compose.yml"
    -f "$home/system/stack/services.compose.yml"
    -f "$home/system/stack/portals.compose.yml"
  )

  # Also picks up the conditional overlays so they are never silently
  # dropped (see Runtime Inputs above).
  local api_publish=0
  while IFS='=' read -r key value; do
    value="${value%$'\r'}"
    if [ -z "${OP_PROJECT_NAME:-}" ] && [ "$key" = "OP_PROJECT_NAME" ]; then
      project="$value"
    elif [ "$key" = "OP_VOICE_LAN_ACCESS" ] && [ "$value" = "true" ]; then
      files+=(-f "$home/system/stack/voice.compose.lan.yml")
    elif [ "$key" = "OP_ACCESS_OPENAI_API" ] && [ "$value" = "true" ]; then
      api_publish=1
    elif [ "$key" = "OP_ENABLED_ADDONS" ]; then
      case ",$value," in *,api,*) api_publish=1 ;; esac
    fi
  done < "$home/state/stack.env"

  if [ "$api_publish" = 1 ]; then
    files+=(-f "$home/system/stack/guardian.compose.api.yml")
  fi
  files+=(-f "$home/config/stack/custom.compose.yml")

  docker compose \
    --project-name "$project" \
    --env-file "$home/state/stack.env" \
    "${files[@]}" \
    "$@"
}
```

Do not shell-source `stack.env`; it is a Compose dotenv file, not a shell
script. Export `COMPOSE_PROFILES` in the calling shell when you want a persistent
manual profile set. Otherwise, pass profiles on each command:

```bash
op --profile addon.discord --profile addon.voice.cpu config --quiet
op --profile addon.discord --profile addon.voice.cpu up -d
```

## Raw Command

Without the helper:

```bash
OP_HOME="${OP_HOME:-$HOME/.openpalm}"
OP_PROJECT_NAME="${OP_PROJECT_NAME:-openpalm}"
docker compose \
  --project-name "$OP_PROJECT_NAME" \
  --env-file "$OP_HOME/state/stack.env" \
  -f "$OP_HOME/system/stack/core.compose.yml" \
  -f "$OP_HOME/system/stack/services.compose.yml" \
  -f "$OP_HOME/system/stack/portals.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile addon.discord \
  up -d
```

If `state/stack.env` records a non-default `OP_PROJECT_NAME`, export that exact
value before using the expanded command. Compose's `--env-file` does not apply
to shell expansion of the preceding `--project-name` argument.

If `OP_VOICE_LAN_ACCESS=true` is set in `state/stack.env`, add `-f
"$OP_HOME/system/stack/voice.compose.lan.yml"` before the `-f
"$OP_HOME/config/stack/custom.compose.yml"` line in the command above — the
`op` shell helper does this automatically.

## Validate Before Mutation

```bash
op --profile addon.discord config --quiet
op --profile addon.discord config --services
```

Run `config --quiet` with the same profiles you will use for `up`. It catches
Compose schema, interpolation, and merge errors, but it does not run OpenPalm's
secret-boundary audit. Use `openpalm validate` and `openpalm audit-secrets` when
the CLI is available.

## Common Operations

Core only:

```bash
op up -d
op ps
op logs --tail 100
op logs -f assistant
op restart assistant
op pull
op down
```

With addons, repeat the active profiles on each command unless
`COMPOSE_PROFILES` is set:

```bash
op --profile addon.discord ps
op --profile addon.discord logs -f guardian discord
op --profile addon.discord pull
op --profile addon.discord up -d
```

## Enable or Disable Addons

Preferred control-plane flow:

```bash
openpalm addon enable discord
openpalm addon disable discord
```

For entirely raw operation, keep `OP_ENABLED_ADDONS` in `state/stack.env`
aligned for future OpenPalm commands and pass the corresponding profiles
yourself. To remove a disabled profile's containers, run `up` with only the
remaining profiles and `--remove-orphans`:

```bash
op --profile addon.voice.cpu up -d --remove-orphans
```

## Custom Services

Put custom services and overlays only in:

```text
$OP_HOME/config/stack/custom.compose.yml
```

Do not edit managed `system/stack/*.compose.yml` files for durable
customization; lifecycle reconcile replaces them.

## Environment Precedence

Compose interpolation uses this order:

1. Variables exported in the host process
2. `$OP_HOME/state/stack.env` from `--env-file`
3. Defaults written in the Compose files

`state/stack.env` must remain non-secret. Service-level `env_file` grants are
not part of the shipped model. Delegated credentials arrive through Compose
`secrets:` and `*_FILE` variables.

## Secret Rotation

Delegated secrets live in `private/secrets/`. Provider auth remains in
`knowledge/secrets/auth.json`.

Example manual rotation:

```bash
secret="$HOME/.openpalm/private/secrets/op_api_key"
replacement="$(mktemp "$secret.XXXXXX")"
chmod 600 "$replacement"
$EDITOR "$replacement"
mv "$replacement" "$secret"
op --profile addon.api up -d --force-recreate guardian
```

Use every active profile in the real command. A plain `restart` may not refresh
startup-only secret mounts or process state.

## Voice

Voice is defined in `system/stack/services.compose.yml`, joins `addon_net`, and
publishes `127.0.0.1:${OP_VOICE_PORT_HOST:-8880}:8880`.
The default models are baked into the image.

```bash
op --profile addon.voice.cpu up -d voice
curl -fsS http://127.0.0.1:8880/health
```

Use the managed hardware profile selected for the host. For CDI or rootless
fallback selection, prefer the OpenPalm bring-up flow rather than inventing an
operator GPU overlay. To also expose voice to the assistant-served (LAN) UI,
see the `voice.compose.lan.yml` note under [Runtime Inputs](#runtime-inputs)
above and
[Troubleshooting → Voice Does Not Start](../troubleshooting.md#voice-does-not-start).

## Backup and Restore

```bash
op down
tar --exclude='.openpalm/cache' \
  -czf "openpalm-backup-$(date +%Y%m%d).tar.gz" \
  -C "$HOME" .openpalm
```

The archive includes `private/`. A full archive without the exclusion also
includes regenerable caches. See [Backup & Restore](../backup-restore.md).

## Related Docs

| Document | Purpose |
|---|---|
| [Setup Guide](../setup-guide.md) | Generate a complete runtime home |
| [Manual and Headless Install](manual-headless-install.md) | Version 2 setup specs |
| [Troubleshooting](../troubleshooting.md) | Common failures |
| [Core Principles](../technical/core-principles.md) | Architecture and security rules |
