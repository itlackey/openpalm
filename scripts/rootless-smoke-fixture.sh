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
# Usage: smoke_seed_secrets <home> [ui_login_password]
smoke_seed_secrets() {
  local home="$1"
  local ui_password="${2:-rootless-smoke-password}"
  mkdir -p "$home/knowledge/secrets" "$home/knowledge/env"

  printf '%s\n' "$ui_password" > "$home/knowledge/secrets/op_ui_login_password"
  printf '%s\n' '{}' > "$home/knowledge/secrets/auth.json"
  openssl rand -hex 16 > "$home/knowledge/secrets/op_guardian_admin_token"
  openssl rand -hex 16 > "$home/knowledge/secrets/op_guardian_mcp_token"
  openssl rand -hex 16 > "$home/knowledge/secrets/portal_chat_secret"
  openssl rand -hex 16 > "$home/knowledge/secrets/portal_api_secret"
  # op_api_key: the OpenAI-compat edge key (S.1b). Seeded on real installs by
  # ensureSecrets(); the guardian container bind-mounts it, so the fixture must
  # provide it too or the container fails to start.
  openssl rand -hex 16 > "$home/knowledge/secrets/op_api_key"
  openssl rand -hex 16 > "$home/knowledge/secrets/portal_discord_secret"
  openssl rand -hex 16 > "$home/knowledge/secrets/portal_slack_secret"
  # op_opencode_password: always materialized by performSetup since #563 — the
  # compose files grant it as a file-backed secret to assistant+guardian, so
  # boot fails if it is absent. Empty file = OPENCODE_AUTH off (smoke posture).
  : > "$home/knowledge/secrets/op_opencode_password"
  printf '%s\n' 'discord-smoke-token' > "$home/knowledge/secrets/discord_bot_token"

  touch "$home/knowledge/env/user.env"
  chmod 700 "$home/knowledge/secrets"
  chmod 600 "$home/knowledge/secrets/"* "$home/knowledge/env/user.env"
}

# Write the common stack.env block (non-secret compose config) to the isolated
# OP_HOME and set 0600. Callers append any script-specific keys (e.g.
# OP_HOST_UI_PORT, OP_ENABLED_ADDONS) after this returns.
# Usage: smoke_write_stack_env <home> <platform_version> \
#          <assistant_port> <guardian_port> <guardian_admin_port> \
#          <chat_port> <api_port> <client_port>
smoke_write_stack_env() {
  local home="$1"
  local platform_version="$2"
  local assistant_port="$3"
  local guardian_port="$4"
  local guardian_admin_port="$5"
  local chat_port="$6"
  local api_port="$7"
  local client_port="$8"

  cat >"$home/knowledge/env/stack.env" <<EOF
OP_HOME=${home}
OP_UID=$(id -u)
OP_GID=$(id -g)
OP_IMAGE_NAMESPACE=openpalm
OP_ASSISTANT_VERSION=dev
OP_GUARDIAN_VERSION=dev
OP_PORTAL_VERSION=dev
OP_GUARDIAN_NPM_VERSION=${platform_version}
OP_CLIENT_VERSION=${platform_version}
OP_SKELETON_VERSION=${platform_version}
OP_ASSISTANT_PORT=${assistant_port}
OP_GUARDIAN_PORT=${guardian_port}
OP_GUARDIAN_ADMIN_PORT=${guardian_admin_port}
OP_CHAT_PORT=${chat_port}
OP_API_PORT=${api_port}
OP_CLIENT_PORT=${client_port}
OP_SETUP_COMPLETE=true
EOF
  chmod 600 "$home/knowledge/env/stack.env"
}

# Create the runtime directory layout via the lib helper (identical in both
# scripts). Usage: smoke_ensure_home_dirs <home>
smoke_ensure_home_dirs() {
  local home="$1"
  OP_HOME="$home" bun -e "import { ensureHomeDirs } from './packages/lib/src/index.ts'; ensureHomeDirs();"
}

# Write the version-pinning compose override both stacks use to force the
# dev-built client/skeleton/guardian versions. The caller chooses the file path
# (the two scripts intentionally place it differently), so this single-sources
# only the content. Usage: smoke_write_version_override <file> <platform_version>
smoke_write_version_override() {
  local file="$1"
  local platform_version="$2"
  cat >"$file" <<EOF
services:
  assistant:
    environment:
      OP_CLIENT_VERSION: "${platform_version}"
      OP_SKELETON_VERSION: "${platform_version}"
  guardian:
    environment:
      OP_GUARDIAN_NPM_VERSION: "${platform_version}"
EOF
}

# Build the dev-tagged images (openpalm/{assistant,guardian,portal}:dev) the smoke
# stacks boot. Honors OP_ROOTLESS_SMOKE_SKIP_BUILD=1 to reuse already-built images
# — CI builds all three ONCE up front (see .github/workflows/ci.yml) and runs the
# three smoke scripts with the flag set, instead of each script rebuilding.
#
# Standalone runs (no flag) build here as before. Image tags come from
# compose.dev.yml (hardcoded `:dev`), so a single build serves every smoke target.
# Usage: smoke_build_images <targets...>   e.g. smoke_build_images assistant guardian [portal]
smoke_build_images() {
  if [ "${OP_ROOTLESS_SMOKE_SKIP_BUILD:-0}" = "1" ]; then
    echo "Reusing prebuilt openpalm/*:dev images (OP_ROOTLESS_SMOKE_SKIP_BUILD=1)." >&2
    return 0
  fi
  echo "Building UI..." >&2
  bun run ui:build >/dev/null
  # The guardian Dockerfile bakes @openpalm/guardian@${GUARDIAN_VERSION} at
  # build time and fails if it is unset (see compose.dev.yml guardian args).
  # Bake the repo's exact version so the smoke image matches the source tree.
  GUARDIAN_VERSION="$(node -p "require('./packages/guardian/package.json').version")"
  GUARDIAN_USE_LOCAL_SOURCE=true
  SKELETON_USE_LOCAL_SOURCE=true
  export GUARDIAN_VERSION
  export GUARDIAN_USE_LOCAL_SOURCE
  export SKELETON_USE_LOCAL_SOURCE
  echo "Building images: $* (GUARDIAN_VERSION=${GUARDIAN_VERSION}) ..." >&2
  # --profile addon.chat makes the profiled guardian visible; addon.discord makes
  # the portal build target visible. compose.dev.yml supplies the build contexts.
  docker compose --project-directory . \
    -f packages/skeleton/system/stack/core.compose.yml \
    -f packages/skeleton/system/stack/portals.compose.yml \
    -f compose.dev.yml \
    --profile addon.chat --profile addon.discord \
    build "$@" >/dev/null
}
