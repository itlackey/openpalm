#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"

maybe_prepare_nss_wrapper() {
  if getent passwd "$(id -u)" >/dev/null 2>&1; then return 0; fi

  # libnss-wrapper installs to the fixed Debian multiarch dir
  # (/usr/lib/<triple>/libnss_wrapper.so). Glob those known locations instead of
  # an unbounded recursive `find` over the whole library tree on every boot; the
  # bare /usr/lib and /lib paths remain as a fallback if the layout differs.
  local nss_wrapper_lib="" candidate
  for candidate in /usr/lib/*/libnss_wrapper.so /lib/*/libnss_wrapper.so \
                   /usr/lib/libnss_wrapper.so /lib/libnss_wrapper.so; do
    if [ -e "$candidate" ]; then nss_wrapper_lib="$candidate"; break; fi
  done
  if [ -z "$nss_wrapper_lib" ]; then
    echo "warning: current uid has no passwd entry and libnss_wrapper is unavailable; continuing" >&2
    return 0
  fi

  local passwd_file group_file
  passwd_file="/tmp/openpalm-passwd"
  group_file="/tmp/openpalm-group"
  printf 'opencode:x:%s:%s:OpenPalm Assistant:%s:/bin/bash\n' "$(id -u)" "$(id -g)" "/home/opencode" > "$passwd_file"
  printf 'opencode:x:%s:\n' "$(id -g)" > "$group_file"
  export NSS_WRAPPER_PASSWD="$passwd_file"
  export NSS_WRAPPER_GROUP="$group_file"
  export LD_PRELOAD="$nss_wrapper_lib${LD_PRELOAD:+:$LD_PRELOAD}"
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

}

maybe_source_akm_user_env() {
  # Source the akm env:user file (knowledge/env/user.env) so user-managed
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
  # Client and skeleton versions come from OP_*_VERSION env overrides, then
  # fall back to PLATFORM_VERSION (set at image build time via ARG). Hard error
  # if neither is set — no 'latest' fallback for exact-pinned components.
  local client_version="${OP_CLIENT_VERSION:-${PLATFORM_VERSION:-}}"
  local skeleton_version="${OP_SKELETON_VERSION:-${PLATFORM_VERSION:-}}"

  if [ -z "$client_version" ]; then
    echo "ERROR: set OP_CLIENT_VERSION or PLATFORM_VERSION to install @openpalm/client" >&2
    exit 1
  fi
  if [ -z "$skeleton_version" ]; then
    echo "ERROR: set OP_SKELETON_VERSION or PLATFORM_VERSION to install @openpalm/skeleton" >&2
    exit 1
  fi

  # Cache under the persistent bind-mounted HOME (/home/opencode is
  # OP_HOME/data/assistant) so warm restarts reuse downloaded packages and
  # --prefer-offline actually hits a cache instead of re-fetching from the
  # registry. The bun path matches the Dockerfile's BUN_INSTALL_CACHE_DIR ENV.
  local npm_cache_dir="/home/opencode/.cache/openpalm-npm"
  local bun_cache_dir="/home/opencode/.cache/bun/install"

  # Existing assistant-artifacts named volumes shadow Dockerfile-created paths.
  # Older images only created /opt/openpalm/{ui,skeleton}; create the current
  # prefixes here so upgrades can install @openpalm/client as the node user.
  mkdir -p /opt/openpalm/client /opt/openpalm/skeleton

  # `grep -v` exits 1 when npm produced only warnings (or nothing), so the
  # pipeline's own exit code can't distinguish "npm failed" from "no output".
  # Capture npm's exit via PIPESTATUS and surface real failures — a silent
  # EACCES here would leave the stack serving stale client/skeleton forever.
  local npm_rc
  echo "entrypoint: installing @openpalm/client@${client_version}..." >&2
  npm_rc=0
  npm_config_cache="$npm_cache_dir" npm install --prefix /opt/openpalm/client "@openpalm/client@${client_version}" \
    --omit=dev --prefer-offline --no-fund --no-audit 2>&1 | grep -v "^npm warn" || npm_rc="${PIPESTATUS[0]}"
  if [ "$npm_rc" != "0" ]; then
    echo "ERROR: @openpalm/client@${client_version} install failed (exit ${npm_rc}); continuing with the existing artifact if present" >&2
  fi

  echo "entrypoint: installing @openpalm/skeleton@${skeleton_version}..." >&2
  npm_rc=0
  npm_config_cache="$npm_cache_dir" npm install --prefix /opt/openpalm/skeleton "@openpalm/skeleton@${skeleton_version}" \
    --omit=dev --prefer-offline --no-fund --no-audit 2>&1 | grep -v "^npm warn" || npm_rc="${PIPESTATUS[0]}"
  if [ "$npm_rc" != "0" ]; then
    echo "ERROR: @openpalm/skeleton@${skeleton_version} install failed (exit ${npm_rc}); continuing with the existing artifact if present" >&2
  fi

  # ── Range-versioned tools via bun update ────────────────────────────────────
  # /opt/openpalm/tools/package.json declares tool semver ranges (baked as
  # image defaults; bind-mounted from OP_HOME/data/assistant/tools in compose).
  # bun update installs missing packages and advances within declared ranges.
  # npm is used for the claude-code install hook (requires node, present in base).
  local tools_dir="/opt/openpalm/tools"
  if [ -f "${tools_dir}/package.json" ]; then
    echo "entrypoint: updating tools in ${tools_dir}..." >&2
    BUN_INSTALL_CACHE_DIR="$bun_cache_dir" bun update --cwd "${tools_dir}" --production \
      || echo "warning: tool update had errors; check logs above" >&2
    # @anthropic-ai/claude-code ships a node install script that must be run
    # after install/update to set up the native binary.
    local claude_install="${tools_dir}/node_modules/@anthropic-ai/claude-code/install.cjs"
    if [ -f "$claude_install" ]; then
      node "$claude_install" 2>/dev/null || true
    fi
  fi
}

