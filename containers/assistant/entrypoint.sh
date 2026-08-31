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
    /opt/akm/data/state \
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
# keys: `run_akm_migration_check`/`persist_akm_bundle_dir_fallback` only need
# HOME/AKM_BUNDLE_DIR (already in the container's own environment), and
# `start_cron_and_sync_tasks` forwards its own small, explicit allowlist of
# vars into the crontab preamble rather than the whole file. The sanctioned,
# on-demand path for the AGENT to use a user secret is still available and
# unaffected by this change: `akm env run user -- <cmd>` (akm-cli >= 0.9.0)
# injects the values into that one tool-call subprocess for that one turn —
# never the server's top-level environment — matching the skeleton
# instructions (system/assistant/instructions/core.md).

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

# Voice LAN-access opt-in (OP_VOICE_LAN_ACCESS, core.compose.yml
# interpolation — this entrypoint has no OP_HOME and cannot read
# state/stack.env itself). Off by default: see the OP_UI_NO_LOCAL_VOICE
# comment in start_ui below for what flips when this is on.
voice_lan_access_enabled() {
  # Normalize exactly like lib's isEnabledFlag (bind-warning.ts): trim +
  # lowercase, then accept 1|true|yes. The compose overlay gate
  # (isVoiceLanAccessEnabled) uses that helper, so any spelling it accepts
  # (e.g. 'Yes', 'true ') must flip this gate too — diverging here applies
  # the network overlay while leaving the UI co-process voice-disabled.
  local value="${OP_VOICE_LAN_ACCESS:-false}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "${value,,}" in
    1|true|yes) return 0 ;;
    *) return 1 ;;
  esac
}

# Resolve OpenCode's Basic-auth password from the compose secret file.
#
# UNCONDITIONAL: there is no posture flag any more, only this file. Setup
# generates it on every install, so OpenCode is authenticated by default.
# The gate that used to live here (OPENCODE_AUTH, which
# tracked whether the assistant port was published) meant the default install
# ran OpenCode with NO password, and it had to be mirrored identically by the
# guardian, two healthchecks and the host resolver; any disagreement produced a
# 401 storm instead of an error.
#
# ensureSecrets seeds the file on first install and preserves it across
# reruns. Explicit
# OPENCODE_SERVER_PASSWORD env wins over *_FILE; trailing newlines are stripped
# by command substitution, matching every other reader of this secret.
#
# An empty result is NOT fatal. Setup generates this password on every install
# and compose always grants the file, so an empty one means someone emptied it
# on purpose — and OpenCode then serves without auth, which is what they asked
# for. Refusing to boot over it turned a local decision into a dead container,
# and the guard added to prevent that (silently re-seeding the file from under
# them) was worse. Warn, and get out of the way.
resolve_opencode_server_password() {
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ] \
     && [ -n "${OPENCODE_SERVER_PASSWORD_FILE:-}" ] && [ -s "${OPENCODE_SERVER_PASSWORD_FILE}" ]; then
    OPENCODE_SERVER_PASSWORD="$(cat "${OPENCODE_SERVER_PASSWORD_FILE}")"
    export OPENCODE_SERVER_PASSWORD
  fi
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
    echo "WARNING: no OpenCode server password resolved — OpenCode will serve UNAUTHENTICATED. Set OPENCODE_SERVER_PASSWORD, or restore the opencode_server_password compose secret." >&2
  fi
}

