#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"
TARGET_UID="${OP_UID:-1000}"
TARGET_GID="${OP_GID:-1000}"

maybe_adjust_uid_gid() {
  # The Dockerfile creates the "opencode" user at 1000:1000. If the host
  # user has a different UID/GID (passed via OP_UID/OP_GID), adjust here.
  if [ "$(id -u)" != "0" ]; then
    return 0
  fi

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
  # Create directories that may not exist on first run. Bind-mounted paths
  # (/home/opencode, /work) already have correct host ownership from the
  # init service — no recursive chown needed.
  mkdir -p \
    /home/opencode \
    /home/opencode/.cache \
    /home/opencode/.config/opencode \
    /home/opencode/.local/bin \
    /home/opencode/.local/state/opencode \
    /home/opencode/.local/share/opencode \
    /work

  # Root-owned directories — only create when running as root.
  # These are also created in the Dockerfile, so they exist in fresh images;
  # this handles the case where volumes shadow the image layers.
  if [ "$(id -u)" = "0" ]; then
    mkdir -p /etc/opencode /var/run/sshd
  fi
}

maybe_enable_ssh() {
  if [ "$ENABLE_SSH" != "1" ] && [ "$ENABLE_SSH" != "true" ]; then
    return 0
  fi

  mkdir -p /var/run/sshd /home/opencode/.ssh

  if [ "$(id -u)" = "0" ]; then
    chown -R "$TARGET_UID:$TARGET_GID" /home/opencode/.ssh
    chmod 755 /home/opencode
    chmod 700 /home/opencode/.ssh
  fi

  touch /home/opencode/.ssh/authorized_keys

  if [ "$(id -u)" = "0" ]; then
    chown "$TARGET_UID:$TARGET_GID" /home/opencode/.ssh/authorized_keys
    chmod 600 /home/opencode/.ssh/authorized_keys
  fi

  if command -v openssl >/dev/null 2>&1; then
    usermod -p "$(openssl passwd -6 "$(openssl rand -hex 16)")" opencode 2>/dev/null || true
  fi

  if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
    ssh-keygen -A
  fi

  /usr/sbin/sshd \
    -o PasswordAuthentication=no \
    -o PermitRootLogin=no \
    -o AuthorizedKeysFile=/home/opencode/.ssh/authorized_keys \
    -o AllowTcpForwarding=no \
    -o X11Forwarding=no \
    -o PermitTunnel=no \
    -o UsePAM=no \
    -o PubkeyAuthentication=yes \
    -o StrictModes=yes
}

maybe_proxy_lmstudio() {
  # OpenCode's lmstudio provider still ships a hardcoded base URL of
  # http://127.0.0.1:1234/v1 (verified through OpenCode 1.3.3, the version
  # pinned in this image). The "providers" config key remains unsupported
  # there — setting it triggers ConfigInvalidError at startup.
  # Workaround: if LMSTUDIO_BASE_URL points to a remote host, start a TCP
  # proxy from 127.0.0.1:1234 to that host so lmstudio requests reach Ollama
  # or other local LLM providers running outside the container.
  # TODO: drop this proxy (and `socat` from the apt-get install list in the
  # Dockerfile) once OpenCode allows runtime baseURL overrides for lmstudio.
  local base_url="${LMSTUDIO_BASE_URL:-}"
  if [ -z "$base_url" ]; then
    return 0
  fi

  # Strip scheme and /v1 path suffix to extract host:port
  local hostport
  hostport="${base_url#http://}"
  hostport="${hostport#https://}"
  hostport="${hostport%%/*}"

  # Skip if already pointing at localhost:1234 (no proxy needed)
  case "$hostport" in
    127.0.0.1:1234|localhost:1234) return 0 ;;
  esac

  local target_host="${hostport%%:*}"
  local target_port="${hostport##*:}"
  # Default to port 80 if no port specified
  if [ "$target_port" = "$target_host" ]; then
    target_port=80
  fi

  if command -v socat >/dev/null 2>&1; then
    echo "Starting LLM proxy: 127.0.0.1:1234 → ${target_host}:${target_port}"
    (while true; do
      socat TCP-LISTEN:1234,reuseaddr,fork TCP:"${target_host}":"${target_port}"
      echo "socat proxy exited, restarting in 1s..." >&2
      sleep 1
    done) &
  fi
}

SCHED_PID=""

