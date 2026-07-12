# Manual Compose Runbook

This runbook is for operators who want to manage their OpenPalm stack directly
using `docker compose` without the CLI or admin tooling. The live compose
assembly is the managed file set under `$OP_HOME/system/stack/` plus the
user-owned overlay at `$OP_HOME/config/stack/custom.compose.yml`.

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
| `~/.openpalm/system/stack/core.compose.yml` | Core assistant runtime services; assistant also runs the scheduler co-process |
| `~/.openpalm/system/stack/services.compose.yml` | First-party optional services, profile-gated |
| `~/.openpalm/system/stack/portals.compose.yml` | First-party optional portals, profile-gated |
| `~/.openpalm/config/stack/custom.compose.yml` | User custom services and overlays |
| `~/.openpalm/knowledge/env/stack.env` | System-managed non-secret values: ports, UID/GID, image tags, paths, hardware profile selections |
| `~/.openpalm/knowledge/secrets/` | System-managed secret files; directory mode `0700`, file mode `0600` |

The project name defaults to `openpalm` and can be overridden with the
`OP_PROJECT_NAME` environment variable.

To see which first-party addons are enabled:

```bash
grep '^OP_ENABLED_ADDONS=' ~/.openpalm/knowledge/env/stack.env
```

---

## Building the Compose Command

Use the same managed/user compose file list for every command. First-party
addons are enabled with Compose profiles such as `addon.chat`.

### Helper: `op` shell function

Typing the full command every time is tedious. Add this shell function to your
`~/.bashrc` or `~/.zshrc` for ad hoc compose operations with the managed stack
files plus your custom overlay:

```bash
op() {
  local OP_HOME="${OP_HOME:-$HOME/.openpalm}"
  local PROJECT_NAME="${OP_PROJECT_NAME:-openpalm}"

  if [ -f "$OP_HOME/knowledge/env/stack.env" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$OP_HOME/knowledge/env/stack.env"
    set +a
  fi

  docker compose \
    --project-name "$PROJECT_NAME" \
    --env-file "$OP_HOME/knowledge/env/stack.env" \
    -f "$OP_HOME/system/stack/core.compose.yml" \
    -f "$OP_HOME/system/stack/services.compose.yml" \
    -f "$OP_HOME/system/stack/portals.compose.yml" \
    -f "$OP_HOME/config/stack/custom.compose.yml" \
    "$@"
}
```

Pass manual profile flags before the compose subcommand when needed, for example `op --profile addon.chat config`.

When bypassing the CLI/admin tooling, pass the active addon profiles yourself.
`OP_ENABLED_ADDONS` is an OpenPalm state record; Docker Compose only sees it if
the command also passes matching `--profile addon.<name>` flags or a
`COMPOSE_PROFILES` value.

### Manual command (without the helper)

If you need the raw compose invocation for debugging, use:

```bash
OP_HOME="${OP_HOME:-$HOME/.openpalm}"
PROJECT_NAME="${OP_PROJECT_NAME:-openpalm}"

docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/knowledge/env/stack.env" \
  -f "$OP_HOME/system/stack/core.compose.yml" \
  -f "$OP_HOME/system/stack/services.compose.yml" \
  -f "$OP_HOME/system/stack/portals.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile addon.chat \
  <command>
```

Use the same fixed `-f` file list every time. OpenPalm-managed built-ins are tracked in `OP_ENABLED_ADDONS`; for manual Docker Compose commands, pass the corresponding `--profile addon.<name>` arguments directly. Put custom services and overlays in `custom.compose.yml`.

---

## Preflight: Validate Before Mutating

Always run `config` before any start, stop, or recreate operation. This catches
misconfiguration early — before containers are affected.

```bash
# Validate compose merge and variable substitution (exits non-zero on error)
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/knowledge/env/stack.env" \
  -f "$OP_HOME/system/stack/core.compose.yml" \
  -f "$OP_HOME/system/stack/services.compose.yml" \
  -f "$OP_HOME/system/stack/portals.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile addon.chat \
  config --quiet

# List resolved service names
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/knowledge/env/stack.env" \
  -f "$OP_HOME/system/stack/core.compose.yml" \
  -f "$OP_HOME/system/stack/services.compose.yml" \
  -f "$OP_HOME/system/stack/portals.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile addon.chat \
  config --services
```