start_ui() {
  # Served OpenPalm UI (@openpalm/ui). The assistant container serves the
  # SvelteKit adapter-node build as a supervised co-process ALONGSIDE OpenCode,
  # and the browser reaches OpenCode through this process's own same-origin
  # /oc proxy — seeded as the one locked connection in runtime-config.json
  # below. This is THE listener a home install publishes.

  # The LAN-exposure warning that used to live here is gone with the posture
  # it warned about: it fired when OpenCode was bound off-loopback AND
  # unauthenticated, which was the DEFAULT then and is not now. Publishing the
  # port changes who can reach a password-protected server — a plain operator
  # decision, not a warning. resolve_opencode_server_password above warns on
  # the one case that still matters, an emptied secret.
  rm -f /tmp/openpalm-ui-skip

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
    echo "WARNING: no UI login password available (OP_UI_LOGIN_PASSWORD_FILE missing or empty) — the served UI will redirect to /login but no session can be minted. Run setup (or seed state/secrets/op_ui_login_password) to fix." >&2
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
      # ORIGIN pins the browser origin adapter-node reports, so an operator can
      # stop it defaulting the protocol to https on a plain-HTTP LAN install.
      # It must be a valid absolute URL or ABSENT — adapter-node's parse_origin
      # throws on anything else, INCLUDING the empty string, and it throws at
      # module load, so an unset knob would take the UI child down on every
      # boot rather than degrading. core.compose.yml passes
      # `ORIGIN: ${OP_UI_ORIGIN:-}`, which is empty until an operator sets it,
      # so the empty case is the DEFAULT one and has to be dropped here.
      local origin_env_args=()
      if [ -z "${ORIGIN:-}" ]; then
        origin_env_args=(-u ORIGIN)
      fi
      if env -u OP_ENABLE_ADMIN -u OP_INSIDE_ELECTRON "${origin_env_args[@]}" \
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

# ── akm boot status marker ──────────────────────────────────────────────────
# Every akm/cron failure below is deliberately non-fatal (#474: a migration
# hiccup must never block the assistant from starting) — and until this file
# existed, that also made it INVISIBLE: `akm migrate apply` failed with exit 70
# on every boot for a full release cycle while the healthcheck stayed green,
# because the only trace was a stderr warning no health surface reads. This
# records what actually happened so a degraded-but-up assistant can be
# reported. Degraded is a correct state; unreported is the bug.
#
# One line per step, "<step> <exit> [detail]", in boot order (migrate,
# task-sync, health, supercronic); a step that never ran is simply absent. It
# lives in /tmp so it describes THIS boot only and never persists.
AKM_BOOT_STATUS_FILE="/tmp/openpalm-akm-boot.status"

reset_akm_boot_status() {
  # Truncate once, before the first record, so a restart cannot inherit the
  # previous boot's lines.
  : > "$AKM_BOOT_STATUS_FILE" 2>/dev/null || true
}

record_akm_boot_status() {
  # Observation only: a scratch-file write must never be able to fail the boot
  # that the failures it records are themselves forbidden from failing. The
  # whole body is wrapped so a failing redirection's own `bash:` diagnostic is
  # suppressed too — `>> file 2>/dev/null` does not do that, because the
  # redirections are applied left to right and the first one aborts first.
  local step="$1" code="$2" detail="${3:-}"
  {
    # A step recorded twice in one boot (task-sync runs on the migrate path and
    # again at cron setup) keeps only the LATER record: it is the newer truth,
    # and the contract is one line per step.
    if [ -s "$AKM_BOOT_STATUS_FILE" ]; then
      grep -v "^$step " "$AKM_BOOT_STATUS_FILE" > "$AKM_BOOT_STATUS_FILE.tmp" || true
      mv "$AKM_BOOT_STATUS_FILE.tmp" "$AKM_BOOT_STATUS_FILE"
    fi
    printf '%s %s%s\n' "$step" "$code" "${detail:+ $detail}" >> "$AKM_BOOT_STATUS_FILE"
  } 2>/dev/null || true
}

run_akm_migration_check() {
  # `akm migrate` (0.9.6/0.9.7) is the task-file converter: it inspects/rewrites
  # task-v2 and task-v3 YAML under the stash to task source v4. Run the check
  # HERE — as the opencode user, with output surfaced to docker logs — so any
  # rewrite that does happen runs under the correct uid (root-owned files in
  # the bind-mounted stash are the chown-clobber class of bug) and its outcome
  # is visible instead of being swallowed by the silenced `akm task sync`
  # call below.
  # Idempotent (`migrate status` is read-only; `migrate apply` no-ops /
  # resumes to convergence) and non-fatal: a migration hiccup must never
  # block the assistant from starting. (#474)
  #
  # Exit-code contract, verified against akm-cli 0.9.6 and byte-identical in
  # 0.9.7, the 0.13.1 pin (dist/commands/
  # migrate-cli.js sets a non-zero exit code iff the combined plan status is
  # "blocked"): exit 0 covers BOTH clean plan states — "current" (nothing to
  # convert) and "ready" (files pending that `akm migrate apply` would
  # rewrite) — exit 1 is "blocked", and anything else is a crash or config
  # error. The exit code alone cannot distinguish "done" from "apply would
  # change files", so on success parse the plan's `status` field instead of
  # trusting 0. (Output defaults to JSON; no --format flag, so a flag-parsing
  # regression can never shunt a healthy status call onto the apply path.)
  if ! command -v akm >/dev/null 2>&1; then return 0; fi

  echo "entrypoint: checking akm task-file migration state (akm migrate status)..." >&2
  local status_json="" status_rc=0 plan_status=""
  status_json="$(run_akm_command akm migrate status)" || status_rc=$?
  # The plan used to stream straight to stderr; keep it in docker logs so the
  # marker line recorded below always has its evidence next to it.
  [ -z "$status_json" ] || printf '%s\n' "$status_json" >&2

  if [ "$status_rc" = "0" ]; then
    if [ -z "$status_json" ]; then
      # Exit 0 with no plan printed is the CLI's "nothing to report" shape.
      plan_status="current"
    elif command -v jq >/dev/null 2>&1; then
      # `tostring` keeps a malformed (non-string) status value on one line so
      # it cannot smuggle extra lines into the one-line-per-step marker.
      plan_status="$(printf '%s\n' "$status_json" | jq -r '(.status // "missing-status-key") | tostring' 2>/dev/null)" || plan_status="unparseable"
      [ -n "$plan_status" ] || plan_status="unparseable"
      plan_status=${plan_status//$'\n'/ }
    else
      # jq is baked into the image (Dockerfile); only reachable off-image.
      plan_status="unparseable"
    fi
    case "$plan_status" in
      current)
        echo "entrypoint: akm migration state is current" >&2
        record_akm_boot_status migrate 0 current
        ;;
      ready)
        # DESIGN DECISION: boot never runs `akm migrate apply` on a "ready"
        # plan. By boot time the only convertible files left are
        # operator-authored tasks (`retirePreV4SeededTasks` already rewrote
        # the shipped set during the upgrade, keeping `.pre-v4` copies), and
        # the 0.13.0 docs promise those files stay exactly as written until
        # the OPERATOR converts them — docs/managing-openpalm.md ("Tasks you
        # wrote yourself are left exactly as they are") and
        # docs/operations/upgrade-0.12-to-0.13.md ("Your own tasks are not
        # rewritten", which calls a `ready` status the clean post-upgrade
        # result). akm reads v2/v3 files by converting them in memory, so the
        # tasks still run; its per-read stderr warning is the deliberate
        # nudge toward an operator-initiated `akm migrate apply`. This state
        # used to be misrecorded as `migrate 0 current`, which hid why that
        # warning repeated every boot; record the real state instead.
        echo "entrypoint: akm migrate status is 'ready' — operator task files are pending conversion to task source v4. Boot leaves your files as written (by design); run 'akm migrate apply' in this container to rewrite them permanently, or convert them to version: 4 by hand (docs/managing-openpalm.md, Automations)." >&2
        record_akm_boot_status migrate 0 "ready operator-apply-pending"
        ;;
      *)
        # Exit 0 promises current-or-ready; anything else here is a violated
        # contract ("blocked" with exit 0, garbage output, a missing key).
        # Record it verbatim rather than laundering it into "current", and
        # touch nothing.
        echo "entrypoint: akm migrate status exited 0 with unexpected plan status '$plan_status'; leaving task files untouched" >&2
        record_akm_boot_status migrate 0 "$plan_status"
        ;;
    esac
  else
    # Non-zero: exit 1 is a "blocked" plan — some file akm refuses to convert
    # deterministically. Apply is all-or-nothing (akm 0.9.x) and will fail
    # loudly here, which is correct: a blocked file means one operator task is
    # silently unscheduled, and `migrate 1 apply-failed` is what surfaces that
    # as a degraded boot. Any other code is a crash or an interrupted prior
    # apply, for which the crash-resumable apply is the recovery path.
    # OpenPalm writes the 0.9-shape config itself, so no --config is needed; a
    # second apply is harmless when the first one only staged a generated
    # config. Rebind the scheduler entries afterwards so installed cron rows
    # re-capture the current binary/spelling.
    echo "entrypoint: akm migration pending — running akm migrate apply..." >&2
    local rc=0
    run_akm_command akm migrate apply >&2 || rc=$?
    if [ "$rc" != "0" ]; then
      # Reset before the retry: `|| rc=$?` only assigns when the command FAILS,
      # so without this a failed first attempt followed by a successful retry
      # would leave rc holding the first attempt's code — reporting a migrated,
      # working akm as a failure.
      rc=0
      run_akm_command akm migrate apply >&2 || rc=$?
    fi
    if [ "$rc" = "0" ]; then
      echo "entrypoint: akm migrate apply complete" >&2
      record_akm_boot_status migrate 0 applied
      local rebind_rc=0
      run_akm_command akm task sync --rebind >&2 || rebind_rc=$?
      if [ "$rebind_rc" != "0" ]; then
        echo "warning: akm task sync --rebind failed after migration; continuing" >&2
      fi
      record_akm_boot_status task-sync "$rebind_rc"
    else
      echo "warning: akm migrate apply failed (exit $rc); akm commands may fail until it succeeds — continuing startup" >&2
      record_akm_boot_status migrate "$rc" apply-failed
    fi
  fi

  # Health probe (0 = ok, 4 = health warn) — surfaces db problems loudly at
  # boot without blocking startup. Both streams are captured and re-printed
  # (akm's ok:false envelope goes to stderr), so the one failure with a canned
  # in-image remedy can be recognized below instead of scrolling by unnamed.
  local health_out="" hrc=0
  health_out="$(run_akm_command akm health 2>&1)" || hrc=$?
  [ -z "$health_out" ] || printf '%s\n' "$health_out" >&2
  if [ "$hrc" = "0" ] || [ "$hrc" = "4" ]; then
    echo "entrypoint: akm health check complete (exit $hrc)" >&2
    record_akm_boot_status health "$hrc"
  else
    echo "warning: akm health check failed (exit $hrc); continuing startup" >&2
    if printf '%s\n' "$health_out" | grep -qF 'Run `akm upgrade --force`'; then
      # akm is refusing to open state.db until its historical-destructive
      # schema cutover is applied deliberately (exit 78; every state.db
      # surface — events, proposals, task history, improve ledgers, workflow
      # runs — is down until then). The advice inside akm's message does NOT
      # work in this container: `akm upgrade` is the package self-updater
      # (GitHub egress + `npm install -g`, both off-limits in an image-baked
      # install), and it only reaches the state step after a successful
      # package install. The working remedy is the image-pinned helper, which
      # drives akm's own safety-copied cutover directly.
      # DESIGN DECISION: boot only reports this state, it never applies it.
      # akm reserves this migration class for explicit intent — a boot that
      # granted that intent automatically would extend it to every FUTURE
      # destructive migration an image bump ships, sight unseen. OpenPalm
      # keeps the intent operator-shaped, exactly like the operator task-file
      # rule in the `ready` branch above.
      echo "entrypoint: akm's state.db is waiting for its one-time deliberate schema cutover — run 'openpalm-akm-state-upgrade' in this container to apply it (a verified sibling safety copy is created first; see docs/operations/upgrade-0.12-to-0.13.md)" >&2
      record_akm_boot_status health "$hrc" state-upgrade-pending
    else
      record_akm_boot_status health "$hrc"
    fi
  fi
}