start_scheduler_coprocess() {
  # Run the automation scheduler alongside OpenCode. The scheduler has no
  # HTTP port — it watches /openpalm/config/automations for definitions and
  # /openpalm/data/scheduler/triggers for manual-trigger sentinels. Logs
  # stream to /openpalm/logs/scheduler.log.
  #
  # OP_HOME defaults to /openpalm and is set by compose; we fall back here
  # for local Docker builds that omit it.
  local op_home="${OP_HOME:-/openpalm}"
  local scheduler_dir="/opt/scheduler"
  local log_dir="${op_home}/logs"
  local triggers_dir="${op_home}/data/scheduler/triggers"
  local scheduler_log="${log_dir}/scheduler.log"

  if [ ! -f "${scheduler_dir}/src/main.ts" ]; then
    echo "Scheduler co-process source not found at ${scheduler_dir}; skipping." >&2
    return 0
  fi

  if ! command -v bun >/dev/null 2>&1; then
    echo "Scheduler co-process requires bun; skipping." >&2
    return 0
  fi

  # Make sure the directories the scheduler depends on exist with the
  # right ownership. These are bind-mounted from the host, so they may be
  # empty on first boot.
  mkdir -p "${log_dir}" "${triggers_dir}" || true
  if [ "$(id -u)" = "0" ]; then
    chown "$TARGET_UID:$TARGET_GID" "${log_dir}" "${triggers_dir}" 2>/dev/null || true
  fi

  echo "Starting scheduler co-process (OP_HOME=${op_home})"

  # Keep the scheduler in the container's process group (no setsid) so the
  # forward_term trap below can deliver SIGTERM to it on shutdown.
  if [ "$(id -u)" = "0" ]; then
    # Drop privileges to match the assistant's runtime UID/GID.
    gosu opencode env \
      HOME=/home/opencode \
      OP_HOME="${op_home}" \
      bun run "${scheduler_dir}/src/main.ts" >>"${scheduler_log}" 2>&1 &
  else
    env OP_HOME="${op_home}" \
      bun run "${scheduler_dir}/src/main.ts" >>"${scheduler_log}" 2>&1 &
  fi
  SCHED_PID=$!
}

forward_term_to_scheduler() {
  # Forward SIGTERM from this bash supervisor to the scheduler co-process
  # and reap it. Bounded wait so a hung scheduler can't block container
  # teardown — tini will SIGKILL anything still alive after its timeout.
  if [ -n "${SCHED_PID}" ] && kill -0 "${SCHED_PID}" 2>/dev/null; then
    kill -TERM "${SCHED_PID}" 2>/dev/null || true
    wait "${SCHED_PID}" 2>/dev/null || true
  fi
}

maybe_source_akm_user_vault() {
  # Phase 2 of #388 (closes #406): user-managed env secrets now live in
  # the akm `vault:user` store at <stash>/vaults/user.env (akm-cli >= 0.8.0
  # layout). The legacy `${OP_HOME}/vault/user/user.env` compose env_file
  # has been retired — instead we ask akm for the resolved vault path and
  # source it inline so OpenCode and the scheduler co-process inherit
  # every key. Sourcing happens AFTER the gosu drop in start_opencode, so
  # the values land in the same process tree as opencode itself.
  #
  # We deliberately do NOT shell out to `akm vault run` — that would put
  # akm in the supervisor path. A static one-shot source keeps the
  # entrypoint dependency-free post-startup.
  if ! command -v akm >/dev/null 2>&1; then
    return 0
  fi
  local vault_path
  vault_path="$(akm vault path vault:user 2>/dev/null || true)"
  if [ -z "$vault_path" ] || [ ! -f "$vault_path" ]; then
    return 0
  fi
  # `set -a` exports every variable assigned by the sourced file. The .env
  # format produced by akm is plain `KEY=value` (no `export ` prefix), so
  # this is the standard way to load it without parsing line-by-line.
  set -a
  # shellcheck disable=SC1090
  . "$vault_path"
  set +a
}