<details>
<summary>Without the wrapper</summary>

```bash
docker compose \
  --project-name "$PROJECT_NAME" \
  --env-file "$OP_HOME/knowledge/env/stack.env" \
  -f "$OP_HOME/system/stack/core.compose.yml" \
  -f "$OP_HOME/system/stack/services.compose.yml" \
  -f "$OP_HOME/system/stack/portals.compose.yml" \
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

1. Remove the built-in addon name from `OP_ENABLED_ADDONS`:
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

## Temporary Isolated Stack Verification

Use this flow before a release or after stack/entrypoint changes. It exercises a
real Compose stack without touching `~/.openpalm`, production ports, or the
default `openpalm` project name. It does not require live LLM provider
credentials; chat/model calls may fail, but health, client artifact
installation, static client serving, runtime config, CORS/preflight, and common
operator mistakes are covered.

Important host caveat: some Docker daemons cannot bind source files from
`/tmp` because the daemon runs in a private mount namespace. If Docker reports a
secret file under `/tmp` as missing, use `/var/tmp` or a repo-local temporary
directory instead. The stack is still temporary; the key safety requirement is a
unique `OP_HOME`, `OP_PROJECT_NAME`, and non-production ports.

Artifact boundary: this tarball path verifies an unpublished `@openpalm/client`
because the assistant mounts `knowledge/` at `/stash`. The guardian and skeleton
entrypoints still resolve `@openpalm/guardian` and `@openpalm/skeleton` from npm
by version. If local guardian or skeleton source differs from the npm artifact at
the same semver, this stack follows the npm artifact, not your working tree.

### 1. Choose an isolated home and build the unpublished client tarball

For a feature branch where `@openpalm/client@<version>` is not on npm yet, build
and pack it locally, then install that tarball through the same assistant
entrypoint path by using a `file:/stash/...` version spec.

```bash
REPO="$PWD"
VERIFY_ROOT="${VERIFY_ROOT:-$REPO/.tmp-openpalm-verify}"
VERIFY_HOME="$VERIFY_ROOT/home"
VERIFY_PROJECT="openpalm-verify"
VERIFY_VERSION="$(node -p "require('./package.json').version")"

rm -rf "$VERIFY_ROOT"
mkdir -p "$VERIFY_HOME"

bun run client:build
bun pm pack --cwd packages/client --destination "$VERIFY_ROOT" --quiet
CLIENT_TARBALL="$(ls "$VERIFY_ROOT"/openpalm-client-*.tgz | tail -1)"
```

Expected: the tarball contains at least `package/build/index.html`,
`package/build/.openpalm-client-version`, and `package/bin/serve.mjs`.

```bash
tar -tf "$CLIENT_TARBALL" | grep -E 'package/(build/index.html|build/.openpalm-client-version|bin/serve.mjs)'
```

### 2. Seed the isolated OP_HOME

```bash
rsync -a \
  --exclude=/package.json \
  --exclude=/manifest.json \
  --exclude=/tools.json \
  --exclude=/README.md \
  "$REPO/packages/skeleton/" "$VERIFY_HOME/"

OP_HOME="$VERIFY_HOME" bun -e "import { ensureHomeDirs } from './packages/lib/src/index.ts'; ensureHomeDirs();"
mkdir -p "$VERIFY_HOME/knowledge/env" "$VERIFY_HOME/knowledge/secrets"
cp "$CLIENT_TARBALL" "$VERIFY_HOME/knowledge/$(basename "$CLIENT_TARBALL")"
printf '{}\n' > "$VERIFY_HOME/knowledge/secrets/auth.json"
chmod 600 "$VERIFY_HOME/knowledge/secrets/auth.json"

for name in portal_chat_secret portal_api_secret portal_discord_secret portal_slack_secret op_guardian_admin_token op_guardian_mcp_token op_api_key op_opencode_password; do
  openssl rand -hex 16 > "$VERIFY_HOME/knowledge/secrets/$name"
  chmod 600 "$VERIFY_HOME/knowledge/secrets/$name"
