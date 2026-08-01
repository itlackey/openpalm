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
# keys: `run_akm_schema_migration` only needs HOME and the AKM directory
# variables already in the container's own environment, and
# `start_cron_and_sync_tasks` forwards its own small, explicit allowlist of
# vars into the crontab preamble rather than the whole file. The sanctioned,
# on-demand path for the AGENT to use a user secret is still available and
# unaffected by this change: `akm env run env/user -- <command>` loads it only
# for the requested subprocess, never the server's top-level environment.

# ── E2/S2: no boot-time package installs ────────────────────────────────────
# @openpalm/ui and the tool tree (opencode-ai, akm-cli) are baked into the image
# by the Dockerfile — there is no runtime `npm install` nor `bun update` of
# /opt/openpalm/tools
# anymore. The image is the sole source of
# truth; updating a version means editing containers/assistant/tools/
# package.json (or bumping PLATFORM_VERSION) and shipping a new image, not
# waiting for the next container boot to re-resolve a semver range. This also
# removes the old boot-time dependency on registry reachability (npm/bun),
# closing the air-gapped-first-boot gap by construction rather than by adding
# a fallback floor.
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
    export OPENCODE_SERVER_PASSWORD
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
  rm -f /tmp/openpalm-ui-skip
  if ! is_loopback_address "$assistant_bind_address" && ! opencode_auth_enabled; then
    echo "WARNING: OP_ASSISTANT_BIND_ADDRESS=${assistant_bind_address} exposes OpenCode beyond loopback while OPENCODE_AUTH=${OPENCODE_AUTH:-false} leaves it unauthenticated; the UI will still start. Publishing the assistant API is expected to generate a key — this combination means something wrote the bind by hand." >&2
  fi

  local ui_pkg="/opt/openpalm/ui/node_modules/@openpalm/ui"
  local ui_build="${ui_pkg}/build"
  local ui_index="${ui_build}/index.js"
  local ui_client_dir="${ui_build}/client"
  if [ ! -f "$ui_index" ]; then
    echo "entrypoint: @openpalm/ui build not found — UI co-process skipped" >&2
    # A missing/never-installed UI build is a non-fatal, permanent condition for
    # this boot — the healthcheck (Dockerfile + core.compose.yml) probes the UI
    # port UNLESS this marker exists, so without it a legitimately-absent UI
    # would fail the healthcheck forever, marking the assistant unhealthy and
    # blocking every service behind guardian's depends_on: service_healthy.
    : > /tmp/openpalm-ui-skip
    return 0
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
  node -e '
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
  # No host OP_HOME is injected; the ONLY credential the child receives is the
  # UI login password resolved above (session auth — not a host:* capability).
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
      start_ts="$(node -e 'process.stdout.write(String(Date.now()))')"
      local exit_code
      # Recomputed each iteration (cheap; OP_VOICE_LAN_ACCESS never changes
      # mid-boot) so a respawn always reflects the same posture the container
      # was started with — see the block comment above for what each branch means.
      local voice_env_args=(OP_UI_NO_LOCAL_VOICE=1)
      if voice_lan_access_enabled; then
        voice_env_args=(OP_VOICE_URL=http://voice:8880)
      fi
      if env -u OP_ENABLE_ADMIN -u OP_INSIDE_ELECTRON \
           HOST=0.0.0.0 PORT="$ui_port" HOST_HEADER=host PROTOCOL_HEADER=x-forwarded-proto \
           "${voice_env_args[@]}" \
           OP_UI_SERVED_IN_CONTAINER=1 \
           OP_OPENCODE_URL=http://localhost:4096 \
           OP_UI_LOGIN_PASSWORD="$ui_login_password" \
           node "$ui_index"; then
        exit_code=0
      else
        exit_code=$?
      fi
      local end_ts
      end_ts="$(node -e 'process.stdout.write(String(Date.now()))')"
      if [ "$((end_ts - start_ts))" -ge "$healthy_uptime_ms" ]; then
        attempt=0
      fi
      attempt=$((attempt + 1))
      if [ "$attempt" -ge "$max_attempts" ]; then
        echo "ERROR: UI co-process exited $attempt times (last exit $exit_code); giving up on respawn. The published UI port now serves nothing — this container is reporting UNHEALTHY on purpose." >&2
        # Deliberately NO skip marker here. The marker exists for a
        # legitimately-absent build (an image without the UI), which is a real
        # configuration. A UI that crash-looped to exhaustion is the opposite: it
        # is the ONE port a home install publishes, and it is dead. Writing the
        # marker made the healthcheck stop probing it, so the container went
        # green over a dead front door — precisely the state the UI probe was
        # added to prevent, and one Docker's restart policy cannot heal because
        # healthy containers are never restarted. Failing the healthcheck makes
        # it visible in `docker ps` and in the host UI's own status.
        break
      fi
      echo "warning: UI co-process exited (code $exit_code) — restarting in ${delay}s (attempt $((attempt + 1))/${max_attempts})" >&2
      sleep "$delay"
      delay=$((delay * 2))
      if [ "$delay" -gt "$max_delay" ]; then delay=$max_delay; fi
    done
  ) &

  echo "entrypoint: UI co-process supervisor PID $! started" >&2
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