persist_akm_bundle_dir_fallback() {
  # Defense-in-depth for scheduled tasks (#552): cron jobs normally receive
  # AKM_BUNDLE_DIR / AKM_CONFIG_DIR / HOME from the managed crontab preamble.
  # If an external crontab rewrite drops that preamble, akm falls back to
  # $HOME/.config/akm/config.json — which never existed — so every akm-based
  # task fails with "no bundle directory found" while still exiting 0.
  # Persist the primary bundle into the config locations akm can resolve
  # WITHOUT the forwarded env so a lost preamble degrades gracefully instead
  # of silently breaking every automation. akm >= 0.9.0 shape: a `bundles`
  # map + `defaultBundle` (the retired flat `stashDir` key is hard-rejected),
  # and any present config file must carry configVersion "0.9.0".
  if ! command -v akm >/dev/null 2>&1; then return 0; fi
  local bundle_dir="${AKM_BUNDLE_DIR:-/stash}"
  [ -d "$bundle_dir" ] || return 0

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
      # Merge the primary bundle into an existing config, dropping only the
      # retired 0.8 keys akm 0.9.0 refuses to load. A corrupt or
      # already-populated file is left alone — never destroy operator config
      # from the entrypoint.
      node -e '
        const fs = require("fs");
        const [file, bundleDir] = process.argv.slice(1);
        let cfg;
        try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || cfg.bundles) process.exit(0);
        // 0.12.x upgrade path: strip the retired akm 0.8 keys (same list as
        // lib RETIRED_AKM_CONFIG_KEYS in setup.ts) — akm 0.9.0 hard-rejects a
        // config that still carries any of them, so leaving them would turn an
        // old-but-migratable config into one akm classifies as corrupt.
        for (const key of ["stashDir", "sources", "installed", "wikiName", "profiles", "llm", "agent", "features", "stashes"]) delete cfg[key];
        if (cfg.defaults && typeof cfg.defaults === "object") {
          delete cfg.defaults.llm;
          delete cfg.defaults.agent;
          delete cfg.defaults.improve;
        }
        if (typeof cfg.configVersion !== "string") cfg.configVersion = "0.9.0";
        cfg.bundles = { openpalm: { path: bundleDir, writable: true } };
        cfg.defaultBundle = "openpalm";
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
        fs.renameSync(tmp, file);
      ' "$config_file" "$bundle_dir" 2>/dev/null \
        || echo "warning: could not merge bundles into $config_file; continuing" >&2
    else
      mkdir -p "$config_dir" 2>/dev/null || continue
      # JSON-escape backslashes and double quotes so an unusual bundle path
      # cannot produce an invalid config.json (which would re-break bundle
      # resolution under cron — the exact failure this fallback guards against).
      local bundle_dir_json="${bundle_dir//\\/\\\\}"
      bundle_dir_json="${bundle_dir_json//\"/\\\"}"
      printf '{\n  "configVersion": "0.9.0",\n  "bundles": {\n    "openpalm": { "path": "%s", "writable": true }\n  },\n  "defaultBundle": "openpalm"\n}\n' "$bundle_dir_json" > "$config_file" 2>/dev/null \
        || echo "warning: could not write bundle fallback to $config_file; continuing" >&2
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
  # This shim used to `exec busybox crontab -c "$spool_dir" "$@"`, which could
  # never work here: busybox's crontab applet checks that it is root (or suid)
  # BEFORE it honours -c, and this container runs as an unprivileged uid. Every
  # invocation died with "crontab: must be suid to work properly" — including
  # the two below, whose `2>/dev/null || true` hid it at boot. The visible
  # symptom was the akm re-sync loop failing every 60s forever while the spool
  # dir stayed empty, so no scheduled automation ran at all.
  #
  # `crond -c` reads plain crontab FILES out of the spool dir, so the shim
  # writes that file directly and skips the applet (and its root check).
  {
    printf '#!/usr/bin/env sh\nf=%s/$(id -un)\n' "$spool_dir"
    cat <<'CRONTAB_SHIM'
case "${1:--}" in
  -l) cat "$f" 2>/dev/null; exit 0 ;;
  -r) rm -f "$f" ;;
  -)  cat > "$f" ;;
  -*) echo "crontab: unsupported option: $1" >&2; exit 1 ;;
  *)  cat "$1" > "$f" ;;
