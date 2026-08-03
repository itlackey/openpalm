# shellcheck shell=bash
# Shared fixture seeding for the rootless smoke scripts.
#
# This is a SOURCED helper, not an executable. The rootless ownership,
# host-swap, and Debian cron behavior smoke scripts source it so the seed recipe
# (skeleton copy, secret files, stack.env skeleton, ensureHomeDirs,
# version-override compose) lives in ONE place and cannot drift between them.
#
# Every function assumes the caller has already `cd`'d to the repo root (so the
# `packages/skeleton`, `package.json`, and `packages/lib` relative paths
# resolve) and passes the isolated OP_HOME as the first argument. The shared
# path helpers enforce repo-root cleanup safety; callers own their boot/assert flow.

# Canonicalize a scratch home and constrain it to one guarded repo-root child.
# A suffix remains available for isolated concurrent runs while preserving each
# smoke's existing default basename.
# Usage: smoke_guarded_home <repo-root> <requested-home> <guarded-basename> <env-name>
smoke_guarded_home() {
  local root requested guarded_basename env_name home home_basename
  root="$(realpath -m -- "$1")" || return 1
  requested="$2"
  guarded_basename="$3"
  env_name="$4"

  if [[ -z "$requested" ]]; then
    echo "${env_name} must not be empty." >&2
    return 1
  fi
  if ! home="$(realpath -m -- "$requested")"; then
    echo "Could not canonicalize ${env_name}: $requested" >&2
    return 1
  fi
  home_basename="$(basename -- "$home")"
  if [[ "$(dirname -- "$home")" != "$root" ]]; then
    echo "${env_name} must be a direct child of the repository root: $home" >&2
    return 1
  fi
  case "$home_basename" in
    "$guarded_basename" | "$guarded_basename"-*) ;;
    *)
      echo "${env_name} must use the guarded ${guarded_basename} basename: $home" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$home"
}

# Create a guarded fixture root only when no path, including a broken symlink,
# already occupies it. The caller may mark the path as owned after this returns.
# Usage: smoke_create_guarded_home <repo-root> <home> <guarded-basename> <env-name>
smoke_create_guarded_home() {
  local root="$1"
  local home="$2"
  local guarded_basename="$3"
  local env_name="$4"
  local canonical
  canonical="$(smoke_guarded_home "$root" "$home" "$guarded_basename" "$env_name")" || return 1
  if [[ "$canonical" != "$home" ]]; then
    echo "Refusing non-canonical ${env_name}: $home" >&2
    return 1
  fi
  if [[ -e "$home" || -L "$home" ]]; then
    echo "Refusing to replace an existing smoke path: $home" >&2
    return 1
  fi
  mkdir -- "$home"
}