done
# op_opencode_password (#563): both core.compose.yml (assistant) and
# portals.compose.yml (guardian) reference this file unconditionally via the
# opencode_server_password compose secret — it must exist before `compose up`
# even when OPENCODE_AUTH stays off (the value is inert in that case).
```

### 3. Write an isolated `stack.env`

```bash
cat > "$VERIFY_HOME/knowledge/env/stack.env" <<EOF
OP_HOME=$VERIFY_HOME
OP_UID=$(id -u)
OP_GID=$(id -g)
OP_IMAGE_NAMESPACE=openpalm
OP_IMAGE_TAG=dev
OP_ASSISTANT_VERSION=dev
OP_GUARDIAN_VERSION=dev
OP_PORTAL_VERSION=dev
OP_GUARDIAN_NPM_VERSION=$VERIFY_VERSION
OP_CLIENT_VERSION=file:/stash/$(basename "$CLIENT_TARBALL")
OP_SKELETON_VERSION=$VERIFY_VERSION
OP_PROJECT_NAME=$VERIFY_PROJECT
OP_SETUP_COMPLETE=true
OP_ASSISTANT_PORT=4820
OP_GUARDIAN_PORT=9190
OP_GUARDIAN_ADMIN_PORT=9181
OP_CHAT_PORT=9220
OP_API_PORT=9221
OP_CLIENT_PORT=3840
OP_ENABLED_ADDONS=chat
COMPOSE_PROFILES=addon.chat
GUARDIAN_DIRECT_INGRESS=true
GUARDIAN_CORS_ALLOWED_ORIGINS=http://127.0.0.1:3840
EOF
chmod 600 "$VERIFY_HOME/knowledge/env/stack.env"
```

Common user error: setting `OP_CLIENT_VERSION=$VERIFY_VERSION` before the client
package is published makes the assistant try npm and skip the client co-process
when npm returns 404. Use the `file:/stash/...` tarball spec for unpublished
feature-branch verification, then use the plain semver after release.

The same npm availability rule applies to `OP_GUARDIAN_NPM_VERSION` and
`OP_SKELETON_VERSION`. This runbook only provides local-tarball plumbing for the
client artifact; do not trust it to validate unpublished guardian or skeleton
package code unless you add equivalent local artifact plumbing first.

### 4. Validate and start

```bash
compose_verify() {
  docker compose \
    --project-name "$VERIFY_PROJECT" \
    --project-directory "$REPO" \
    -f "$VERIFY_HOME/system/stack/core.compose.yml" \
    -f "$VERIFY_HOME/system/stack/services.compose.yml" \
    -f "$VERIFY_HOME/system/stack/portals.compose.yml" \
    -f "$VERIFY_HOME/config/stack/custom.compose.yml" \
    -f "$REPO/compose.dev.yml" \
    --env-file "$VERIFY_HOME/knowledge/env/stack.env" \
    "$@"
}

compose_verify config --quiet
compose_verify config --services
compose_verify up -d --build
compose_verify ps -a
```

Expected: `assistant` becomes healthy, `guardian` becomes healthy when the chat
profile is enabled, and the client port is published on `127.0.0.1:3840`.

### 5. Manual assertions

```bash
# Assistant OpenCode health
curl -fsS http://127.0.0.1:4820/health >/dev/null

# Static client: HEAD must return headers and no body
curl -sS -o /dev/null -D - -X HEAD http://127.0.0.1:3840/

# Static client: SPA fallback
curl -fsS http://127.0.0.1:3840/connections/new | grep '<!doctype html>'

# Static client: runtime config is no-store and points at the host-published assistant URL
curl -fsS -D - http://127.0.0.1:3840/runtime-config.json

# Guardian direct listener health
curl -fsS http://127.0.0.1:9190/health

# Allowed-origin browser preflight reaches the direct listener path.
# Expected: HTTP 204 with access-control-allow-origin: http://127.0.0.1:3840.
# A 401 without CORS headers usually means the runtime installed a stale
# published guardian package instead of the local source you expected.
curl -i -sS -X OPTIONS http://127.0.0.1:9190/oc/session \
  -H 'Origin: http://127.0.0.1:3840' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization, content-type, x-openpalm-user'
