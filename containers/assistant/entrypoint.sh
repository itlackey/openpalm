#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"
TARGET_UID="${OP_UID:-1000}"
TARGET_GID="${OP_GID:-1000}"
IS_ROOT=$([ "$(id -u)" = "0" ] && echo 1 || echo 0)

maybe_adjust_uid_gid() {
  # Only when running as root (first entrypoint before gosu).
  if [ "$IS_ROOT" = "0" ]; then return 0; fi

  local current_uid current_gid
  current_uid="$(id -u opencode 2>/dev/null || echo 1000)"
  current_gid="$(id -g opencode 2>/dev/null || echo 1000)"

  if [ "$current_gid" != "$TARGET_GID" ]; then
    groupmod -g "$TARGET_GID" opencode 2>/dev/null || true
  fi
  if [ "$current_uid" != "$TARGET_UID" ]; then
    usermod -u "$TARGET_UID" -g "$TARGET_GID" opencode 2>/dev/null || true
  fi
}

ensure_home_layout() {
  # Create directories that may not exist on first run inside bind-mounted
  # /home/opencode (which shadows image-baked defaults).
  mkdir -p \
    /home/opencode \
    /home/opencode/.cache \
    /home/opencode/.cache/opencode \
    /home/opencode/.config/opencode \
    /home/opencode/.local/bin \
    /home/opencode/.local/state/opencode \
    /home/opencode/.local/share/opencode \
    /work \
    /opt/akm/cache \
    /opt/akm/data \
    /stash

  if [ "$IS_ROOT" = "1" ]; then
    # Chown ONLY container-private paths. NEVER chown bind-mounted host stashes
    # (/stash = OP_HOME/knowledge, and /host-stash = the user's personal ~/akm
    # when host-akm sharing is enabled) or /work (= OP_HOME/workspace). The host
    # owns those files and the container runs as OP_UID:OP_GID (the host owner)
    # via gosu, so it reads/writes them directly. Recursively chowning a bind
    # mount rewrites host file ownership on every boot — a data-ownership hazard,
    # especially for /host-stash. Container-private cache/data are safe to chown.
    chown -R "$TARGET_UID:$TARGET_GID" /home/opencode /opt/akm/cache /opt/akm/data 2>/dev/null || true

    mkdir -p /var/run/sshd
  fi
}

maybe_enable_ssh() {
  if [ "$ENABLE_SSH" != "1" ] && [ "$ENABLE_SSH" != "true" ]; then
    return 0
  fi

  mkdir -p /var/run/sshd /home/opencode/.ssh
  touch /home/opencode/.ssh/authorized_keys
  chown -R "$TARGET_UID:$TARGET_GID" /home/opencode/.ssh 2>/dev/null || true
  chmod 700 /home/opencode/.ssh
  chmod 600 /home/opencode/.ssh/authorized_keys 2>/dev/null || true

  if [ "$IS_ROOT" = "1" ] && [ ! -f /etc/ssh/sshd_config ]; then
    return 0
  fi

  if [ "$IS_ROOT" = "1" ]; then
    ssh-keygen -A 2>/dev/null || true
    /usr/sbin/sshd 2>/dev/null || true
  fi
}

maybe_source_akm_user_env() {
  # Source the akm env:user file (knowledge/env/user.env) so user-managed
  # values land in the process environment. Must run before start_cron so
  # the keys appear in the crontab preamble. Only possible as root (0600 file).
  if [ "$IS_ROOT" = "0" ]; then return 0; fi

  local env_path="${AKM_STASH_DIR:-}/env/user.env"
  if [ -z "${AKM_STASH_DIR:-}" ] || [ ! -f "$env_path" ]; then return 0; fi

  # `|| true` so a malformed line in the user-edited env file cannot abort the
  # entrypoint under `set -euo pipefail` and trap the assistant in a restart loop.
  set -a
  # shellcheck disable=SC1090
  . "$env_path" || echo "warning: failed to source $env_path (malformed line?); continuing" >&2
  set +a
}