# ── LAN-exposure helpers ─────────────────────────────────────────────────────
# Shared by start_client (I3 safety gate, below) and start_opencode (I3
# explicit-origin CORS, further down).
is_loopback_address() {
  case "$1" in
    127.0.0.1|localhost) return 0 ;;
    *) return 1 ;;
  esac
}

opencode_auth_enabled() {
  case "${OPENCODE_AUTH:-false}" in
    true|TRUE|True|1|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# I3 residual (review, SECURITY): validate an OP_CLIENT_CORS_ALLOWED_ORIGINS
# entry before start_opencode ever appends it to cors_origins — operator input
# is otherwise appended to OpenCode's --cors verbatim, so
# OP_CLIENT_CORS_ALLOWED_ORIGINS=* would silently reintroduce a wildcard CORS
# grant. Mirrors guardian's normalizeExactOrigin (packages/guardian/src/
# config.ts): never a wildcard, never anything but an EXACT http(s) origin —
# no userinfo, no path beyond an optional trailing slash, no query, no
# fragment.
is_allowed_cors_origin() {
  local origin="$1"
  [[ "$origin" =~ ^https?://[^/@?#[:space:]]+/?$ ]]
}

start_client() {
  # Static chat client (@openpalm/client, plan §6.9 Slice A). The co-process
  # only serves bytes — the BROWSER talks to OpenCode directly at the
  # host-published assistant URL, so there is no server-side API base URL to
  # wire into this process (the old adapter-node co-process env plumbing, and
  # its wiring bug, are gone with it).

  # ── I3: LAN-exposure safety gate ─────────────────────────────────────────
  # Never publish an unauthenticated chat client onto a network the assistant
  # itself made reachable. When OpenCode is bound off loopback
  # (OP_ASSISTANT_BIND_ADDRESS / OP_BIND_ADDRESS) AND OpenCode auth is
  # disabled (OPENCODE_AUTH, default "false"), any web page a LAN visitor
  # opens could script the assistant cross-origin through this client port.
  # Warn loudly, naming the exact knobs, and refuse to start the client
  # surface — this is a deliberate degrade (the rest of the stack, including
  # OpenCode itself, keeps running), never a hard failure of the container.
  local assistant_bind_address="${OP_ASSISTANT_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}"
  rm -f /tmp/openpalm-client-skip
  if ! is_loopback_address "$assistant_bind_address" && ! opencode_auth_enabled; then
    echo "WARNING: OP_ASSISTANT_BIND_ADDRESS/OP_BIND_ADDRESS=${assistant_bind_address} exposes OpenCode beyond loopback while OPENCODE_AUTH=${OPENCODE_AUTH:-false} leaves it unauthenticated." >&2
    echo "WARNING: refusing to start the unauthenticated client chat co-process on OP_CLIENT_PORT — set OPENCODE_AUTH=true (with real OpenCode credentials) before exposing this stack beyond loopback." >&2
    : > /tmp/openpalm-client-skip
    return 0
  fi

  local client_pkg="/opt/openpalm/client/node_modules/@openpalm/client"
  local serve_script="${client_pkg}/bin/serve.mjs"
  local client_build="${client_pkg}/build"
  if [ ! -f "$serve_script" ] || [ ! -f "${client_build}/index.html" ]; then
    echo "entrypoint: @openpalm/client build not found — client co-process skipped" >&2
    # F4 (review): a missing/never-installed client build is a non-fatal,
    # permanent condition for this boot — the healthcheck (Dockerfile +
    # core.compose.yml) probes OP_CLIENT_PORT UNLESS this marker exists, so
    # without it a legitimately-absent client would fail the healthcheck
    # forever, marking the assistant unhealthy and blocking every service
    # behind guardian's `depends_on: condition: service_healthy` — directly
    # contradicting the "the assistant keeps serving without it" log line
    # above. Write the marker so this skip is recognized as healthy.
    : > /tmp/openpalm-client-skip
    return 0
  fi

  # Write runtime-config.json beside the build BEFORE serving (serve.mjs looks
  # for it next to the build dir). It seeds the browser's connection store with
  # ONE locked default connection: the assistant's OpenCode as published on the
  # HOST — compose maps ${OP_ASSISTANT_PORT:-3800} -> in-container 4096, and
  # the in-container :4096 would be unreachable from a browser. Non-default
  # topologies override the full URL via OP_CLIENT_DEFAULT_ASSISTANT_URL.
  # JSON is emitted via node (present in the base image) so an unusual URL
  # value can never produce a malformed file.
  local assistant_url="${OP_CLIENT_DEFAULT_ASSISTANT_URL:-http://127.0.0.1:${OP_ASSISTANT_PORT:-3800}}"
  node -e '
    const fs = require("fs");
    const [file, url] = process.argv.slice(1);
    // E1: never let a wildcard bind host leak into a browser-facing URL — an
    // operator override may itself be derived from a bind-address setting
    // upstream. Mirrors packages/lib/src/control-plane/url-normalize.ts
    // normalizeLoopbackUrl exactly (see assistant-client-entrypoint.test.ts).
    const normalizedUrl = url.replace(/^(https?:\/\/)(0\.0\.0\.0|\[::\]|::)(?=[:/]|$)/i, "$1127.0.0.1");
    const config = {
      connections: [
        {
          // I5: literal id/label must match packages/lib/src/control-plane/
          // client-runtime-config.ts ASSISTANT_LOCKED_CONNECTION_ID / _LABEL —
          // pinned by a static test in assistant-client-entrypoint.test.ts.
          id: "openpalm-assistant-opencode",
          label: "This assistant",
          kind: "local-opencode",
          url: normalizedUrl,
          auth: { mode: "none" },
          isDefault: true,
          locked: true,
        },
      ],
    };
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  ' "${client_pkg}/runtime-config.json" "$assistant_url" \
    || echo "warning: could not write runtime-config.json; client starts with no default connection" >&2

  local client_port="${OP_CLIENT_PORT:-3000}"
  echo "entrypoint: starting client co-process on port ${client_port}..." >&2

  # ── I2: supervise + respawn with capped exponential backoff ──────────────
  # Mirrors packages/cli/src/lib/client-server.ts's host-side supervision
  # semantics: an unexpected exit respawns the co-process instead of leaving
  # the published port silently dead (the compose healthcheck now probes it —
  # see core.compose.yml), but a crash loop backs off (1s, 2s, 4s, 8s, 16s,
  # capped at 30s) and gives up after max_attempts so a persistently broken
  # client can't spin the container's CPU/log forever. Bind 0.0.0.0 INSIDE the
  # container only: host exposure is governed by the compose port mapping,
  # which defaults to loopback (OP_BIND_ADDRESS policy).
  (
    local attempt=0
    local max_attempts=5
    local delay=1
    local max_delay=30
    # SUPERVISOR-RESET (review): mirrors packages/cli/src/lib/client-server.ts's
    # HEALTHY_UPTIME_MS reset — a child that stays up for at least this long
    # before exiting resets the give-up counter, so only a PERSISTENTLY-broken
    # client (no healthy stretch between crashes) can ever exhaust
    # max_attempts. Without this, crashes spread across the container's whole
    # lifetime (e.g. one every few days) permanently disabled the client after
    # only 5 of them, total, ever — contradicting the comment's claim to
    # mirror client-server.ts, which DOES reset. Millisecond resolution (via
    # `date +%s%3N`, GNU coreutils) both matches client-server.ts's Date.now()
    # units and avoids second-granularity rounding incorrectly classifying a
    # fast crash-loop iteration as "healthy" near a wall-clock second boundary.
    # Configurable (test hook); unset uses the same 60000ms threshold as
    # client-server.ts's HEALTHY_UPTIME_MS.
    local healthy_uptime_ms="${OP_CLIENT_RESPAWN_HEALTHY_UPTIME_MS:-60000}"
    while true; do
      local start_ts
      start_ts="$(date +%s%3N)"
      local exit_code
      if node "$serve_script" --host 0.0.0.0 --port "$client_port" --dir "$client_build"; then
        exit_code=0
      else
        exit_code=$?
      fi
      local end_ts
      end_ts="$(date +%s%3N)"
      if [ "$((end_ts - start_ts))" -ge "$healthy_uptime_ms" ]; then
        attempt=0
      fi
      attempt=$((attempt + 1))
      if [ "$attempt" -ge "$max_attempts" ]; then
        echo "warning: client co-process exited $attempt times (last exit $exit_code); giving up on respawn — the assistant keeps serving without it" >&2
        # F4 (review): a permanently-dead client (attempt cap exhausted) is
        # the SAME non-fatal, boot-scoped condition as "build not found"
        # above — write the skip marker so the healthcheck (which probes
        # OP_CLIENT_PORT unless this marker exists) stops expecting a client
        # that will never come back this boot, instead of failing forever.
        : > /tmp/openpalm-client-skip
        break
      fi
      echo "warning: client co-process exited (code $exit_code) — restarting in ${delay}s (attempt $((attempt + 1))/${max_attempts})" >&2
      sleep "$delay"
      delay=$((delay * 2))
      if [ "$delay" -gt "$max_delay" ]; then delay=$max_delay; fi
    done
  ) &

  echo "entrypoint: client co-process supervisor PID $! started" >&2
}

seed_default_agents_md() {
  local src="/usr/local/share/openpalm/AGENTS.md"
  local dest="${OPENCODE_CONFIG_DIR:-/etc/opencode}/AGENTS.md"
  if [ -f "$src" ] && [ ! -f "$dest" ]; then
    cp "$src" "$dest" 2>/dev/null || true
  fi
}

run_akm_command() {
  # Keep akm invocations anchored to the assistant's persistent home rather than
  # inheriting a bootstrap-time HOME (e.g. /root) from the shell environment.
  env HOME="${HOME:-/home/opencode}" "$@"
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
  # akm health exit codes: 0 = ok, 4 = health warn (db still opened + migrated).
  # Anything else means the db could not be opened/migrated — surface it loudly
  # but keep booting.
  local rc=0
  run_akm_command akm health >&2 || rc=$?
  if [ "$rc" = "0" ] || [ "$rc" = "4" ]; then
    echo "entrypoint: akm schema migration check complete (exit $rc)" >&2
  else
    echo "warning: akm schema migration check failed (exit $rc); continuing startup" >&2
  fi
}

persist_akm_stash_dir_fallback() {
  # Defense-in-depth for scheduled tasks (#552): cron jobs normally receive
  # AKM_STASH_DIR / AKM_CONFIG_DIR / HOME from the managed crontab preamble.
  # If an external crontab rewrite drops that preamble, akm falls back to
  # $HOME/.config/akm/config.json — which never existed — so every akm-based
  # task fails with "No stash directory found" while still exiting 0.
  # Persist stashDir into the config locations akm can resolve WITHOUT the
  # forwarded env so a lost preamble degrades gracefully instead of silently
  # breaking every automation.
  if ! command -v akm >/dev/null 2>&1; then return 0; fi
  local stash_dir="${AKM_STASH_DIR:-/stash}"
  [ -d "$stash_dir" ] || return 0

  # Candidate config dirs, most specific first: the configured AKM_CONFIG_DIR,
  # the boot-time HOME default, and the passwd-home default (busybox crond
  # sets HOME from the passwd entry, which can differ from the boot-time HOME).
  local passwd_home=""
  passwd_home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)"
  local config_dir config_file
  for config_dir in "${AKM_CONFIG_DIR:-}" \
                    "${HOME:-/home/opencode}/.config/akm" \
                    "${passwd_home:+${passwd_home}/.config/akm}"; do
    [ -n "$config_dir" ] || continue
    config_file="$config_dir/config.json"
    if [ -f "$config_file" ]; then
      # Merge stashDir into an existing config without touching other keys.
      # A corrupt or already-populated file is left alone — never destroy
      # operator config from the entrypoint.
      node -e '
        const fs = require("fs");
        const [file, stashDir] = process.argv.slice(1);
        let cfg;
        try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || cfg.stashDir) process.exit(0);
        cfg.stashDir = stashDir;
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
        fs.renameSync(tmp, file);
      ' "$config_file" "$stash_dir" 2>/dev/null \
        || echo "warning: could not merge stashDir into $config_file; continuing" >&2
    else
      mkdir -p "$config_dir" 2>/dev/null || continue
      # JSON-escape backslashes and double quotes so an unusual stash path
      # cannot produce an invalid config.json (which would re-break stash
      # resolution under cron — the exact failure this fallback guards against).
      local stash_dir_json="${stash_dir//\\/\\\\}"
      stash_dir_json="${stash_dir_json//\"/\\\"}"
      printf '{\n  "stashDir": "%s"\n}\n' "$stash_dir_json" > "$config_file" 2>/dev/null \
        || echo "warning: could not write stashDir fallback to $config_file; continuing" >&2
    fi
  done
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
  local spool_dir="/tmp/openpalm-crontabs"
  local wrapper_dir="/tmp/openpalm-bin"
  local crontab_wrapper="${wrapper_dir}/crontab"
  local existing_crontab=""
  local preserved_crontab=""
  mkdir -p "$spool_dir" "$wrapper_dir"
  install -m 755 /dev/null "$crontab_wrapper"
  # NOTE: the format string is single-quoted, so `$@` must NOT be escaped —
  # bash printf passes `\$` through literally, which would bake the literal
  # string `$@` into the wrapper and break every crontab invocation.
  printf '#!/usr/bin/env sh\nexec busybox crontab -c %s "$@"\n' "$spool_dir" > "$crontab_wrapper"
  export PATH="$wrapper_dir:$PATH"
  # Derive the cron PATH from the boot-time PATH (wrapper dir already first,
  # exported above) so scheduled tasks see the same tools as interactive
  # sessions — a hardcoded subset silently dropped the tool venvs
  # (/opt/assistant-tools/bin for apprise, /opt/google-cloud-sdk/bin) and broke
  # the `notify` skill under cron (#551). Belt-and-braces: re-append the venv
  # dirs in case a login-shell /etc/profile reset removed them from PATH.
  local cron_path="$PATH"
  local extra_dir
  for extra_dir in /opt/assistant-tools/bin /opt/google-cloud-sdk/bin; do
    case ":$cron_path:" in
      *":$extra_dir:"*) ;;
      *) cron_path="$cron_path:$extra_dir" ;;
    esac
  done
  echo "# openpalm:cron-preamble BEGIN" > "$crontab_file"
  echo "# Auto-generated by entrypoint — do not edit" >> "$crontab_file"
  echo "SHELL=/bin/bash" >> "$crontab_file"
  echo "PATH=$cron_path" >> "$crontab_file"

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
    if ! run_akm_command akm tasks sync >&2; then
      echo "warning: initial akm tasks sync failed; continuing startup" >&2
    fi
  fi

  if [ -f "$crontab_file" ]; then
    rm -f "$crontab_file"
    if ! busybox crond -c "$spool_dir" -L /dev/stderr; then
      echo "warning: busybox crond failed to start; scheduled automations will not run" >&2
    fi
  fi

  # Background re-sync loop: picks up task file changes without restart
  (
    while true; do
      sleep 60
      if command -v akm >/dev/null 2>&1 && [ -d "$tasks_dir" ]; then
        if ! run_akm_command akm tasks sync >&2; then
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

  # --print-logs sends OpenCode's logs to stderr (docker logs) instead of a file;
  # --log-level sets verbosity (override via OPENCODE_LOG_LEVEL).
  local cmd=(opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs --log-level "${OPENCODE_LOG_LEVEL:-INFO}")

  # Browser clients are served from separate loopback origins and call OpenCode
  # directly. Allow the shipped origins by default, and let operators add exact
  # comma-separated origins for custom reverse-proxy/client deployments.
  local client_host_port="${OP_CLIENT_HOST_PORT:-${OP_CLIENT_PORT:-3810}}"
  local host_client_port="${OP_HOST_CLIENT_PORT:-3890}"
  local client_bind_address="${OP_CLIENT_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}"
  local assistant_bind_address="${OP_ASSISTANT_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}"
  local cors_origins=(
    "http://127.0.0.1:${client_host_port}"
    "http://localhost:${client_host_port}"
    "http://127.0.0.1:${host_client_port}"
    "http://localhost:${host_client_port}"
  )
  # I3: EXPLICIT ORIGINS ONLY — never emit a wildcard CORS grant. When the
  # client bind address is a concrete non-loopback host/IP (an operator
  # opting a specific LAN address into the client's origin set), add that
  # exact origin; it is still one named origin, never a wildcard grant. A
  # wildcard client bind (0.0.0.0/::) cannot be turned into the one true
  # browser Origin a LAN visitor's browser will actually send, so nothing is
  # auto-derived for it — operators add the exact origin(s) they expect via
  # OP_CLIENT_CORS_ALLOWED_ORIGINS below. See also start_client's LAN-exposure
  # safety gate, which refuses to serve the client surface at all when auth
  # stays disabled on a non-loopback assistant bind.
  if [ "$client_bind_address" != "127.0.0.1" ] && [ "$client_bind_address" != "localhost" ] \
     && [ "$client_bind_address" != "0.0.0.0" ] && [ "$client_bind_address" != "::" ] \
     && [ "$assistant_bind_address" != "127.0.0.1" ] && [ "$assistant_bind_address" != "localhost" ]; then
    cors_origins+=("http://${client_bind_address}:${client_host_port}")
  fi
  # H2 (review): the comment above documents that a wildcard client bind
  # derives NO LAN CORS origin — but a wildcard bind is exactly the
  # configuration a LAN operator who has ALSO turned on OPENCODE_AUTH (the
  # legitimate hardened-LAN path start_client's safety gate allows) would
  # use. Silently deriving nothing left LAN chat failing OpenCode's CORS
  # preflight with no operator-facing signal — only this source comment.
  # Emit a loud runtime warning naming the knob operators must set
  # (OP_CLIENT_CORS_ALLOWED_ORIGINS) whenever that gap is live: wildcard
  # client bind + auth enabled + no explicit origins configured to fill it.
  if { [ "$client_bind_address" = "0.0.0.0" ] || [ "$client_bind_address" = "::" ]; } \
     && opencode_auth_enabled && [ -z "${OP_CLIENT_CORS_ALLOWED_ORIGINS:-}" ]; then
    echo "WARNING: OP_CLIENT_BIND_ADDRESS/OP_BIND_ADDRESS=${client_bind_address} is a wildcard bind with OPENCODE_AUTH enabled, but no LAN browser Origin can be auto-derived from a wildcard bind — set OP_CLIENT_CORS_ALLOWED_ORIGINS to the exact http(s) origin(s) LAN browsers will use (e.g. http://<lan-ip>:${client_host_port}), or the client will silently fail OpenCode's CORS preflight." >&2
  fi
  if [ -n "${OP_CLIENT_CORS_ALLOWED_ORIGINS:-}" ]; then
    local old_ifs="$IFS"
    IFS=','
    read -ra extra_origins <<< "${OP_CLIENT_CORS_ALLOWED_ORIGINS}"
    IFS="$old_ifs"
    local origin
    for origin in "${extra_origins[@]}"; do
      origin="${origin#${origin%%[![:space:]]*}}"
      origin="${origin%${origin##*[![:space:]]}}"
      if [ -n "$origin" ]; then
        if is_allowed_cors_origin "$origin"; then
          cors_origins+=("$origin")
        else
          echo "warning: rejecting invalid OP_CLIENT_CORS_ALLOWED_ORIGINS entry (must be an exact http(s) origin — no wildcard, userinfo, path, query, or fragment): $origin" >&2
        fi
      fi
    done
  fi
  local origin
  for origin in "${cors_origins[@]}"; do
    cmd+=(--cors "$origin")
  done

  exec "${cmd[@]}"
}

ensure_home_layout
maybe_prepare_nss_wrapper
maybe_source_akm_user_env
install_runtime_artifacts
seed_default_agents_md
run_akm_schema_migration
persist_akm_stash_dir_fallback
start_cron_and_sync_tasks
start_client
start_opencode
