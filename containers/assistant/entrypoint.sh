#!/bin/bash
set -euo pipefail

SYSTEM_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ASSISTANT_PATH="/opt/persistent/bin:/opt/openpalm/tools/node_modules/.bin:/home/opencode/.local/bin:/home/opencode/.bun/bin:/usr/local/bin:/opt/assistant-tools/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
SCHEDULED_TASK_PATH="/opt/openpalm/tools/node_modules/.bin:/usr/local/bin:/opt/assistant-tools/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/persistent/bin:/home/opencode/.local/bin:/home/opencode/.bun/bin"
AKM_BIN="/usr/local/bin/akm"
AKM_MIGRATION_HELPER="/usr/local/lib/openpalm/migrate-akm-09.sh"
NODE_BIN="/usr/local/bin/node"
OPENCODE_BIN="/opt/openpalm/tools/node_modules/.bin/opencode"
RUNTIME_DIR="/run/openpalm"
USER_RUNTIME_DIR="${RUNTIME_DIR}/user"
TASK_SYNC_STATUS_FILE="${RUNTIME_DIR}/task-sync.status"
TASK_SYNC_MONITOR_FATAL_RC=70
TASK_SYNC_STATUS_MAX_AGE_SECONDS=90
TASK_SYNC_STATUS="degraded"
TASK_SYNC_REASON="exit-1"
TASK_SYNC_HEALTH_REPORT="status=invalid reason=invalid updated_at=unknown fresh=false"
PORT="${OPENCODE_PORT:-4096}"
UI_SUPERVISOR_PID=""

if [ "$EUID" -eq 0 ]; then
  # Root startup must never resolve a command from an operator-writable mount.
  export PATH="$SYSTEM_PATH"
fi