```

### 6. Edge cases to deliberately check

| Case | How to test | Expected result |
|---|---|---|
| Production collision | Run `docker compose ls` and inspect ports before start | No `openpalm-verify` command uses project `openpalm` or production ports |
| Wrong compose tree | Replace `system/stack/core.compose.yml` with `config/stack/core.compose.yml` in a dry command | Command fails because managed compose files live under `system/stack` |
| Missing secret file | Move one `portal_*_secret` aside, run `compose_verify config --quiet` or `up -d` | Compose fails before guardian starts; restore the file and rerun |
| `/tmp` bind-source trap | Put `VERIFY_HOME` under `/tmp` on a snap/private-tmp Docker host | Docker may report existing secret files as missing; move to `/var/tmp` or repo-local tmp |
| Unpublished client package | Set `OP_CLIENT_VERSION=$VERIFY_VERSION` before npm publish | Assistant logs npm 404 and skips client co-process; use `file:/stash/<tarball>.tgz` |
| Published package drift | Set `OP_GUARDIAN_NPM_VERSION` or `OP_SKELETON_VERSION` to a semver that exists on npm while local source has newer same-version commits | Stack boots from the npm artifact; behavior may differ from local source, such as stale CORS/preflight handling |
| Port already allocated | Pre-bind `3840`/`4820`/`9190` or reuse an old project | Docker fails port programming; choose new ports and rerun `compose_verify up -d` |
| Direct ingress disabled | Set `GUARDIAN_DIRECT_INGRESS=false`, recreate guardian, retry browser preflight | `/oc/*` preflight returns `404 not_found`, not `204`; current guardian code also keeps allowed-origin CORS headers on the error |

### 7. Teardown

```bash
compose_verify down --volumes --remove-orphans

# Container-created files may be root-owned. Use Docker to repair ownership
# before deleting the temporary tree.
docker run --rm -v "$VERIFY_ROOT:/cleanup" alpine sh -c "chown -R $(id -u):$(id -g) /cleanup && rm -rf /cleanup/* /cleanup/.[!.]* /cleanup/..?*"
rmdir "$VERIFY_ROOT"
```

Record all failures with: command, exit code, relevant `compose_verify ps -a`,
and the shortest useful `compose_verify logs --tail 100 <service>` excerpt.

---

## Environment Variable Precedence

Docker Compose resolves variables at two distinct stages, and mixing them up is
a common source of confusion.

### Stage 1: Compose variable substitution (`--env-file`)

`--env-file` flags supply values that Compose interpolates into the compose YAML
before creating containers. For example, `${OP_HOST_UI_PORT:-3880}` in
`core.compose.yml` is resolved at this stage.

Precedence for substitution (highest to lowest):

1. **Process environment (host shell)** — any variable already exported in your
   shell overrides everything else, including `--env-file` contents.
2. **`--env-file` flags** — `stack.env` supplies non-secret substitution values.
3. **Compose file `environment:` defaults** — inline fallback values.

### Stage 2: Container runtime environment and secret files

Service-level `environment:` entries become the container process environment.
Secret-like values must not be placed there directly; expose only a `*_FILE`
variable that points at a Compose secret mounted from `knowledge/secrets/`.

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

### LLM provider keys and system secrets (`knowledge/secrets/`)

API keys, HMAC secrets, and service auth tokens live as files under
`knowledge/secrets/` and are granted through Compose `secrets:`. `stack.env`
is non-secret. Changes require a full container recreate for services that read
the file only at startup:

```bash
chmod 700 ~/.openpalm/knowledge/secrets
install -m 600 /dev/null ~/.openpalm/knowledge/secrets/provider_openai_api_key
$EDITOR ~/.openpalm/knowledge/secrets/provider_openai_api_key

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

This archives the complete stack: compose files, file-based secrets, AKM user env
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
| `$OP_HOME/system/stack/` and `$OP_HOME/config/stack/custom.compose.yml` | Managed compose files plus user overlay |