install_runtime_artifacts() {
  # ── Exact-pinned npm artifacts ──────────────────────────────────────────────
  # UI and skeleton versions come from OP_*_VERSION env overrides, then fall
  # back to PLATFORM_VERSION (set at image build time via ARG). Hard error if
  # neither is set — no 'latest' fallback for exact-pinned components.
  local ui_version="${OP_UI_VERSION:-${PLATFORM_VERSION:-}}"
  local skeleton_version="${OP_SKELETON_VERSION:-${PLATFORM_VERSION:-}}"

  if [ -z "$ui_version" ]; then
    echo "ERROR: set OP_UI_VERSION or PLATFORM_VERSION to install @openpalm/ui" >&2
    exit 1
  fi
  if [ -z "$skeleton_version" ]; then
    echo "ERROR: set OP_SKELETON_VERSION or PLATFORM_VERSION to install @openpalm/skeleton" >&2
    exit 1
  fi

  echo "entrypoint: installing @openpalm/ui@${ui_version}..." >&2
  npm install --prefix /opt/openpalm/ui "@openpalm/ui@${ui_version}" \
    --omit=dev --prefer-offline --no-fund --no-audit 2>&1 | grep -v "^npm warn" || true

  echo "entrypoint: installing @openpalm/skeleton@${skeleton_version}..." >&2
  npm install --prefix /opt/openpalm/skeleton "@openpalm/skeleton@${skeleton_version}" \
    --omit=dev --prefer-offline --no-fund --no-audit 2>&1 | grep -v "^npm warn" || true

  # ── Range-versioned tools from tools.json (global section) ─────────────────
  # These shadow the baked image tools on PATH — same binaries, runtime-updatable.
  local tools_json="/opt/openpalm/skeleton/node_modules/@openpalm/skeleton/tools.json"
  if [ -f "$tools_json" ]; then
    local tool_pkgs
    tool_pkgs=$(node -e "
      const tools = require('${tools_json}').global || [];
      const pkgs = tools.map(t => t.package + '@' + (process.env[t.envKey] || t.default));
      process.stdout.write(pkgs.join(' '));
    " 2>/dev/null || true)

    if [ -n "$tool_pkgs" ]; then
      echo "entrypoint: installing runtime tools: ${tool_pkgs}" >&2
      mkdir -p /opt/openpalm/tools
      # Use a subshell so BUN_INSTALL override doesn't pollute the outer env.
      (export BUN_INSTALL=/opt/openpalm/tools && bun add -g $tool_pkgs) \
        || echo "warning: some runtime tool installs failed; baked tools remain available" >&2
      export PATH="/opt/openpalm/tools/bin:$PATH"
    fi
  else
    echo "entrypoint: tools.json not found — skipping runtime tool install" >&2
  fi
}

start_ui() {
  local ui_build="/opt/openpalm/ui/node_modules/@openpalm/ui/build/index.js"
  if [ ! -f "$ui_build" ]; then
    echo "entrypoint: @openpalm/ui build not found — UI co-process skipped" >&2
    return 0
  fi

  local ui_port="${OP_UI_PORT:-3000}"
  echo "entrypoint: starting UI co-process on port ${ui_port}..." >&2

  # Run the UI server as the opencode user (same uid as OpenCode) so file access
  # on bind-mounted OP_HOME volumes is consistent. The gosu drop happens in
  # start_opencode; we start the UI BEFORE that drop so we can use gosu here too.
  local ui_cmd=(
    node "$ui_build"
  )
  if [ "$IS_ROOT" = "1" ] && command -v gosu >/dev/null 2>&1; then
    ui_cmd=(gosu opencode env HOME=/home/opencode "${ui_cmd[@]}")
  fi

  OPENCODE_API_URL="http://127.0.0.1:${PORT}" \
  PORT="$ui_port" \
  ORIGIN="${OP_UI_ORIGIN:-http://localhost:${ui_port}}" \
    "${ui_cmd[@]}" &

  echo "entrypoint: UI co-process PID $! started" >&2
}

seed_default_agents_md() {
  local src="/usr/local/share/openpalm/AGENTS.md"
  local dest="${OPENCODE_CONFIG_DIR:-/etc/opencode}/AGENTS.md"
  [ -f "$src" ] && [ ! -f "$dest" ] && cp "$src" "$dest" 2>/dev/null || true
}

run_akm_schema_migration() {
  # akm auto-migrates its db/stash schema whenever it opens the database.
  # Run a deterministic db-opening command HERE — as the opencode user, with
  # output surfaced to docker logs — so the migration happens under the
  # correct uid (root-owned db files in the bind-mounted stash are the
  # chown-clobber class of bug) and a failed migration is visible instead of
  # being swallowed by the silenced `akm tasks sync` call below.
  # Idempotent (akm no-ops when the schema is current) and non-fatal: a
  # migration hiccup must never block the assistant from starting. (#474)
  if ! command -v akm >/dev/null 2>&1; then return 0; fi

  echo "entrypoint: running akm schema migration (akm health)..." >&2
  local cmd=(akm health)
  if [ "$IS_ROOT" = "1" ]; then
    cmd=(gosu opencode env HOME=/home/opencode "${cmd[@]}")
  fi
  # akm health exit codes: 0 = ok, 4 = health warn (db still opened + migrated).
  # Anything else means the db could not be opened/migrated — surface it loudly
  # but keep booting.
  local rc=0
  "${cmd[@]}" >&2 || rc=$?
  if [ "$rc" = "0" ] || [ "$rc" = "4" ]; then
    echo "entrypoint: akm schema migration check complete (exit $rc)" >&2
  else
    echo "warning: akm schema migration check failed (exit $rc); continuing startup" >&2
  fi
}

start_cron_and_sync_tasks() {
  # Build a crontab preamble with environment variables and user env keys
  # so cron jobs inherit the same secrets as the main process. Keep it in a
  # managed block so restarts update the env preamble without clobbering the
  # akm-owned task entries in the user's crontab.
  strip_managed_cron_preamble() {
    local existing="$1"
    local line=""
    local in_block=0
    while IFS= read -r line || [ -n "$line" ]; do
      if [ "$line" = "# openpalm:cron-preamble BEGIN" ]; then
        in_block=1
        continue
      fi
      if [ "$line" = "# openpalm:cron-preamble END" ]; then
        in_block=0
        continue
      fi
      if [ "$in_block" = "0" ]; then
        printf '%s\n' "$line"
      fi
    done <<< "$existing"
  }

  local crontab_file="/tmp/crontab"
  local existing_crontab=""
  local preserved_crontab=""
  echo "# openpalm:cron-preamble BEGIN" > "$crontab_file"
  echo "# Auto-generated by entrypoint — do not edit" >> "$crontab_file"
  echo "SHELL=/bin/bash" >> "$crontab_file"
  echo "PATH=/opt/persistent/bin:/home/opencode/.local/bin:/home/opencode/.bun/bin:/usr/local/bin:/usr/bin:/bin" >> "$crontab_file"

  # Forward selected env vars into cron jobs
  for var in HOME AKM_STASH_DIR AKM_CONFIG_DIR AKM_CACHE_DIR AKM_DATA_DIR \
             OPENCODE_API_URL OPENCODE_CONFIG_DIR; do
    if [ -n "${!var:-}" ]; then
      echo "export $var=\"${!var}\"" >> "$crontab_file"
    fi
  done
  echo "# openpalm:cron-preamble END" >> "$crontab_file"

  if existing_crontab="$(crontab -l 2>/dev/null)"; then
    preserved_crontab="$(strip_managed_cron_preamble "$existing_crontab")"
    if [ -n "$preserved_crontab" ]; then
      printf '\n%s\n' "$preserved_crontab" >> "$crontab_file"
    fi
  fi

  # Install the managed preamble before syncing so akm preserves it when it
  # writes task blocks into the same per-user crontab.
  crontab "$crontab_file" 2>/dev/null || true

  # Sync automation tasks from the akm stash into cron, then start cron.
  local tasks_dir="${AKM_STASH_DIR:-/stash}/tasks"
  if command -v akm >/dev/null 2>&1 && [ -d "$tasks_dir" ]; then
    if ! akm tasks sync >&2; then
      echo "warning: initial akm tasks sync failed; continuing startup" >&2
    fi
  fi

  if [ -f "$crontab_file" ]; then
    rm -f "$crontab_file"
    cron 2>/dev/null || true
  fi

  # Background re-sync loop: picks up task file changes without restart
  (
    while true; do
      sleep 60
      if command -v akm >/dev/null 2>&1 && [ -d "$tasks_dir" ]; then
        if ! akm tasks sync >&2; then
          echo "warning: background akm tasks sync failed; retrying in 60s" >&2
        fi
      fi
    done
  ) &
}

start_opencode() {
  cd /work

  # Ensure bun's user-writable directories exist (set via Dockerfile ENV).
  mkdir -p "${BUN_INSTALL:-/home/opencode/.bun}/bin" \
           "${BUN_INSTALL_CACHE_DIR:-/home/opencode/.cache/bun/install}"

  # Fix ownership of bun dirs if we're still root (before gosu).
  if [ "$IS_ROOT" = "1" ]; then
    chown -R "$TARGET_UID:$TARGET_GID" \
      "${BUN_INSTALL:-/home/opencode/.bun}" \
      "${BUN_INSTALL_CACHE_DIR:-/home/opencode/.cache/bun}" \
      2>/dev/null || true
  fi

  # --print-logs sends OpenCode's logs to stderr (docker logs) instead of a file;
  # --log-level sets verbosity (override via OPENCODE_LOG_LEVEL).
  local cmd=(opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs --log-level "${OPENCODE_LOG_LEVEL:-INFO}")
  if [ "$IS_ROOT" = "1" ]; then
    if ! command -v gosu >/dev/null 2>&1; then
      echo "ERROR: gosu not found — cannot drop privileges. Install gosu in the Dockerfile." >&2
      exit 1
    fi
    export HOME=/home/opencode
    cmd=(gosu opencode env HOME=/home/opencode "${cmd[@]}")
  fi

  exec "${cmd[@]}"
}

maybe_adjust_uid_gid
ensure_home_layout
maybe_enable_ssh
maybe_source_akm_user_env
install_runtime_artifacts
seed_default_agents_md
run_akm_schema_migration
start_cron_and_sync_tasks
start_ui
start_opencode