# Compose cleanup is label-scoped, so project names must remain inside a
# script-specific prefix even when supplied through COMPOSE_PROJECT_NAME.
# Usage: smoke_guarded_project <requested-project> <guarded-prefix> <env-name>
smoke_guarded_project() {
  local requested="$1"
  local guarded_prefix="$2"
  local env_name="$3"
  if [[ ! "$requested" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    echo "${env_name} is not a valid lowercase Compose project name: $requested" >&2
    return 1
  fi
  if [[ "$requested" != "$guarded_prefix" && "$requested" != "$guarded_prefix"-* ]]; then
    echo "${env_name} must use the guarded ${guarded_prefix} prefix: $requested" >&2
    return 1
  fi
  printf '%s\n' "$requested"
}

# Refuse to adopt or reset any container, network, or volume from an earlier
# invocation. Callers recheck immediately before their first creating command.
# Usage: smoke_assert_project_absent <project>
smoke_assert_project_absent() {
  local project="$1"
  local containers networks volumes
  containers="$(timeout 5s docker ps -aq --filter "label=com.docker.compose.project=$project")" || {
    echo "Could not check containers for smoke project $project" >&2
    return 1
  }
  networks="$(timeout 5s docker network ls -q --filter "label=com.docker.compose.project=$project")" || {
    echo "Could not check networks for smoke project $project" >&2
    return 1
  }
  volumes="$(timeout 5s docker volume ls -q --filter "label=com.docker.compose.project=$project")" || {
    echo "Could not check volumes for smoke project $project" >&2
    return 1
  }
  if [[ -n "$containers" || -n "$networks" || -n "$volumes" ]]; then
    echo "Refusing to reset pre-existing Docker resources for smoke project $project" >&2
    [[ -z "$containers" ]] || printf '  containers: %s\n' "${containers//$'\n'/ }" >&2
    [[ -z "$networks" ]] || printf '  networks: %s\n' "${networks//$'\n'/ }" >&2
    [[ -z "$volumes" ]] || printf '  volumes: %s\n' "${volumes//$'\n'/ }" >&2
    return 1
  fi
}

# Remove only resources carrying the exact Compose project label. Every Docker
# operation is bounded so daemon uncertainty cannot hang cleanup indefinitely.
# Usage: smoke_remove_project_resources <project>
smoke_remove_project_resources() {
  local project="$1"
  local output
  local -a resources=()
  local failed=0

  if output="$(timeout 5s docker ps -aq --filter "label=com.docker.compose.project=$project")"; then
    if [[ -n "$output" ]]; then
      mapfile -t resources <<<"$output"
      timeout 20s docker rm -f "${resources[@]}" >/dev/null || failed=1
    fi
  else
    echo "cleanup: could not list containers for project $project" >&2
    failed=1
  fi

  resources=()
  if output="$(timeout 5s docker network ls -q --filter "label=com.docker.compose.project=$project")"; then
    if [[ -n "$output" ]]; then
      mapfile -t resources <<<"$output"
      timeout 20s docker network rm "${resources[@]}" >/dev/null || failed=1
    fi
  else
    echo "cleanup: could not list networks for project $project" >&2
    failed=1
  fi

  resources=()
  if output="$(timeout 5s docker volume ls -q --filter "label=com.docker.compose.project=$project")"; then
    if [[ -n "$output" ]]; then
      mapfile -t resources <<<"$output"
      timeout 20s docker volume rm "${resources[@]}" >/dev/null || failed=1
    fi
  else
    echo "cleanup: could not list volumes for project $project" >&2
    failed=1
  fi

  return "$failed"
}

# Prove that no label-scoped resource remains before a fixture tree is removed.
# Usage: smoke_verify_project_clear <project>
smoke_verify_project_clear() {
  local project="$1"
  local containers networks volumes
  containers="$(timeout 5s docker ps -aq --filter "label=com.docker.compose.project=$project")" || {
    echo "cleanup: could not verify containers for project $project" >&2
    return 1
  }
  networks="$(timeout 5s docker network ls -q --filter "label=com.docker.compose.project=$project")" || {
    echo "cleanup: could not verify networks for project $project" >&2
    return 1
  }
  volumes="$(timeout 5s docker volume ls -q --filter "label=com.docker.compose.project=$project")" || {
    echo "cleanup: could not verify volumes for project $project" >&2
    return 1
  }
  if [[ -n "$containers" || -n "$networks" || -n "$volumes" ]]; then
    echo "cleanup: project $project still owns Docker resources" >&2
    [[ -z "$containers" ]] || printf '  containers: %s\n' "${containers//$'\n'/ }" >&2
    [[ -z "$networks" ]] || printf '  networks: %s\n' "${networks//$'\n'/ }" >&2
    [[ -z "$volumes" ]] || printf '  volumes: %s\n' "${volumes//$'\n'/ }" >&2
    return 1
  fi
}

# Revalidate the canonical path immediately before mounting its parent and
# removing the guarded child. This is used only after project verification.
# Usage: smoke_remove_guarded_home <repo-root> <home> <guarded-basename>
smoke_remove_guarded_home() {
  local root="$1"
  local home="$2"
  local guarded_basename="$3"
  local canonical output
  root="$(realpath -m -- "$root")" || return 1
  canonical="$(smoke_guarded_home "$root" "$home" "$guarded_basename" 'smoke cleanup path')" || return 1
  if [[ "$canonical" != "$home" ]]; then
    echo "cleanup: smoke path changed after canonicalization: $home -> $canonical" >&2
    return 1
  fi
  if [[ ! -e "$home" && ! -L "$home" ]]; then return 0; fi
  if ! output="$(timeout 30s docker run --rm -v "$root:/smoke-parent" alpine \
    sh -c 'rm -rf -- "/smoke-parent/$1"' _ "$(basename -- "$home")" 2>&1)"; then
    echo "cleanup: could not remove guarded scratch tree $home" >&2
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    return 1
  fi
  if [[ -e "$home" || -L "$home" ]]; then
    echo "cleanup: guarded scratch tree still exists: $home" >&2
    return 1
  fi
}

# Resolve the platform version once (package.json version).
smoke_platform_version() {
  node -p "require('./package.json').version"
}

# Copy the shipped skeleton into the isolated OP_HOME.
# Usage: smoke_copy_skeleton <home>
smoke_copy_skeleton() {
  local home="$1"
  mkdir -p "$home"
  cp -r packages/skeleton/. "$home/"
}

# Seed the full secrets tree and user env backing file with correct modes.
# Includes discord_bot_token unconditionally so the two scripts stay identical
# (host-swap previously omitted it and drifted).
#
# Everything below except auth.json is a delegated service secret. It is never
# exposed through the Assistant stash and lives under private/secrets/, not
# knowledge/secrets/ (which is
# bind-mounted wholesale into the assistant at /stash). auth.json stays under
# knowledge/secrets/ — it is shared with the assistant's own OpenCode process.
# Usage: smoke_seed_secrets <home> [ui_login_password]
smoke_seed_secrets() {
  local home="$1"
  local ui_password="${2:-rootless-smoke-password}"
  mkdir -p "$home/knowledge/secrets" "$home/knowledge/env" "$home/private/secrets"

  printf '%s\n' "$ui_password" > "$home/private/secrets/op_ui_login_password"
  printf '%s\n' '{}' > "$home/knowledge/secrets/auth.json"
  openssl rand -hex 16 > "$home/private/secrets/op_guardian_admin_token"
  openssl rand -hex 16 > "$home/private/secrets/op_guardian_mcp_token"
  openssl rand -hex 16 > "$home/private/secrets/portal_chat_secret"
  openssl rand -hex 16 > "$home/private/secrets/portal_api_secret"
  # op_api_key: the OpenAI-compat edge key (S.1b). Seeded on real installs by
  # ensureSecrets(); the guardian container bind-mounts it, so the fixture must
  # provide it too or the container fails to start.
  openssl rand -hex 16 > "$home/private/secrets/op_api_key"
  openssl rand -hex 16 > "$home/private/secrets/portal_discord_secret"
  openssl rand -hex 16 > "$home/private/secrets/portal_slack_secret"
  # op_opencode_password: always materialized by performSetup since #563 — the
  # compose files grant it as a file-backed secret to assistant+guardian, so
  # boot fails if it is absent. Empty file = OPENCODE_AUTH off (smoke posture).
  : > "$home/private/secrets/op_opencode_password"
  printf '%s\n' 'discord-smoke-token' > "$home/private/secrets/discord_bot_token"

  touch "$home/knowledge/env/user.env"
  chmod 700 "$home/knowledge/secrets" "$home/private/secrets"
  chmod 600 "$home/knowledge/secrets/"* "$home/private/secrets/"* "$home/knowledge/env/user.env"
}

# Write the common stack.env block (non-secret compose config) to the isolated
# OP_HOME and set 0600. Callers append any script-specific keys (e.g.
# OP_HOST_UI_PORT, OP_ENABLED_ADDONS) after this returns.
# Usage: smoke_write_stack_env <home> <platform_version> \
#          <assistant_port> <ui_port> <guardian_port> <guardian_admin_port> \
#          <chat_port> <api_port> [runtime_uid] [runtime_gid]
smoke_write_stack_env() {
  local home="$1"
  local platform_version="$2"
  local assistant_port="$3"
  local ui_port="$4"
  local guardian_port="$5"
  local guardian_admin_port="$6"
  local chat_port="$7"
  local api_port="$8"
  local runtime_uid="${9:-$(id -u)}"
  local runtime_gid="${10:-$(id -g)}"

  mkdir -p "$home/state"
  cat >"$home/state/stack.env" <<EOF
OP_HOME=${home}
OP_UID=${runtime_uid}
OP_GID=${runtime_gid}
OP_IMAGE_NAMESPACE=openpalm
OP_ASSISTANT_VERSION=dev
OP_GUARDIAN_VERSION=dev
OP_PORTAL_VERSION=dev
OP_ASSISTANT_PORT=${assistant_port}
OP_UI_PORT=${ui_port}
OP_GUARDIAN_PORT=${guardian_port}
OP_GUARDIAN_ADMIN_PORT=${guardian_admin_port}
OP_CHAT_PORT=${chat_port}
OP_API_PORT=${api_port}
EOF
  printf 'OP_SETUP_COMPLETE=true\n' >> "$home/state/stack.env"
  chmod 600 "$home/state/stack.env"

  # This fixture builds a home already in the CURRENT layout, so record that.
  # Without the stamp every command would re-attempt the one-shot migration —
  # harmless on a writable home, but these smokes deliberately chown the tree to
  # another uid, and a write attempt there is not what they are testing.
  printf '%s\n' "$(smoke_home_schema_version)" > "$home/state/schema-version"
}

# The current OP_HOME layout schema version, read from the one place that
# defines it so this fixture cannot drift from the code under test.
smoke_home_schema_version() {
  bun -e "import { HOME_SCHEMA_VERSION } from './packages/lib/src/control-plane/home.ts'; console.log(HOME_SCHEMA_VERSION);"
}

# Create the runtime directory layout via the lib helper (identical in both
# scripts). Usage: smoke_ensure_home_dirs <home>
smoke_ensure_home_dirs() {
  local home="$1"
  OP_HOME="$home" bun -e "import { ensureHomeDirs } from './packages/lib/src/index.ts'; ensureHomeDirs();"
}


# Build the dev-tagged images (openpalm/{assistant,guardian,portal}:dev) the smoke
# stacks boot. Honors OP_ROOTLESS_SMOKE_SKIP_BUILD=1 to reuse already-built images
# — CI builds all three ONCE up front (see .github/workflows/ci.yml) and runs the
# three smoke scripts with the flag set, instead of each script rebuilding.
#
# Standalone runs (no flag) build here as before. Image tags come from
# compose.dev.yml (hardcoded `:dev`), so a single build serves every smoke target.
# Usage: smoke_build_images <targets...>   e.g. smoke_build_images assistant guardian [portal]
# `portal` is the shared image name; compose.dev.yml attaches its build to the
# real profiled adapter services, so map that convenience target to `discord`.
smoke_build_images() {
  if [ "${OP_ROOTLESS_SMOKE_SKIP_BUILD:-0}" = "1" ]; then
    echo "Reusing prebuilt openpalm/*:dev images (OP_ROOTLESS_SMOKE_SKIP_BUILD=1)." >&2
    return 0
  fi
  echo "Building UI..." >&2
  bun run ui:build >/dev/null
  # Bake the repo's exact Guardian version for runtime introspection.
  GUARDIAN_VERSION="$(node -p "require('./packages/guardian/package.json').version")"
  PLATFORM_VERSION="$(smoke_platform_version)"
  OP_ASSISTANT_VERSION=dev
  OP_GUARDIAN_VERSION=dev
  OP_PORTAL_VERSION=dev
  export GUARDIAN_VERSION
  export PLATFORM_VERSION
  export OP_ASSISTANT_VERSION OP_GUARDIAN_VERSION OP_PORTAL_VERSION
  local targets=()
  local target
  for target in "$@"; do
    if [ "$target" = "portal" ]; then
      targets+=(discord)
    else
      targets+=("$target")
    fi
  done
  echo "Building images: ${targets[*]} (PLATFORM_VERSION=${PLATFORM_VERSION}, GUARDIAN_VERSION=${GUARDIAN_VERSION}) ..." >&2
  # --profile addon.chat makes the profiled guardian visible; addon.discord makes
  # the portal build target visible. compose.dev.yml supplies the build contexts.
  docker compose --project-directory . \
    -f packages/skeleton/system/stack/core.compose.yml \
    -f packages/skeleton/system/stack/portals.compose.yml \
    -f compose.dev.yml \
    --profile addon.chat --profile addon.discord \
    build "${targets[@]}" >/dev/null

}