task_sync_status_fields_are_valid() {
  local status="$1"
  local reason="$2"
  case "$status:$reason" in
    healthy:ok|degraded:skipped) return 0 ;;
  esac
  if [ "$status" != "degraded" ]; then return 1; fi
  [[ "$reason" =~ ^exit-([1-9][0-9]{0,2})$ ]] || return 1
  local exit_code=$((10#${BASH_REMATCH[1]}))
  [ "$exit_code" -le 255 ] && [ "$reason" = "exit-$exit_code" ]
}

write_task_sync_status_file() {
  local updated_at
  if ! task_sync_status_fields_are_valid "$1" "$2"; then
    echo "ERROR: invalid task reconciliation status fields." >&2
    return 64
  fi
  if ! updated_at="$(/usr/bin/date +%s)"; then
    echo "ERROR: could not timestamp task reconciliation status." >&2
    return "$TASK_SYNC_MONITOR_FATAL_RC"
  fi
  if ! printf '%s %s %s\n' "$1" "$updated_at" "$2" > "$TASK_SYNC_STATUS_FILE"; then
    echo "ERROR: could not write task reconciliation status." >&2
    return "$TASK_SYNC_MONITOR_FATAL_RC"
  fi
  if ! chown root:root "$TASK_SYNC_STATUS_FILE"; then
    echo "ERROR: could not secure task reconciliation status ownership." >&2
    return "$TASK_SYNC_MONITOR_FATAL_RC"
  fi
  if ! chmod 0644 "$TASK_SYNC_STATUS_FILE"; then
    echo "ERROR: could not secure task reconciliation status permissions." >&2
    return "$TASK_SYNC_MONITOR_FATAL_RC"
  fi
}

set_task_sync_status() {
  local rc=0
  if [ "$EUID" -ne 0 ]; then
    echo "ERROR: only the root runtime monitor may update task reconciliation health." >&2
    return "$TASK_SYNC_MONITOR_FATAL_RC"
  fi
  write_task_sync_status_file "$1" "$2" || rc=$?
  if [ "$rc" -ne 0 ]; then return "$rc"; fi
  TASK_SYNC_STATUS="$1"
  TASK_SYNC_REASON="$2"
}

task_sync_status_is_healthy() {
  local now="${1:-}"
  local lines=()
  TASK_SYNC_HEALTH_REPORT="status=invalid reason=invalid updated_at=unknown fresh=false"
  if [ -z "$now" ]; then
    now="$(/usr/bin/date +%s)" || return 1
  fi
  if [[ ! "$now" =~ ^[1-9][0-9]{0,17}$ ]]; then return 1; fi
  if ! mapfile -t lines < "$TASK_SYNC_STATUS_FILE" 2>/dev/null; then return 1; fi
  if [ "${#lines[@]}" -ne 1 ]; then return 1; fi
  if [[ ! "${lines[0]}" =~ ^(healthy|degraded)\ ([1-9][0-9]{0,17})\ (ok|skipped|exit-[0-9]{1,3})$ ]]; then
    return 1
  fi

  local status="${BASH_REMATCH[1]}"
  local updated_at="${BASH_REMATCH[2]}"
  local reason="${BASH_REMATCH[3]}"
  if ! task_sync_status_fields_are_valid "$status" "$reason"; then return 1; fi
  TASK_SYNC_HEALTH_REPORT="status=$status reason=$reason updated_at=$updated_at fresh=false"
  if [ "${#updated_at}" -gt "${#now}" ]; then return 1; fi
  local now_number=$((10#$now))
  local updated_at_number=$((10#$updated_at))
  if [ "$updated_at_number" -gt "$now_number" ]; then return 1; fi
  if [ "$((now_number - updated_at_number))" -gt "$TASK_SYNC_STATUS_MAX_AGE_SECONDS" ]; then return 1; fi
  TASK_SYNC_HEALTH_REPORT="status=$status reason=$reason updated_at=$updated_at fresh=true"
  [ "$status" = healthy ]
}

check_task_sync_health() {
  if task_sync_status_is_healthy; then return 0; fi
  printf 'ERROR: task reconciliation health check failed: %s\n' "$TASK_SYNC_HEALTH_REPORT" >&2
  return 1
}

runtime_id() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]] || [ "${#value}" -gt 10 ]; then
    echo "ERROR: ${name} must be an integer between 1 and 2147483647 (got ${value})." >&2
    return 64
  fi
  local number=$((10#$value))
  if [ "$number" -gt 2147483647 ]; then
    echo "ERROR: ${name} must be an integer between 1 and 2147483647 (got ${value})." >&2
    return 64
  fi
  printf '%s\n' "$number"
}

configure_assistant_identity() {
  local runtime_uid runtime_gid existing_user runtime_group current_uid
  runtime_uid="$(runtime_id OP_UID "${OP_UID:-1000}")"
  runtime_gid="$(runtime_id OP_GID "${OP_GID:-1000}")"

  existing_user="$(getent passwd "$runtime_uid" | cut -d: -f1 || true)"
  if [ -n "$existing_user" ] && [ "$existing_user" != "node" ]; then
    echo "ERROR: OP_UID ${runtime_uid} already belongs to account ${existing_user}; refusing an ambiguous cron identity." >&2
    return 64
  fi

  runtime_group="$(getent group "$runtime_gid" | cut -d: -f1 || true)"
  case "$runtime_group" in
    adm|crontab|disk|kmem|mail|shadow|staff|sudo|tty|utmp)
      echo "ERROR: OP_GID ${runtime_gid} collides with privileged image group ${runtime_group}." >&2
      return 64
      ;;
  esac
  if [ -z "$runtime_group" ]; then
    groupmod --gid "$runtime_gid" node
    runtime_group="node"
  fi

  current_uid="$(id -u node)"
  if [ "$current_uid" != "$runtime_uid" ]; then
    # usermod recursively changes ownership below the account's current home
    # when changing its UID. Keep that operation on the image-owned /home/node,
    # never on the persistent /home/opencode bind mount.
    usermod --home /home/node node
    usermod --uid "$runtime_uid" node
  fi
  usermod --gid "$runtime_group" --home /home/opencode --shell /bin/bash node

  export OP_UID="$runtime_uid" OP_GID="$runtime_gid"
  mkdir -p "$USER_RUNTIME_DIR"
  chown root:root "$RUNTIME_DIR"
  chmod 0755 "$RUNTIME_DIR"
  chown node:"$runtime_group" "$USER_RUNTIME_DIR"
  chmod 0700 "$USER_RUNTIME_DIR"
  set_task_sync_status degraded exit-1
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
    /opt/akm/state \
    /stash

}

# ── G1: env/user is NOT sourced into this process ───────────────────────────
# This entrypoint used to `set -a; . "$AKM_BUNDLE_DIR/env/user.env"` here and
# then `exec opencode` from the SAME shell, which put every env/user value
# (API keys, owner info, anything the operator configured) into the OpenCode
# server's own process environment — and therefore into every bash-tool
# subprocess the agent runs, retrievable with a single `env`/`printenv` call
# with no file path involved at all. Nothing between here and `start_opencode`
# needs env/user's arbitrary
# keys: the AKM migration helper only needs HOME and the AKM directory
# variables already in the container's own environment, and
# `prepare_user_crontab` forwards its own small, explicit allowlist of
# vars into the crontab preamble rather than the whole file. The sanctioned,
# on-demand path for the AGENT to use a user secret is still available and
# unaffected by this change: `akm env run env/user -- <command>` loads it only
# for the requested subprocess, never the server's top-level environment.

# ── E2/S2: no boot-time package installs ────────────────────────────────────
# @openpalm/ui, local OpenCode, and npm-global AKM are baked into the image by
# the Dockerfile. There is no runtime package install or update. The image is
# the sole source of truth; updating a tool pin or PLATFORM_VERSION requires a
# new image instead of boot-time registry resolution. This closes the
# air-gapped-first-boot gap by construction rather than by adding a fallback.
#
# There is no package version resolution to perform at container boot.

# ── LAN-exposure helper ──────────────────────────────────────────────────────
# Used by start_ui's exposure warning when OpenCode is bound off-loopback with
# auth disabled (see start_ui below).
is_loopback_address() {
  case "$1" in
    127.0.0.1|localhost|::1) return 0 ;;
    *) return 1 ;;
  esac
}

opencode_auth_enabled() {
  case "${OPENCODE_AUTH:-false}" in
    true|TRUE|True|1|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# Voice LAN-access opt-in (OP_VOICE_LAN_ACCESS, core.compose.yml
# interpolation — this entrypoint has no OP_HOME and cannot read
# state/stack.env itself). Off by default: see the OP_UI_NO_LOCAL_VOICE
# comment in start_ui below for what flips when this is on.
voice_lan_access_enabled() {
  case "${OP_VOICE_LAN_ACCESS:-false}" in
    true|TRUE|True|1|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# #563/#564 P1-2: resolve OpenCode's Basic-auth password from the compose
# secret file, gated on opencode_auth_enabled. The secret file is ALWAYS
# materialized non-empty by ensureSecrets (random seed on first install, or a
# retained password after direct Assistant auth is disabled) and
# must stay inert while OPENCODE_AUTH is off — otherwise reading it here would
# turn on OpenCode Basic auth against an unauthenticated healthcheck probe and
# wedge the stack unhealthy. Decision D1: an explicit OPENCODE_SERVER_PASSWORD
# env value is deliberately never unset when auth is off — silently dropping
# an operator-supplied credential would be a silent auth downgrade; instead
# the posture-gated healthcheck (core.compose.yml, containers/assistant/
# Dockerfile) fails loud on the mismatch. Explicit OPENCODE_SERVER_PASSWORD
# env wins over *_FILE; trailing newline stripped by command substitution.
# Fail fast when auth is enabled but no password resolves — auth-on with an
# unknown password is a dead stack that looks healthy, so failing loud here
# is the debuggable behavior.
resolve_opencode_server_password() {
  if ! opencode_auth_enabled; then
    return 0
  fi
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ] \
     && [ -n "${OPENCODE_SERVER_PASSWORD_FILE:-}" ] && [ -s "${OPENCODE_SERVER_PASSWORD_FILE}" ]; then
    OPENCODE_SERVER_PASSWORD="$(cat "${OPENCODE_SERVER_PASSWORD_FILE}")"
  fi
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
    echo "ERROR: OPENCODE_AUTH=${OPENCODE_AUTH:-} is enabled but no password is available — set OPENCODE_SERVER_PASSWORD or OPENCODE_SERVER_PASSWORD_FILE (compose secret opencode_server_password)." >&2
    exit 1
  fi
}

start_ui() {
  # Served OpenPalm UI (@openpalm/ui). The assistant container serves the
  # SvelteKit adapter-node build as a supervised co-process ALONGSIDE OpenCode,
  # and the browser reaches OpenCode through this process's own same-origin
  # /oc proxy — seeded as the one locked connection in runtime-config.json
  # below. This is THE listener a home install publishes.

  # ── LAN-exposure warning ─────────────────────────────────────────────────
  # When OpenCode is bound off loopback and auth is disabled, warn loudly but
  # keep the UI available. Exposure policy is an operator decision; silently
  # removing the configured UI is not an acceptable substitute for that warning.
  # Flat: generated explicitly by the access toggles, so unset means loopback.
  local assistant_bind_address="${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}"
  if ! is_loopback_address "$assistant_bind_address" && ! opencode_auth_enabled; then
    echo "WARNING: OP_ASSISTANT_BIND_ADDRESS=${assistant_bind_address} exposes OpenCode beyond loopback while OPENCODE_AUTH=${OPENCODE_AUTH:-false} leaves it unauthenticated; the UI will still start. Publishing the assistant API is expected to generate a key — this combination means something wrote the bind by hand." >&2
  fi

  local ui_pkg="/opt/openpalm/ui/node_modules/@openpalm/ui"
  local ui_build="${ui_pkg}/build"
  local ui_index="${ui_build}/index.js"
  local ui_client_dir="${ui_build}/client"
  if [ ! -f "$ui_index" ]; then
    echo "ERROR: image-baked @openpalm/ui build not found at ${ui_index}." >&2
    return 1
  fi

  # Write runtime-config.json into the served static root: adapter-node serves
  # build/client at the app origin, so the browser store's GET
  # /runtime-config.json (packages/ui connections/store.ts loadRuntimeConfig)
  # resolves here. It seeds the connection store with ONE locked default
  # connection: the assistant's OpenCode as published on the HOST — compose maps
  # ${OP_ASSISTANT_PORT:-3810} -> in-container 4096, and the in-container :4096
  # is unreachable from a browser. Non-default topologies override the full URL
  # via OP_UI_DEFAULT_ASSISTANT_URL. JSON is emitted via node (present in the
  # base image) so an unusual URL value can never produce a malformed file. The
  # record shape MUST match the ui store: { id, label, baseUrl, auth }, and
  # id/fallback label MUST equal packages/lib ui-runtime-config.ts's
  # ASSISTANT_LOCKED_CONNECTION_ID / _LABEL. OP_PROJECT_NAME supplies the
  # connection's detected local assistant name when available.
  # Seed the SAME-ORIGIN proxy path, not an absolute URL. The browser resolves
  # `/oc` against whatever origin it actually loaded — localhost, a LAN IP, an
  # mDNS `.local` name, or a reverse-proxied HTTPS origin — which is precisely
  # what this process cannot know when it writes the file at startup. That
  # removes the old absolute `127.0.0.1:${OP_ASSISTANT_PORT}` seed and the
  # client-side host rewrite that existed to patch it up for remote browsers.
  # OP_UI_DEFAULT_ASSISTANT_URL still overrides for non-default topologies.
  local assistant_url="${OP_UI_DEFAULT_ASSISTANT_URL:-/oc}"
  local assistant_name="${OP_PROJECT_NAME:-}"
  mkdir -p "$ui_client_dir"
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, url, assistantName] = process.argv.slice(1);
    // Never let a wildcard bind host leak into a browser-facing URL — an
    // operator override may itself be derived from a bind-address setting
    // upstream. Mirrors packages/lib/src/control-plane/url-normalize.ts
    // normalizeLoopbackUrl.
    let normalizedUrl = url.replace(/^(https?:\/\/)(0\.0\.0\.0|\[::\]|::)(?=[:/]|$)/i, "$1127.0.0.1");
    let connection = null;
    try {
      // A root-relative seed ("/oc") is the same-origin proxy — the browser
      // resolves it against the origin it loaded, which is exactly what this
      // process cannot know. Reject a protocol-relative "//host" or a path
      // carrying userinfo/query/fragment, which could resolve elsewhere.
      if (normalizedUrl.startsWith("/")) {
        if (normalizedUrl.startsWith("//") || /[?#@]/.test(normalizedUrl)) throw new Error("invalid path");
      } else {
        const parsedUrl = new URL(normalizedUrl);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("invalid protocol");
        const hadUserinfo = Boolean(parsedUrl.username || parsedUrl.password);
        parsedUrl.username = "";
        parsedUrl.password = "";
        if (hadUserinfo) normalizedUrl = parsedUrl.toString();
      }
      connection = {
        id: "openpalm-assistant-opencode",
        label: assistantName.trim() || "Local assistant",
        baseUrl: normalizedUrl,
        auth: { mode: "none" },
        isDefault: true,
        locked: true,
      };
    } catch {
      console.error("warning: invalid assistant URL; UI starts with no default connection");
    }
    const config = {
      connections: connection ? [connection] : [],
    };
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  ' "${ui_client_dir}/runtime-config.json" "$assistant_url" "$assistant_name" \
    || echo "warning: could not write runtime-config.json; UI starts with no default connection" >&2

  # The in-container listen port is FIXED. It is the target of the compose port
  # mapping (`${OP_UI_BIND_ADDRESS}:${OP_UI_PORT}:3000`), so it cannot vary.
  # Reading OP_UI_PORT here was a trap: that variable is the HOST-facing knob,
  # and an operator who set it in custom.compose.yml's `environment:` (the
  # obvious wrong move, since it IS the documented host knob name) made the UI
  # child bind that port in-container while the mapping still targeted 3000 —
  # the front door dead, and both healthchecks following the env var to the
  # wrong port and reporting healthy anyway.
  local ui_port=3000

  # ── UI session login password ─────────────────────────────────────────────
  # The served UI authenticates browsers with the SAME UI login password as the
  # host UI (op_session cookie; /api/auth is deliberately outside /api/host so a
  # non-admin served deployment can log in). The container has no OP_HOME, so
  # the password arrives as a compose secret file (OP_UI_LOGIN_PASSWORD_FILE,
  # core.compose.yml) and is resolved into the UI child's env ONLY — same
  # pattern as OPENCODE_SERVER_PASSWORD_FILE in start_opencode. Without a
  # usable password every HTML navigation dead-ends at /login, so warn loudly.
  local ui_login_password=""
  if [ -n "${OP_UI_LOGIN_PASSWORD_FILE:-}" ] && [ -s "${OP_UI_LOGIN_PASSWORD_FILE}" ]; then
    ui_login_password="$(cat "${OP_UI_LOGIN_PASSWORD_FILE}")"
  fi
  if [ -z "$ui_login_password" ]; then
    echo "WARNING: no UI login password available (OP_UI_LOGIN_PASSWORD_FILE missing or empty) — the served UI will redirect to /login but no session can be minted. Run setup (or seed private/secrets/op_ui_login_password) to fix." >&2
  fi

  echo "entrypoint: starting UI co-process on port ${ui_port}..." >&2

  # ── supervise + respawn with capped exponential backoff ──────────────────
  # Mirrors the host-side UI supervisor semantics (packages/lib ui-supervisor.ts,
  # packages/cli ui-server.ts): an unexpected exit respawns the co-process
  # instead of leaving the published port silently dead (the compose + Dockerfile
  # healthchecks probe it), but a crash loop backs off (1s, 2s, 4s, 8s, 16s,
  # capped at 30s) and gives up after max_attempts so a persistently broken UI
  # can't spin the container's CPU/log forever.
  #
  # Bind 0.0.0.0 INSIDE the container only: Docker's published port mapping
  # forwards to the container's interface, so a 127.0.0.1 in-container bind would
  # be unreachable through it. Loopback-first HOST exposure is governed by the
  # compose port mapping, which defaults to 127.0.0.1 (OP_BIND_ADDRESS policy),
  # exactly as OpenCode itself binds --hostname 0.0.0.0 here. HOST_HEADER lets
  # adapter-node derive its origin from the request Host header so CSRF/Origin
  # checks pass across the host<->container port mapping; the app-level SEC-1
  # Host allowlist (packages/ui hooks.server.ts) still rejects non-loopback Host
  # headers by default.
  #
  # NON-admin build: OP_ENABLE_ADMIN and OP_INSIDE_ELECTRON are explicitly UNSET
  # in the child so isAdminCapable() is false and every /host (host:*) route
  # 404s — the Phase-5 Electron/CLI-only admin boundary holds in the container.
  # No host OP_HOME or raw OpenCode password is injected. The child receives
  # the UI login password plus the existing OPENCODE_SERVER_PASSWORD_FILE path
  # so its same-origin /oc proxy can authenticate to the local server when the
  # operator enables direct Assistant auth.
  #
  # OP_UI_NO_LOCAL_VOICE=1: this in-container co-process reaches only its OWN
  # 127.0.0.1, never the sibling voice container, so it must never advertise or
  # proxy the /voice pass-through — voice was decoupled from admin capability,
  # and getState() here can resolve into an assistant-writable mount, so a
  # bare "addon enabled?" check is not a sufficient gate. This flag makes the
  # co-process fail closed regardless of readable stack state.
  #
  # OP_VOICE_LAN_ACCESS (opt-in, default off) changes that premise: when the
  # operator has granted voice assistant_net (voice.compose.lan.yml,
  # included by discoverStackOverlays only under this same flag), this
  # co-process DOES have a real network path to voice, over Docker DNS —
  # so it stops setting OP_UI_NO_LOCAL_VOICE and instead advertises the
  # upstream via OP_VOICE_URL=http://voice:8880.
  #
  # 8880 here is voice's FIXED INTERNAL port (OP_VOICE_PORT in
  # services.compose.yml) — NOT OP_VOICE_PORT_HOST, the operator-configurable
  # HOST-facing publish port packages/ui voiceHostPort() resolves for
  # loopback callers. This container-to-container hop is Docker-DNS-to-
  # in-container-port and never touches the published port at all. Confusing
  # the two is exactly the OP_UI_PORT trap documented above (the ui_port
  # local var) — a host-facing knob fed into a value that must stay fixed
  # in-container.
  (
    local attempt=0
    local max_attempts=5
    local delay=1
    local max_delay=30
    # A child that stays up at least this long before exiting resets the give-up
    # counter, so only a PERSISTENTLY-broken UI (no healthy stretch between
    # crashes) can exhaust max_attempts. Millisecond resolution via Node's
    # Date.now() (portable; avoids uutils `date +%s%3N` nanosecond drift).
    # Configurable (test hook) via OP_UI_RESPAWN_HEALTHY_UPTIME_MS.
    local healthy_uptime_ms="${OP_UI_RESPAWN_HEALTHY_UPTIME_MS:-60000}"
    while true; do
      local start_ts
      start_ts="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))')"
      local exit_code
      # Recomputed each iteration (cheap; OP_VOICE_LAN_ACCESS never changes
      # mid-boot) so a respawn always reflects the same posture the container
      # was started with — see the block comment above for what each branch means.
      local voice_env_args=(OP_UI_NO_LOCAL_VOICE=1)
      if voice_lan_access_enabled; then
        voice_env_args=(OP_VOICE_URL=http://voice:8880)
      fi
      if /usr/bin/env -u OP_ENABLE_ADMIN -u OP_INSIDE_ELECTRON -u OPENCODE_SERVER_PASSWORD \
           HOST=0.0.0.0 PORT="$ui_port" HOST_HEADER=host PROTOCOL_HEADER=x-forwarded-proto \
           BODY_SIZE_LIMIT=2097152 \
           PATH="$ASSISTANT_PATH" \
           "${voice_env_args[@]}" \
           OP_UI_SERVED_IN_CONTAINER=1 \
           OP_OPENCODE_URL=http://localhost:4096 \
           OP_UI_LOGIN_PASSWORD="$ui_login_password" \
           "$NODE_BIN" "$ui_index"; then
        exit_code=0
      else
        exit_code=$?
      fi
      local end_ts
      end_ts="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))')"
      if [ "$((end_ts - start_ts))" -ge "$healthy_uptime_ms" ]; then
        attempt=0
      fi
      attempt=$((attempt + 1))
      if [ "$attempt" -ge "$max_attempts" ]; then
        echo "ERROR: UI co-process exited $attempt times (last exit $exit_code); giving up on respawn." >&2
        break
      fi
      echo "warning: UI co-process exited (code $exit_code) — restarting in ${delay}s (attempt $((attempt + 1))/${max_attempts})" >&2
      sleep "$delay"
      delay=$((delay * 2))
      if [ "$delay" -gt "$max_delay" ]; then delay=$max_delay; fi
    done
  ) &

  UI_SUPERVISOR_PID=$!
  echo "entrypoint: UI co-process supervisor PID $UI_SUPERVISOR_PID started" >&2
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
  # A raw OpenCode password is intentionally withheld; scheduled work receives
  # only the file path from the managed crontab environment.
  /usr/bin/env -u OPENCODE_SERVER_PASSWORD HOME="${HOME:-/home/opencode}" "$@"
}

append_cron_environment() {
  local file="$1"
  local name="$2"
  local value="${!name:-}"
  if [ -z "$value" ]; then return 0; fi
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "ERROR: ${name} contains a newline and cannot be placed in the cron environment." >&2
    return 64
  fi
  printf '%s=%s\n' "$name" "$value" >> "$file"
}

prepare_user_crontab() {
  local crontab_file
  crontab_file="$(mktemp "${USER_RUNTIME_DIR}/crontab.XXXXXX")"
  chmod 0600 "$crontab_file"
  {
    printf '%s\n' \
      '# Auto-generated by the OpenPalm Assistant entrypoint; derived from knowledge/tasks/*.yml.' \
      'MAILTO=""' \
      'SHELL=/bin/bash' \
      "PATH=${SCHEDULED_TASK_PATH}" \
      'HOME=/home/opencode'
  } > "$crontab_file"

  local name
  for name in AKM_BUNDLE_DIR AKM_CONFIG_DIR AKM_CACHE_DIR AKM_DATA_DIR AKM_STATE_DIR \
              APPRISE_NOTIFY_CONFIG OPENCODE_API_URL OPENCODE_CONFIG_DIR OPENCODE_AUTH \
              OPENCODE_SERVER_PASSWORD_FILE OPENCODE_SERVER_USERNAME; do
    if ! append_cron_environment "$crontab_file" "$name"; then
      rm -f "$crontab_file"
      return 64
    fi
  done

  # The cron spool is derived container state. Rebuild it on every boot rather
  # than preserving stale bindings or unsupported hand-written entries.
  if ! /usr/bin/crontab "$crontab_file"; then
    rm -f "$crontab_file"
    echo "ERROR: failed to install the Assistant user's native crontab." >&2
    return 1
  fi
  rm -f "$crontab_file"
}

sync_akm_tasks() {
  local output=""
  local args=(task sync --format json --quiet "$@")
  local rc=0
  output="$(run_akm_command /usr/bin/env PATH="$SCHEDULED_TASK_PATH" /usr/bin/timeout --signal=TERM --kill-after=5s 50s "$AKM_BIN" "${args[@]}")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ -n "$output" ]; then printf '%s\n' "$output" >&2; fi
    echo "error: akm task sync failed (exit $rc)" >&2
    return 1
  fi
  printf '%s\n' "$output" >&2
  if ! printf '%s\n' "$output" | /usr/bin/jq -e -s \
      'length == 1 and .[0].shape == "task-sync" and .[0].schemaVersion == 1 and ((.[0].skipped | type) == "array")' \
      >/dev/null; then
    echo "error: akm task sync returned invalid output" >&2
    return 1
  fi
  if ! printf '%s\n' "$output" | /usr/bin/jq -e -s '.[0].skipped | length == 0' >/dev/null; then
    echo "error: akm task sync reported skipped tasks" >&2
    return 2
  fi
}

reconcile_akm_tasks() {
  if [ "$EUID" -ne 0 ]; then
    echo "ERROR: task reconciliation health must be supervised by root." >&2
    return "$TASK_SYNC_MONITOR_FATAL_RC"
  fi
  local rc=0
  "$@" || rc=$?
  record_reconciliation_result "$rc"
}

record_reconciliation_result() {
  local rc="$1"
  local status="degraded"
  local reason=""
  case "$rc" in
    0)
      status="healthy"
      reason="ok"
      ;;
    2) reason="skipped" ;;
    *)
      if [[ ! "$rc" =~ ^[1-9][0-9]{0,2}$ ]] || [ "$((10#$rc))" -gt 255 ]; then
        echo "ERROR: invalid task reconciliation exit status." >&2
        return "$TASK_SYNC_MONITOR_FATAL_RC"
      fi
      reason="exit-$((10#$rc))"
      ;;
  esac
  if ! set_task_sync_status "$status" "$reason"; then
    return "$TASK_SYNC_MONITOR_FATAL_RC"
  fi
  if [ "$rc" -eq 0 ]; then return 0; fi
  return 1
}

sync_tasks_forever() {
  while true; do
    sleep 60
    # Refresh the prior result before starting bounded reconciliation work so
    # this root-written timestamp also proves the monitor is still making progress.
    if ! set_task_sync_status "$TASK_SYNC_STATUS" "$TASK_SYNC_REASON"; then
      echo "ERROR: task reconciliation health monitor failed; stopping the container." >&2
      return "$TASK_SYNC_MONITOR_FATAL_RC"
    fi
    local rc=0
    reconcile_akm_tasks "$@" || rc=$?
    if [ "$rc" -eq "$TASK_SYNC_MONITOR_FATAL_RC" ]; then
      echo "ERROR: task reconciliation health monitor failed; stopping the container." >&2
      return "$TASK_SYNC_MONITOR_FATAL_RC"
    fi
    if [ "$rc" -ne 0 ]; then
      echo "warning: background akm task reconciliation is degraded; retrying in 60s" >&2
    fi
  done
}

start_opencode() {
  cd /work

  # Ensure bun's user-writable directories exist (set via Dockerfile ENV).
  mkdir -p "${BUN_INSTALL:-/home/opencode/.bun}/bin" \
           "${BUN_INSTALL_CACHE_DIR:-/home/opencode/.cache/bun/install}"

  # --print-logs sends OpenCode's logs to stderr (docker logs) instead of a file;
  # --log-level sets verbosity (override via OPENCODE_LOG_LEVEL).
  local cmd=("$OPENCODE_BIN" web --hostname 0.0.0.0 --port "$PORT" --print-logs --log-level "${OPENCODE_LOG_LEVEL:-INFO}")

  # No --cors grant. The browser reaches OpenCode through the UI's OWN
  # same-origin /oc proxy (packages/ui routes/oc), so it never makes a
  # cross-origin request here and there is no origin to allow. This replaced an
  # allowlist the container could not compute: only the HOST can enumerate its
  # LAN addresses, so the correct origins had to be resolved host-side and
  # injected — and getting them wrong surfaced as a bare network error.

  if opencode_auth_enabled; then
    exec /usr/bin/env PATH="$ASSISTANT_PATH" OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" "${cmd[@]}"
  fi
  exec /usr/bin/env -u OPENCODE_SERVER_PASSWORD PATH="$ASSISTANT_PATH" "${cmd[@]}"
}

require_assistant_identity() {
  if [ "$EUID" -eq 0 ] || [ "$(id -un)" != "node" ]; then
    echo "ERROR: Assistant work must run as the configured node account." >&2
    return 70
  fi
}

bootstrap_assistant() {
  require_assistant_identity
  ensure_home_layout
  seed_default_agents_md
  prepare_user_crontab
  "$AKM_MIGRATION_HELPER"
}

serve_assistant() {
  require_assistant_identity
  resolve_opencode_server_password
  start_ui
  start_opencode &
  local opencode_pid=$!
  local status=0
  set +e
  wait -n "$UI_SUPERVISOR_PID" "$opencode_pid"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then status=1; fi
  kill -TERM "$UI_SUPERVISOR_PID" "$opencode_pid" 2>/dev/null || true
  wait "$UI_SUPERVISOR_PID" "$opencode_pid" 2>/dev/null || true
  return "$status"
}

terminate_runtime_processes() {
  local cron_pid="$1"
  local sync_pid="$2"
  local app_pid="$3"
  kill -TERM -1 2>/dev/null || true
  sleep 5
  kill -KILL -1 2>/dev/null || true
  wait "$cron_pid" "$sync_pid" "$app_pid" 2>/dev/null || true
}

start_root_runtime() {
  if [ "$EUID" -ne 0 ]; then
    echo "ERROR: the Assistant entrypoint must start as root so Debian cron can safely run node's user crontab." >&2
    return 70
  fi

  configure_assistant_identity
  rm -f "${RUNTIME_DIR}/cron.pid" "${RUNTIME_DIR}/sync.pid" "${RUNTIME_DIR}/app.pid"
  local crontab_gid
  crontab_gid="$(getent group crontab | cut -d: -f3)"
  if [ -z "$crontab_gid" ]; then
    echo "ERROR: Debian crontab group is missing." >&2
    return 70
  fi
  local assistant_exec=(
    /usr/bin/setpriv
    --reuid=node
    --regid="$(id -g node)"
    --groups="$crontab_gid"
    --bounding-set=-all
    --inh-caps=-all
    --ambient-caps=-all
    --no-new-privs
    /usr/bin/env
    HOME=/home/opencode
    USER=node
    LOGNAME=node
    SHELL=/bin/bash
    PATH="$SYSTEM_PATH"
  )
  local assistant_app_exec=(
    /usr/bin/setpriv
    --reuid=node
    --regid="$(id -g node)"
    --clear-groups
    --bounding-set=-all
    --inh-caps=-all
    --ambient-caps=-all
    --no-new-privs
    /usr/bin/env
    HOME=/home/opencode
    USER=node
    LOGNAME=node
    SHELL=/bin/bash
    PATH="$SYSTEM_PATH"
  )
  "${assistant_exec[@]}" /usr/local/bin/opencode-entrypoint.sh --bootstrap

  # This fixed root monitor owns only the deadline and health result. Its outer
  # timeout prevents a node process from suspending the node-owned timeout and
  # leaving a stale healthy result. The reconciliation command itself always
  # crosses the same capability-free node boundary used for bootstrap work,
  # including NoNewPrivs.
  local task_sync_exec=(
    /usr/bin/timeout
    --signal=TERM
    --kill-after=5s
    60s
    "${assistant_exec[@]}"
    /usr/local/bin/opencode-entrypoint.sh
    --sync-once
  )
  local initial_sync_rc=0
  reconcile_akm_tasks "${task_sync_exec[@]}" || initial_sync_rc=$?
  if [ "$initial_sync_rc" -eq "$TASK_SYNC_MONITOR_FATAL_RC" ]; then
    echo "ERROR: initial task reconciliation health could not be recorded." >&2
    return "$TASK_SYNC_MONITOR_FATAL_RC"
  fi
  if [ "$initial_sync_rc" -ne 0 ]; then
    echo "warning: initial akm task reconciliation is degraded; the healthcheck will remain red until a retry succeeds" >&2
  fi

  /usr/bin/env -i PATH="$SYSTEM_PATH" \
    /usr/bin/setpriv --no-new-privs /usr/sbin/cron -f &
  local cron_pid=$!
  printf '%s\n' "$cron_pid" > "${RUNTIME_DIR}/cron.pid"
  sleep 0.2
  if ! kill -0 "$cron_pid" 2>/dev/null; then
    wait "$cron_pid" || true
    echo "ERROR: Debian cron failed to start." >&2
    return 1
  fi

  sync_tasks_forever "${task_sync_exec[@]}" &
  local sync_pid=$!
  printf '%s\n' "$sync_pid" > "${RUNTIME_DIR}/sync.pid"

  "${assistant_app_exec[@]}" /usr/local/bin/opencode-entrypoint.sh --serve &
  local app_pid=$!
  printf '%s\n' "$app_pid" > "${RUNTIME_DIR}/app.pid"

  shutdown_runtime() {
    local status="${1:-0}"
    trap - TERM INT HUP
    terminate_runtime_processes "$cron_pid" "$sync_pid" "$app_pid"
    exit "$status"
  }
  trap 'shutdown_runtime 0' TERM INT HUP

  local status=0
  set +e
  wait -n "$cron_pid" "$sync_pid" "$app_pid"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then status=1; fi
  echo "ERROR: a required Assistant process exited; stopping the container." >&2
  shutdown_runtime "$status"
}

main() {
  case "${1:-}" in
    --bootstrap)
      bootstrap_assistant
      ;;
    --sync-once)
      require_assistant_identity
      shift
      case "$#" in
        0) ;;
        1)
          if [ "$1" != "--rebind" ]; then
            echo "ERROR: --sync-once accepts only the optional --rebind argument." >&2
            return 64
          fi
          ;;
        *)
          echo "ERROR: --sync-once accepts only the optional --rebind argument." >&2
          return 64
          ;;
      esac
      sync_akm_tasks "$@"
      ;;
    --check-task-sync-health)
      shift
      if [ "$#" -ne 0 ]; then
        echo "ERROR: --check-task-sync-health accepts no arguments." >&2
        return 64
      fi
      check_task_sync_health
      ;;
    --serve)
      serve_assistant
      ;;
    "")
      start_root_runtime
      ;;
    *)
      echo "ERROR: unknown Assistant entrypoint mode: $1" >&2
      return 64
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
