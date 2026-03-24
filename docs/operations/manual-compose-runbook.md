# Manual Compose Runbook

This runbook is for operators who want to manage their OpenPalm stack directly
using `docker compose` without the CLI or admin tooling. The compose file list
is the deployment truth — what you pass with `-f` is exactly what runs.

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
| `~/.openpalm/stack/core.compose.yml` | Core services: assistant, guardian, memory, scheduler |
| `~/.openpalm/stack/addons/<name>/compose.yml` | One file per enabled addon (admin, chat, api, etc.) |
| `~/.openpalm/vault/stack/stack.env` | System-managed values: tokens, ports, UID/GID, image tags |
| `~/.openpalm/vault/user/user.env` | User-managed settings: owner info, custom preferences |
| `~/.openpalm/config/stack.yaml` | Optional tooling metadata (helper scripts read this; it is not deployment truth) |

The project name defaults to `openpalm` and can be overridden with the
`OP_PROJECT_NAME` environment variable.

To see which addon compose files are present:

```bash
ls ~/.openpalm/stack/addons/
```

---

## Building the Compose Command

Construct the full `docker compose` command by naming every file you want active.
Only files passed with `-f` are part of the running stack.

```bash
OP_HOME="${OP_HOME:-$HOME/.openpalm}"
PROJECT_NAME="${OP_PROJECT_NAME:-openpalm}"

docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/vault/stack/stack.env" \
  --env-file "$OP_HOME/vault/user/user.env" \
  --env-file "$OP_HOME/vault/stack/guardian.env" \
  -f "$OP_HOME/stack/core.compose.yml" \
  -f "$OP_HOME/stack/addons/admin/compose.yml" \
  -f "$OP_HOME/stack/addons/chat/compose.yml" \
  <command>
```

Include only the `-f` flags for addons that are actually installed (i.e.,
directories present under `stack/addons/`). Referencing a file that does not
exist will cause Compose to fail with a clear error.

---

## Preflight: Validate Before Mutating

Always run `config` before any start, stop, or recreate operation. This catches
misconfiguration early — before containers are affected.

```bash
# Validate compose merge and variable substitution (exits non-zero on error)
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/vault/stack/stack.env" \
  --env-file "$OP_HOME/vault/user/user.env" \
  --env-file "$OP_HOME/vault/stack/guardian.env" \
  -f "$OP_HOME/stack/core.compose.yml" \
  -f "$OP_HOME/stack/addons/admin/compose.yml" \
  config --quiet

# List resolved service names
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/vault/stack/stack.env" \
  --env-file "$OP_HOME/vault/user/user.env" \
  --env-file "$OP_HOME/vault/stack/guardian.env" \
  -f "$OP_HOME/stack/core.compose.yml" \
  -f "$OP_HOME/stack/addons/admin/compose.yml" \
  config --services
```

`config --quiet` is the authoritative check that confirms:
- All compose files merge without conflict
- All `${VAR}` references resolve to a value (or an acceptable empty string)
- No syntax or schema errors exist in any file

If this command fails, fix the reported issue before proceeding.

---

## Common Operations

The examples below show a core + admin + chat setup. Adjust the `-f` list to
match the addons you have installed.

```bash
OP_HOME="${OP_HOME:-$HOME/.openpalm}"
PROJECT_NAME="${OP_PROJECT_NAME:-openpalm}"

BASE="docker compose \
  --project-name $PROJECT_NAME \
  --env-file $OP_HOME/vault/stack/stack.env \
  --env-file $OP_HOME/vault/user/user.env \
  --env-file $OP_HOME/vault/stack/guardian.env \
  -f $OP_HOME/stack/core.compose.yml \
  -f $OP_HOME/stack/addons/admin/compose.yml \
  -f $OP_HOME/stack/addons/chat/compose.yml"
```

### Start the stack

```bash
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/vault/stack/stack.env" \
  --env-file "$OP_HOME/vault/user/user.env" \
  --env-file "$OP_HOME/vault/stack/guardian.env" \
  -f "$OP_HOME/stack/core.compose.yml" \
  -f "$OP_HOME/stack/addons/admin/compose.yml" \
  -f "$OP_HOME/stack/addons/chat/compose.yml" \
  up -d
```

### Stop and remove containers

```bash
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/vault/stack/stack.env" \
  --env-file "$OP_HOME/vault/user/user.env" \
  --env-file "$OP_HOME/vault/stack/guardian.env" \
  -f "$OP_HOME/stack/core.compose.yml" \
  -f "$OP_HOME/stack/addons/admin/compose.yml" \
  -f "$OP_HOME/stack/addons/chat/compose.yml" \
  down
```

### List container status

```bash
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/vault/stack/stack.env" \
  --env-file "$OP_HOME/vault/user/user.env" \
  --env-file "$OP_HOME/vault/stack/guardian.env" \
  -f "$OP_HOME/stack/core.compose.yml" \
  -f "$OP_HOME/stack/addons/admin/compose.yml" \
  ps
```

### View recent logs

```bash
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/vault/stack/stack.env" \
  --env-file "$OP_HOME/vault/user/user.env" \
  --env-file "$OP_HOME/vault/stack/guardian.env" \
  -f "$OP_HOME/stack/core.compose.yml" \
  -f "$OP_HOME/stack/addons/admin/compose.yml" \
  logs --tail 100
```

