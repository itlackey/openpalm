# Manual Compose Runbook

This runbook is for operators who want to manage their OpenPalm stack directly
using `docker compose` without the CLI or admin tooling. The generated
`$OP_HOME/run.sh` is the operator-facing entrypoint; it reproduces the live
compose invocation used by the stack.

---

## Prerequisites

- Docker Engine or Docker Desktop with the Compose V2 plugin installed
- `docker compose version` should report `v2.x.x` or later

Verify:

```bash
docker compose version
```

---

## File Resolution

OpenPalm state lives under `~/.openpalm/` (or `$OP_HOME` if you have set that
variable). The relevant files for running the stack are:

| Path | Purpose |
|---|---|
| `~/.openpalm/config/stack/core.compose.yml` | Core services: assistant (also runs the scheduler co-process), guardian |
| `~/.openpalm/config/stack/services.compose.yml` | First-party optional services, profile-gated |
| `~/.openpalm/config/stack/channels.compose.yml` | First-party optional channels, profile-gated |
| `~/.openpalm/config/stack/custom.compose.yml` | User custom services and overlays |
| `~/.openpalm/config/stack/stack.env` | System-managed non-secret values: ports, UID/GID, image tags, profiles, paths |
| `~/.openpalm/stash/vaults/secrets/` | System-managed secret files; directory mode `0700`, file mode `0600` |
| `~/.openpalm/config/stack.yml` | Optional tooling metadata (helper scripts read this; it is not deployment truth) |

The project name defaults to `openpalm` and can be overridden with the
`OP_PROJECT_NAME` environment variable.

To see which first-party profiles are enabled:

```bash
grep '^COMPOSE_PROFILES=' ~/.openpalm/config/stack/stack.env
```

---

## Building the Compose Command

Use the generated `run.sh` for the exact live stack command. It already
includes the correct compose files, non-secret env file, and profile selection.

### Helper: `op` shell function

Typing the full command every time is tedious. Add this shell function to your
`~/.bashrc` or `~/.zshrc` for ad hoc compose operations with core plus custom
overlays. Use generated `run.sh` when you need the exact first-party addon list
and profiles selected by OpenPalm tooling:

```bash
op() {
  local OP_HOME="${OP_HOME:-$HOME/.openpalm}"
  local PROJECT_NAME="${OP_PROJECT_NAME:-openpalm}"
  local profile_args=""

  if [ -f "$OP_HOME/config/stack/stack.env" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$OP_HOME/config/stack/stack.env"
    set +a
  fi

  IFS=',' read -r -a compose_profiles <<< "${COMPOSE_PROFILES:-}"
  for profile in "${compose_profiles[@]}" "${OP_VOICE_PROFILE:-}" "${OP_OLLAMA_PROFILE:-}"; do
    [ -n "$profile" ] && profile_args="$profile_args --profile $profile"
  done

  docker compose \
    --project-name "$PROJECT_NAME" \
    --env-file "$OP_HOME/config/stack/stack.env" \
    -f "$OP_HOME/config/stack/core.compose.yml" \
    -f "$OP_HOME/config/stack/services.compose.yml" \
    -f "$OP_HOME/config/stack/channels.compose.yml" \
    -f "$OP_HOME/config/stack/custom.compose.yml" \
    $profile_args \
    "$@"
}
```

The generated `run.sh` remains the primary operator-facing entrypoint for
starting/restarting the stack. It records the fixed compose file list and the
live profile selection in one place.

### Manual command (without the helper)

If you need the raw compose invocation for debugging, use:

```bash
OP_HOME="${OP_HOME:-$HOME/.openpalm}"
PROJECT_NAME="${OP_PROJECT_NAME:-openpalm}"

docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/config/stack/stack.env" \
  -f "$OP_HOME/config/stack/core.compose.yml" \
  -f "$OP_HOME/config/stack/services.compose.yml" \
  -f "$OP_HOME/config/stack/channels.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile addon.chat \
  <command>
```

Use the same fixed `-f` file list every time. Enable built-ins with `--profile`
or `COMPOSE_PROFILES`; put custom services and overlays in `custom.compose.yml`.

---

## Preflight: Validate Before Mutating

Always run `config` before any start, stop, or recreate operation. This catches
misconfiguration early — before containers are affected.

```bash
# Validate compose merge and variable substitution (exits non-zero on error)
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/config/stack/stack.env" \
  -f "$OP_HOME/config/stack/core.compose.yml" \
  -f "$OP_HOME/config/stack/services.compose.yml" \
  -f "$OP_HOME/config/stack/channels.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile addon.chat \
  config --quiet

# List resolved service names
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/config/stack/stack.env" \
  -f "$OP_HOME/config/stack/core.compose.yml" \
  -f "$OP_HOME/config/stack/services.compose.yml" \
  -f "$OP_HOME/config/stack/channels.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile addon.chat \
  config --services
```

<details>
<summary>Without the wrapper</summary>

```bash
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/config/stack/stack.env" \
  -f "$OP_HOME/config/stack/core.compose.yml" \
  -f "$OP_HOME/config/stack/services.compose.yml" \
  -f "$OP_HOME/config/stack/channels.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile "$OP_VOICE_PROFILE" \
  --profile "$OP_OLLAMA_PROFILE" \
  config --quiet
```

</details>

`config --quiet` is the authoritative check that confirms:
- All compose files merge without conflict
- All `${VAR}` references resolve to a value (or an acceptable empty string)
- No syntax or schema errors exist in any file