esac
CRONTAB_SHIM
  } > "$crontab_wrapper"
  export PATH="$wrapper_dir:$PATH"
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

  # Forward selected env vars into cron jobs. Plain `NAME=value` — the crontab
  # env-assignment syntax. These were written as `export NAME="value"`, which
  # is shell, not crontab: supercronic rejects the file outright and busybox
  # crond never applied them, so jobs ran without this env either way.
  for var in HOME AKM_BUNDLE_DIR AKM_CONFIG_DIR AKM_CACHE_DIR AKM_DATA_DIR \
             AKM_STATE_DIR OPENCODE_API_URL OPENCODE_CONFIG_DIR; do
    if [ -n "${!var:-}" ]; then
      echo "$var=${!var}" >> "$crontab_file"
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
  # writes task blocks into the same per-user crontab. No `2>/dev/null || true`:
  # silencing this is what let a shim that could never work ship unnoticed —
  # boot looked clean while nothing was ever scheduled.
  crontab "$crontab_file" || echo "warning: could not install the managed crontab preamble" >&2

  # Sync automation tasks from the akm bundle into cron, then start cron.
  local tasks_dir="${AKM_BUNDLE_DIR:-/stash}/tasks"
  if command -v akm >/dev/null 2>&1 && [ -d "$tasks_dir" ]; then
    local sync_rc=0
    run_akm_command akm task sync --rebind >&2 || sync_rc=$?
    if [ "$sync_rc" != "0" ]; then
      echo "warning: initial akm task sync failed; continuing startup" >&2
    fi
    record_akm_boot_status task-sync "$sync_rc"
  fi

  rm -f "$crontab_file"

  # supercronic runs in the foreground and reloads on write, so it is
  # backgrounded here and needs no signal plumbing: the re-sync loop below
  # rewrites the same file in place and -inotify picks it up.
  if command -v supercronic >/dev/null 2>&1; then
    supercronic -inotify "$spool_dir/$(id -un)" &
    local supercronic_pid=$!
    # `$?` after `&` is the fork status and is structurally always 0, so it
    # observes nothing. supercronic exits within milliseconds on an unparsable
    # or missing spool file — check it is still alive, otherwise a dead
    # scheduler gets recorded as running, which is the exact invisible
    # degradation this marker exists to catch.
    sleep 1
    if kill -0 "$supercronic_pid" 2>/dev/null; then
      record_akm_boot_status supercronic 0 running
    else
      echo "warning: supercronic exited immediately; scheduled automations will not run" >&2
      record_akm_boot_status supercronic 1 exited
    fi
  else
    echo "warning: supercronic not found; scheduled automations will not run" >&2
    record_akm_boot_status supercronic 127 missing
  fi

  # The background re-sync loop below deliberately records NOTHING: the marker
  # is a record of THIS BOOT, and a rolling status would let a later success
  # overwrite the boot failure this exists to catch.
  # Background re-sync loop: picks up task file changes without restart
  (
    while true; do
      sleep 60
      if command -v akm >/dev/null 2>&1 && [ -d "$tasks_dir" ]; then
        # Capture rather than stream: this runs every 60s and akm prints its
        # full JSON report plus a --rebind advisory on EVERY sync, changes or
        # not — ~1440 blobs a day drowning `openpalm logs assistant`. On
        # failure the captured output is emitted in full, so the detail that
        # made the original breakage diagnosable is not lost.
        local sync_out
        if ! sync_out="$(run_akm_command akm task sync --rebind 2>&1)"; then
          echo "warning: background akm task sync failed; retrying in 60s" >&2
          printf '%s\n' "$sync_out" >&2
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
reset_akm_boot_status
run_akm_migration_check
persist_akm_bundle_dir_fallback
start_cron_and_sync_tasks
resolve_opencode_server_password
start_ui
start_opencode