### Follow logs for a specific service

```bash
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/vault/stack/stack.env" \
  --env-file "$OP_HOME/vault/user/user.env" \
  --env-file "$OP_HOME/vault/stack/guardian.env" \
  -f "$OP_HOME/stack/core.compose.yml" \
  logs -f assistant
```

### Restart a specific service

```bash
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/vault/stack/stack.env" \
  --env-file "$OP_HOME/vault/user/user.env" \
  --env-file "$OP_HOME/vault/stack/guardian.env" \
  -f "$OP_HOME/stack/core.compose.yml" \
  restart guardian
```

### Pull latest images

```bash
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/vault/stack/stack.env" \
  --env-file "$OP_HOME/vault/user/user.env" \
  --env-file "$OP_HOME/vault/stack/guardian.env" \
  -f "$OP_HOME/stack/core.compose.yml" \
  -f "$OP_HOME/stack/addons/admin/compose.yml" \
  -f "$OP_HOME/stack/addons/chat/compose.yml" \
  pull
```

---

## Addon Management

### Adding an addon

1. Verify the addon compose file exists:
   ```bash
   ls ~/.openpalm/stack/addons/
   ```
2. If installing from the registry, copy the addon directory into
   `~/.openpalm/stack/addons/<name>/`.
3. Run preflight to confirm the merge is clean:
   ```bash
   docker compose ... -f "$OP_HOME/stack/addons/<name>/compose.yml" config --quiet
   ```
4. Start or recreate with the new addon included:
   ```bash
   docker compose ... -f "$OP_HOME/stack/addons/<name>/compose.yml" up -d
   ```

### Removing an addon

1. Run `down` (or `up -d --remove-orphans` to avoid full teardown) using the
   same file set that was used for `up`, including the addon you are removing.
   This allows Compose to track which containers belong to the project.
2. Remove the addon directory:
   ```bash
   rm -rf ~/.openpalm/stack/addons/<name>
   ```
3. On next `up -d`, omit the `-f` flag for that addon.

Using `--remove-orphans` on `up -d` is the least-disruptive approach when you
want to drop an addon without restarting everything:

```bash
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/vault/stack/stack.env" \
  --env-file "$OP_HOME/vault/user/user.env" \
  --env-file "$OP_HOME/vault/stack/guardian.env" \
  -f "$OP_HOME/stack/core.compose.yml" \
  -f "$OP_HOME/stack/addons/admin/compose.yml" \
  up -d --remove-orphans
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
2. **`--env-file` flags in order** — later files override earlier ones for the
   same key. `user.env` is passed after `stack.env`, so user values win on any
   key that appears in both.
3. **Compose file `environment:` defaults** — inline fallback values.

### Stage 2: Container runtime environment (`env_file:` in compose services)

Service-level `env_file:` entries inject variables into the running container's
process environment at startup. This is separate from substitution — it is what
the application inside the container sees.

**Do not remove `env_file:` entries from service definitions.** The `--env-file`
flags on the `docker compose` command and the `env_file:` entries inside service
blocks serve different purposes and both are needed.

### Host shell override warning

If your shell has a variable like `GROQ_API_KEY` exported, it will shadow the
value from `user.env` regardless of what that file contains. Clear or unset
host variables you do not want to leak before running compose:

```bash
unset GROQ_API_KEY
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

### LLM provider keys and system secrets (`vault/stack/stack.env`)

API keys, provider config, admin token, HMAC secrets, and service auth tokens
all live in `stack.env`. Changes require a full container recreate to take
effect:

```bash
$EDITOR ~/.openpalm/vault/stack/stack.env

# Recreate all containers to pick up new values
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/vault/stack/stack.env" \
  --env-file "$OP_HOME/vault/user/user.env" \
  --env-file "$OP_HOME/vault/stack/guardian.env" \
  -f "$OP_HOME/stack/core.compose.yml" \
  -f "$OP_HOME/stack/addons/admin/compose.yml" \
  up -d --force-recreate
```

Note: `docker compose restart` does NOT re-read `--env-file` values. You must
use `up -d --force-recreate` (or `down` followed by `up -d`) to apply env file
changes to running containers.

---

## Backup and Restore

### Backup

```bash
tar czf openpalm-backup-$(date +%Y%m%d).tar.gz ~/.openpalm
```

This archives the complete stack: compose files, vault env files, config, and
all persistent service data.

### Restore

```bash
# Extract backup
tar xzf openpalm-backup-20240101.tar.gz -C ~/

# Start the stack with the same file set used previously
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$HOME/.openpalm/vault/stack/stack.env" \
  --env-file "$HOME/.openpalm/vault/user/user.env" \
  -f "$HOME/.openpalm/stack/core.compose.yml" \
  -f "$HOME/.openpalm/stack/addons/admin/compose.yml" \
  up -d
```

There is no staging tier to reconstruct. The backup contains the live state
directly — extract and start.

---

## Related Docs

| Document | Purpose |
|---|---|
| [installation.md](../installation.md) | Initial setup and home layout |
| [troubleshooting.md](../troubleshooting.md) | Common problems and fixes |
| [core-principles.md](../technical/authoritative/core-principles.md) | Architectural rules and filesystem contract |
| [environment-and-mounts.md](../technical/environment-and-mounts.md) | Per-service mount and env details |
| `.openpalm/stack/README.md` | Stack directory quick reference |
