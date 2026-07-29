# shellcheck shell=bash
# Shared fixture seeding for the rootless smoke scripts.
#
# This is a SOURCED helper, not an executable — both
# scripts/rootless-ownership-smoke.sh and scripts/rootless-host-swap-smoke.sh
# source it so the seed recipe (skeleton copy, secret files, stack.env skeleton,
# ensureHomeDirs, version-override compose) lives in ONE place and cannot drift
# between the two scripts.
#
# Every function assumes the caller has already `cd`'d to the repo root (so the
# `packages/skeleton`, `package.json`, and `packages/lib` relative paths
# resolve) and passes the isolated OP_HOME as the first argument. The caller
# owns the repo-root safety guard on that path and its own boot/assert flow.

# Resolve the platform version once (package.json version).
smoke_platform_version() {
  node -p "require('./package.json').version"
}

# Seed an isolated OP_HOME with the skeleton from a published host-assets
# release. Pre-host-assets releases fall back to their immutable npm skeleton.
#
# This keeps historical fixtures release-backed without a checked-in snapshot.
#
# Note the layouts genuinely differ across eras — 0.12.x ships manifest.json
# and no system/; 0.13.x ships system/ and no manifest.json. That difference is
# the point: it is what a migration has to cope with. Assert per-era, not
# against one generic "old home" shape.
#
# Usage: smoke_copy_release_skeleton <home> <version>
smoke_copy_release_skeleton() {
  local home="$1"
  local version="$2"
  local workdir
  workdir="$(mktemp -d)"

  local asset="openpalm-host-assets-${version}.tar.gz"
  local release_url="https://github.com/itlackey/openpalm/releases/download/${version}"
  if curl -fsL "${release_url}/${asset}" -o "${workdir}/${asset}" \
    && curl -fsL "${release_url}/checksums-sha256.txt" -o "${workdir}/checksums-sha256.txt"; then
    local expected actual
    expected="$(grep -E "[[:space:]]${asset}$" "${workdir}/checksums-sha256.txt" | awk '{print $1}')"
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "${workdir}/${asset}" | awk '{print $1}')"
    else
      actual="$(shasum -a 256 "${workdir}/${asset}" | awk '{print $1}')"
    fi
    if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
      rm -rf "$workdir"
      echo "Host-assets checksum failed for OpenPalm ${version}." >&2
      return 1
    fi
    mkdir -p "$home"
    tar xzf "${workdir}/${asset}" -C "$home" --strip-components=1 skeleton
    rm -rf "$workdir"
    return 0
  fi

  # 0.12 and earlier did not publish host-assets archives.
  rm -f "${workdir}/${asset}" "${workdir}/checksums-sha256.txt"
  if ! ( cd "$workdir" && npm pack "@openpalm/skeleton@${version}" >/dev/null 2>&1 ); then
    rm -rf "$workdir"
    echo "Could not fetch release skeleton for ${version} (offline, or version unpublished)." >&2
    return 1
  fi
  mkdir -p "$home"
  # npm wraps everything under package/; strip it so the tree lands at the
  # home root exactly as smoke_copy_skeleton lays out the working-tree copy.
  tar xzf "$workdir"/*.tgz -C "$home" --strip-components=1
  rm -rf "$workdir"
}

# Make a skeleton-seeded home look like an INSTALL of that era, not a fresh
# unpack. This matters more than it sounds: the migration gate treats a home
# with no stack env file in any known location as an ABSENT install and stamps
# it current without running anything (home.ts initHomeSchema /
# home-schema.ts runHomeMigrations). Seeding only the skeleton therefore
# produces a home that reports "migrated" while no migration ever ran.
#
# Writes the pre-split legacy artifacts a real 0.12.x install had:
#   knowledge/env/stack.env  — the stack env before it moved to state/
#   knowledge/secrets/*      — delegated secrets before §G1 moved them to private/
# and removes any schema-version record, so the home reads as version 0.
#
# Usage: smoke_seed_legacy_install_state <home>
smoke_seed_legacy_install_state() {
  local home="$1"

  rm -f "${home}/state/schema-version"

  mkdir -p "${home}/knowledge/env"
  cat >"${home}/knowledge/env/stack.env" <<'EOF'
OP_PROJECT_NAME=upgrade-smoke
OP_SETUP_COMPLETE=true
OP_UI_PORT=3800
OP_ASSISTANT_PORT=3801
EOF

  # Delegated secrets in their pre-§G1 home. The migration must relocate these
  # into private/secrets and remove the originals from the assistant-reachable
  # knowledge tree.
  mkdir -p "${home}/knowledge/secrets"
  chmod 700 "${home}/knowledge/secrets"
  for name in op_guardian_admin_token op_api_key discord_bot_token op_ui_login_password; do
    printf 'legacy-%s-value\n' "$name" >"${home}/knowledge/secrets/${name}"
    chmod 600 "${home}/knowledge/secrets/${name}"
  done
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
#          <chat_port> <api_port>
smoke_write_stack_env() {
  local home="$1"
  local platform_version="$2"
  local assistant_port="$3"
  local ui_port="$4"
  local guardian_port="$5"
  local guardian_admin_port="$6"
  local chat_port="$7"
  local api_port="$8"

  mkdir -p "$home/state"
  cat >"$home/state/stack.env" <<EOF
OP_HOME=${home}
OP_UID=$(id -u)
OP_GID=$(id -g)
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
  export GUARDIAN_VERSION
  export PLATFORM_VERSION
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