prepare_crontab_wrapper() {
  local spool_dir="/tmp/openpalm-crontabs"
  local wrapper_dir="/tmp/openpalm-bin"
  local crontab_wrapper="${wrapper_dir}/crontab"
  mkdir -p "$spool_dir" "$wrapper_dir"
  install -m 755 /dev/null "$crontab_wrapper"
  # The single-quoted format must leave $@ unescaped for the generated wrapper.
  printf '#!/usr/bin/env sh\nexec busybox crontab -c %s "$@"\n' "$spool_dir" > "$crontab_wrapper"
  case ":$PATH:" in
    *":$wrapper_dir:"*) ;;
    *) export PATH="$wrapper_dir:$PATH" ;;
  esac
}

run_akm_schema_migration() {
  if ! command -v akm >/dev/null 2>&1; then return 0; fi

  local config_file="${AKM_CONFIG_DIR:-/etc/akm}/config.json"
  local target_file="${AKM_STATE_DIR:-/opt/akm/state}/openpalm-0.9-target.json"
  local blocked_file="${AKM_STATE_DIR:-/opt/akm/state}/openpalm-0.9-blocked-version"
  local akm_version=""
  akm_version="$(run_akm_command akm --version)"
  if [ -f "$blocked_file" ] && [ "$(<"$blocked_file")" = "$akm_version" ]; then
    echo "error: akm $akm_version migration previously failed and was restored; install a newer AKM release before retrying" >&2
    return 78
  fi
  local config_version=""
  local migration_backup_run=""
  restore_failed_akm_migration() {
    [ -n "$migration_backup_run" ] || return 0
    command -v akm-migrate >/dev/null 2>&1 || return 0
    echo "entrypoint: restoring failed akm migration run $migration_backup_run..." >&2
    if run_akm_command akm-migrate restore --for 0.9.0 --run "$migration_backup_run" --confirm >&2; then
      printf '%s\n' "$akm_version" > "$blocked_file"
      echo "entrypoint: akm migration restored; blocked further retries with $akm_version" >&2
    else
      echo "error: akm migration restore failed; manual recovery is required" >&2
    fi
  }
  if [ -f "$config_file" ]; then
    config_version="$(node -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).configVersion || "") } catch {}' "$config_file")"
  fi

  if [ -f "$config_file" ] && [ "$config_version" != "0.9.0" ]; then
    if [ -z "$config_version" ]; then
      # OpenPalm's 0.8 writer emitted the native shape but did not stamp the
      # version itself. AKM 0.8 normally added it on first load; preserve a
      # separate exact snapshot for a never-started home before adding only the
      # missing sentinel that makes the official migrator classify it as old.
      local preflight_backup="${AKM_STATE_DIR:-/opt/akm/state}/openpalm-pre-0.9-missing-version"
      if [ ! -d "$preflight_backup" ]; then
        mkdir -m 700 -p "$preflight_backup"
        cp -a "$config_file" "$preflight_backup/config.json"
        local artifact
        for artifact in state.db state.db-wal state.db-shm workflow.db workflow.db-wal workflow.db-shm; do
          if [ -f "${AKM_DATA_DIR:-/opt/akm/data}/$artifact" ]; then
            cp -a "${AKM_DATA_DIR:-/opt/akm/data}/$artifact" "$preflight_backup/$artifact"
          fi
        done
      fi
      node -e '
        const fs = require("fs");
        const file = process.argv[1];
        const config = JSON.parse(fs.readFileSync(file, "utf8"));
        if (config.configVersion !== undefined) process.exit(0);
        config.configVersion = "0.8.0";
        const temp = `${file}.openpalm-09.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temp, file);
      ' "$config_file"
      config_version="0.8.0"
    fi
    echo "entrypoint: preparing akm 0.8 to 0.9 migration..." >&2
    node /usr/local/lib/openpalm/prepare-akm-09-config.mjs "$config_file" "$target_file"
    run_akm_command akm migrate status --config "$target_file" >&2
    run_akm_command akm migrate apply --config "$target_file" --dry-run >&2
    local apply_output=""
    apply_output="$(run_akm_command akm migrate apply --config "$target_file")"
    printf '%s\n' "$apply_output" >&2
    migration_backup_run="$(node -e '
      try {
        const value = JSON.parse(process.argv[1]);
        if (typeof value.backupRunId === "string") process.stdout.write(value.backupRunId);
      } catch {}
    ' "$apply_output")"
    if command -v akm-migrate >/dev/null 2>&1; then
      if ! run_akm_command akm-migrate storage --from 0.8 --yes >&2; then
        restore_failed_akm_migration
        return 78
      fi
    fi
    prepare_crontab_wrapper
    if ! run_akm_command akm task sync --rebind >&2; then
      restore_failed_akm_migration
      return 78
    fi
    if ! run_akm_command akm index >&2; then
      restore_failed_akm_migration
      return 78
    fi
  fi

  echo "entrypoint: checking akm health..." >&2
  local rc=0
  run_akm_command akm health >&2 || rc=$?
  if [ "$rc" = "0" ] || [ "$rc" = "4" ]; then
    echo "entrypoint: akm health check complete (exit $rc)" >&2
  else
    echo "error: akm health check failed (exit $rc)" >&2
    restore_failed_akm_migration
    return "$rc"
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
  local spool_dir="/tmp/openpalm-crontabs"
  local wrapper_dir="/tmp/openpalm-bin"
  local crontab_wrapper="${wrapper_dir}/crontab"
  local existing_crontab=""
  local preserved_crontab=""
  prepare_crontab_wrapper
  # Derive the cron PATH from the boot-time PATH (wrapper dir already first,
  # exported above) so scheduled tasks see the same tools as interactive
  # sessions — a hardcoded subset silently dropped the tool venv
  # (/opt/assistant-tools/bin for apprise) and broke the `notify` skill under
  # cron (#551). Belt-and-braces: re-append the venv dir in case a
  # login-shell /etc/profile reset removed it from PATH.
  local cron_path="$PATH"
  local extra_dir
  for extra_dir in /opt/assistant-tools/bin; do
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
  for var in HOME AKM_BUNDLE_DIR AKM_CONFIG_DIR AKM_CACHE_DIR AKM_DATA_DIR AKM_STATE_DIR \
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

  # Sync automation tasks from the akm bundle into cron, then start cron.
  local tasks_dir="${AKM_BUNDLE_DIR:-/stash}/tasks"
  if command -v akm >/dev/null 2>&1 && [ -d "$tasks_dir" ]; then
    if ! run_akm_command akm task sync >&2; then
      echo "warning: initial akm task sync failed; continuing startup" >&2
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
        if ! run_akm_command akm task sync >&2; then
          echo "warning: background akm task sync failed; retrying in 60s" >&2
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

  # No --cors grant. The browser reaches OpenCode through the UI's OWN
  # same-origin /oc proxy (packages/ui routes/oc), so it never makes a
  # cross-origin request here and there is no origin to allow. This replaced an
  # allowlist the container could not compute: only the HOST can enumerate its
  # LAN addresses, so the correct origins had to be resolved host-side and
  # injected — and getting them wrong surfaced as a bare network error.

  exec "${cmd[@]}"
}

ensure_home_layout
maybe_prepare_nss_wrapper
seed_default_agents_md
run_akm_schema_migration
start_cron_and_sync_tasks
resolve_opencode_server_password
start_ui
start_opencode