If this command fails, fix the reported issue before proceeding.

---

## Common Operations

All examples below use the `op` helper function. If you are not using the
helper, substitute the full `docker compose ...` command (see above).

### Start the stack

```bash
op up -d
```

### Stop and remove containers

```bash
op down
```

### List container status

```bash
op ps
```

### View recent logs

```bash
op logs --tail 100
```

### Follow logs for a specific service

```bash
op logs -f assistant
```

### Restart a specific service

```bash
op restart guardian
```

### Pull latest images

```bash
op pull
```

---

## Optional Service Management

### Enabling a built-in optional service

1. Enable the built-in profile:
   ```bash
   openpalm addon enable <name>
   ```
2. Run preflight to confirm the merge is clean:
   ```bash
   op config --quiet
   ```
3. Start or recreate:
   ```bash
   op up -d
   ```

### Disabling a built-in optional service

1. Remove the built-in profile from `COMPOSE_PROFILES`:
   ```bash
   openpalm addon disable <name>
   ```
2. Recreate the stack:
   ```bash
   op up -d --remove-orphans
   ```

The `--remove-orphans` flag stops and removes containers from profiles no longer
enabled.

Using `--remove-orphans` on `up -d` is the least-disruptive approach when you
want to drop an addon without restarting everything:

```bash
op up -d --remove-orphans
```

Containers from addons no longer in the file list are stopped and removed.

---

## Environment Variable Precedence

Docker Compose resolves variables at two distinct stages, and mixing them up is
a common source of confusion.

### Stage 1: Compose variable substitution (`--env-file`)

`--env-file` flags supply values that Compose interpolates into the compose YAML
before creating containers. For example, `${OP_ADMIN_PORT:-3880}` in
`core.compose.yml` is resolved at this stage.

Precedence for substitution (highest to lowest):

1. **Process environment (host shell)** — any variable already exported in your
   shell overrides everything else, including `--env-file` contents.
2. **`--env-file` flags** — `stack.env` supplies non-secret substitution values.
3. **Compose file `environment:` defaults** — inline fallback values.

### Stage 2: Container runtime environment and secret files

Service-level `environment:` entries become the container process environment.
Secret-like values must not be placed there directly; expose only a `*_FILE`
variable that points at a Compose secret mounted from `stash/vaults/secrets/`.

Service-level `env_file:` is intentionally disallowed because it grants broad,
hard-to-audit environment access. Grant each service only the secret files it
needs with Compose `secrets:`.

### Host shell override warning

If your shell has a variable like `OPENAI_API_KEY` exported, Compose can still
substitute it into any matching `${OPENAI_API_KEY}` expression in custom compose
overlays. Secret-like substitutions are not allowed in shipped files; clear or
unset host variables you do not want custom overlays to see before running
compose:

```bash
unset OPENAI_API_KEY
docker compose ... up -d
```

---

## Optional `extends` Support

Addon compose files may use Compose's `extends` keyword to inherit a service
definition from `core.compose.yml` or another base file. This is an advanced
deduplication pattern.

The standard addon model does not require `extends` — a self-contained
file-drop compose overlay is the default approach. You only need to understand
`extends` if you are authoring a custom addon that shares significant
configuration with an existing service.

If an addon uses `extends`:

```yaml
# addons/my-addon/compose.yml
services:
  my-service:
    extends:
      file: ../../core.compose.yml
      service: assistant
    environment:
      EXTRA_VAR: value
```

Always run `config --quiet` to verify the merge resolves correctly before
starting the stack. Path references in `extends.file` must be relative to the
file that contains the `extends` directive.

---

## Secret Rotation

### LLM provider keys and system secrets (`stash/vaults/secrets/`)

API keys, HMAC secrets, and service auth tokens live as files under
`stash/vaults/secrets/` and are granted through Compose `secrets:`. `stack.env`
is non-secret. Changes require a full container recreate for services that read
the file only at startup:

```bash
chmod 700 ~/.openpalm/stash/vaults/secrets
install -m 600 /dev/null ~/.openpalm/stash/vaults/secrets/provider_openai_api_key
$EDITOR ~/.openpalm/stash/vaults/secrets/provider_openai_api_key

# Recreate all containers to pick up new values
op up -d --force-recreate
```

Note: `docker compose restart` may not re-read every startup-only secret path.
Use `up -d --force-recreate` (or `down` followed by `up -d`) when rotating
service secrets.

---

## Backup and Restore

### Backup

```bash
tar czf openpalm-backup-$(date +%Y%m%d).tar.gz ~/.openpalm
```

This archives the complete stack: compose files, file-based secrets, AKM vault
data, config, and all persistent service data.

### Restore

```bash
# Extract backup
tar xzf openpalm-backup-20240101.tar.gz -C ~/

# Start the stack
op up -d
```

There is no staging tier to reconstruct. The backup contains the live state
directly — extract and start.

---

## Related Docs

| Document | Purpose |
|---|---|
| [installation.md](../installation.md) | Initial setup and home layout |
| [troubleshooting.md](../troubleshooting.md) | Common problems and fixes |
| [core-principles.md](../technical/core-principles.md) | Architectural rules and filesystem contract |
| [environment-and-mounts.md](../technical/environment-and-mounts.md) | Per-service mount and env details |
| `.openpalm/config/stack/README.md` | Stack directory quick reference |