maybe_unset_unused_provider_keys() {
  # Unset LLM provider keys that are not needed for the configured provider.
  # This limits the blast radius if the assistant process is compromised —
  # only the active provider's key remains in the environment.
  # Note: docker-compose.yml cannot conditionally include keys (no template rendering
  # per architecture rules), so this mitigation is applied at the process level.
  local provider="${OP_CAP_LLM_PROVIDER:-}"
  case "$provider" in
    openai)    unset ANTHROPIC_API_KEY GROQ_API_KEY MISTRAL_API_KEY GOOGLE_API_KEY ;;
    anthropic) unset OPENAI_API_KEY GROQ_API_KEY MISTRAL_API_KEY GOOGLE_API_KEY ;;
    groq)      unset OPENAI_API_KEY ANTHROPIC_API_KEY MISTRAL_API_KEY GOOGLE_API_KEY ;;
    mistral)   unset OPENAI_API_KEY ANTHROPIC_API_KEY GROQ_API_KEY GOOGLE_API_KEY ;;
    google)    unset OPENAI_API_KEY ANTHROPIC_API_KEY GROQ_API_KEY MISTRAL_API_KEY ;;
    # OpenAI-compatible providers that use OPENAI_API_KEY with a different base URL
    together|deepseek|xai) unset ANTHROPIC_API_KEY GROQ_API_KEY MISTRAL_API_KEY GOOGLE_API_KEY ;;
    # ollama, lmstudio, model-runner, or unset: no cloud provider key needed
    *)         unset OPENAI_API_KEY ANTHROPIC_API_KEY GROQ_API_KEY MISTRAL_API_KEY GOOGLE_API_KEY ;;
  esac
}

start_opencode() {
  cd /work

  # Ensure bun's user-writable directories exist (set via Dockerfile ENV).
  mkdir -p "${BUN_INSTALL:-/home/opencode/.bun}/bin" \
           "${BUN_INSTALL_CACHE_DIR:-/home/opencode/.cache/bun/install}"

  # Note: varlock-based runtime redaction was retired in #391. Secret
  # values now never reach the logger's structured `extra` payload thanks
  # to the in-process redactor in `@openpalm/lib/logger`. Bash tool output
  # still goes straight to stdout — OpenCode operators who want extra
  # redaction in tool output should rely on the akm secret store rather
  # than an LD_PRELOAD-style shell wrapper.

  # If the scheduler co-process is running we must NOT exec opencode —
  # exec replaces the bash process and discards the SIGTERM trap that
  # forwards termination to the scheduler. Instead we spawn opencode as
  # a foreground child, install the trap, and wait. tini still sees this
  # bash process as PID 1's child and forwards SIGTERM to us.
  local use_supervisor=0
  if [ -n "${SCHED_PID}" ] && kill -0 "${SCHED_PID}" 2>/dev/null; then
    use_supervisor=1
  fi

  if [ "$(id -u)" = "0" ]; then
    if ! command -v gosu >/dev/null 2>&1; then
      echo "ERROR: gosu not found — cannot drop privileges. Install gosu in the Dockerfile." >&2
      exit 1
    fi
    # Drop to the opencode user. gosu resets HOME from /etc/passwd, so we
    # must forward HOME explicitly. The user has passwordless sudo for root
    # operations; normal file I/O preserves host UID ownership.
    export HOME=/home/opencode
    if [ "$use_supervisor" = "1" ]; then
      gosu opencode env HOME=/home/opencode \
        opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs &
      local oc_pid=$!
      trap 'forward_term_to_scheduler; kill -TERM "$oc_pid" 2>/dev/null || true' TERM INT
      wait "$oc_pid"
      local oc_status=$?
      forward_term_to_scheduler
      exit "$oc_status"
    fi
    exec gosu opencode env HOME=/home/opencode \
      opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
  fi

  if [ "$use_supervisor" = "1" ]; then
    opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs &
    local oc_pid=$!
    trap 'forward_term_to_scheduler; kill -TERM "$oc_pid" 2>/dev/null || true' TERM INT
    wait "$oc_pid"
    local oc_status=$?
    forward_term_to_scheduler
    exit "$oc_status"
  fi

  exec opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
}

maybe_adjust_uid_gid
ensure_home_layout
maybe_enable_ssh
maybe_proxy_lmstudio
# Source the akm `vault:user` env file BEFORE the scheduler co-process
# starts so both OpenCode and the scheduler inherit user-managed secrets.
# This replaces the retired `${OP_HOME}/vault/user → /etc/vault` compose
# env_file (#388 / #406). Runs as root because gosu has not been invoked
# yet — root can read the 0600 vault file and re-export to children.
maybe_source_akm_user_vault
maybe_unset_unused_provider_keys
start_scheduler_coprocess
start_opencode
