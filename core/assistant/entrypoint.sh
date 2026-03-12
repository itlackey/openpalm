#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"
TARGET_UID="${OPENPALM_UID:-1000}"
TARGET_GID="${OPENPALM_GID:-1000}"
TARGET_USER="opencode"
TARGET_GROUP="opencode"

ensure_user_mapping() {
  if ! command -v getent >/dev/null 2>&1; then
    return 0
  fi

  local existing_group
  existing_group="$(getent group "$TARGET_GID" | cut -d: -f1 || true)"
  if [ -n "$existing_group" ]; then
    TARGET_GROUP="$existing_group"
  elif [ "$(id -u)" = "0" ]; then
    groupadd --gid "$TARGET_GID" "$TARGET_GROUP" >/dev/null 2>&1 || true
  fi

  local existing_user
  existing_user="$(getent passwd "$TARGET_UID" | cut -d: -f1 || true)"
  if [ -n "$existing_user" ]; then
    TARGET_USER="$existing_user"
  elif [ "$(id -u)" = "0" ]; then
    useradd \
      --uid "$TARGET_UID" \
      --gid "$TARGET_GID" \
      --home-dir /home/opencode \
      --shell /bin/bash \
      --no-create-home \
      "$TARGET_USER" >/dev/null 2>&1 || true
  fi
}

ensure_home_layout() {
  mkdir -p \
    /home/opencode \
    /home/opencode/.cache \
    /home/opencode/.config/opencode \
    /home/opencode/.local/state/opencode \
    /home/opencode/.local/share/opencode \
    /work \
    /etc/opencode

  if [ "$(id -u)" = "0" ]; then
    chown -R "$TARGET_UID:$TARGET_GID" \
      /home/opencode \
      /work \
      /etc/opencode \
      /var/run/sshd 2>/dev/null || true
  fi
}

maybe_set_memory_user_id() {
  # Legacy fallback: accept OPENMEMORY_USER_ID from older installs
  if [ -z "${MEMORY_USER_ID:-}" ] && [ -n "${OPENMEMORY_USER_ID:-}" ]; then
    export MEMORY_USER_ID="$OPENMEMORY_USER_ID"
  fi

  if [ -n "${MEMORY_USER_ID:-}" ] && [ "${MEMORY_USER_ID}" != "default_user" ]; then
    return 0
  fi

  local inferred_user
  inferred_user=""

  if command -v getent >/dev/null 2>&1; then
    inferred_user="$(getent passwd "$TARGET_UID" | cut -d: -f1 || true)"
  fi

  if [ -z "$inferred_user" ] && command -v whoami >/dev/null 2>&1; then
    inferred_user="$(whoami 2>/dev/null || true)"
  fi

  if [ -z "$inferred_user" ]; then
    inferred_user="opencode"
  fi

  export MEMORY_USER_ID="$inferred_user"
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
    usermod -p "$(openssl passwd -6 "$(openssl rand -hex 16)")" "$TARGET_USER" 2>/dev/null || true
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
  # OpenCode v1.2.24's lmstudio provider has hardcoded base URL 127.0.0.1:1234.
  # The "providers" config key is not supported (causes ConfigInvalidError).
  # Workaround: if LMSTUDIO_BASE_URL points to a remote host, start a TCP
  # proxy from 127.0.0.1:1234 to that host so lmstudio requests reach Ollama
  # or other local LLM providers running outside the container.
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
    socat TCP-LISTEN:1234,reuseaddr,fork TCP:"${target_host}":"${target_port}" &
  fi
}

maybe_unset_unused_provider_keys() {
  # Unset LLM provider keys that are not needed for the configured provider.
  # This limits the blast radius if the assistant process is compromised —
  # only the active provider's key remains in the environment.
  # Note: docker-compose.yml cannot conditionally include keys (no template rendering
  # per architecture rules), so this mitigation is applied at the process level.
  local provider="${SYSTEM_LLM_PROVIDER:-}"
  case "$provider" in
    openai)    unset ANTHROPIC_API_KEY GROQ_API_KEY MISTRAL_API_KEY GOOGLE_API_KEY ;;
    anthropic) unset OPENAI_API_KEY GROQ_API_KEY MISTRAL_API_KEY GOOGLE_API_KEY ;;
    groq)      unset OPENAI_API_KEY ANTHROPIC_API_KEY MISTRAL_API_KEY GOOGLE_API_KEY ;;
    mistral)   unset OPENAI_API_KEY ANTHROPIC_API_KEY GROQ_API_KEY GOOGLE_API_KEY ;;
    google)    unset OPENAI_API_KEY ANTHROPIC_API_KEY GROQ_API_KEY MISTRAL_API_KEY ;;
    # ollama, lmstudio, model-runner, or unset: no cloud provider key needed
    *)         unset OPENAI_API_KEY ANTHROPIC_API_KEY GROQ_API_KEY MISTRAL_API_KEY GOOGLE_API_KEY ;;
  esac
}

start_opencode() {
  cd /work

  # Ensure bun's user-writable directories exist (set via Dockerfile ENV).
  mkdir -p "${BUN_INSTALL:-/home/opencode/.bun}/bin" \
           "${BUN_INSTALL_CACHE_DIR:-/home/opencode/.cache/bun/install}"
  if [ "$(id -u)" = "0" ]; then
    chown -R "$TARGET_UID:$TARGET_GID" \
      "${BUN_INSTALL:-/home/opencode/.bun}" \
      "${BUN_INSTALL_CACHE_DIR:-/home/opencode/.cache/bun/install}"
  fi

  # Resolve varlock for runtime secret redaction.
  # The schema is staged by admin to DATA_HOME/assistant/env-schema/
  # and mounted into the container at /etc/opencode/env-schema/.
  VARLOCK_SCHEMA="/etc/opencode/env-schema/secrets.env.schema"
  VARLOCK_CMD=""
  if command -v varlock >/dev/null 2>&1 && [ -f "$VARLOCK_SCHEMA" ]; then
    VARLOCK_CMD="varlock run --schema $VARLOCK_SCHEMA --"
  fi

  if [ "$(id -u)" = "0" ]; then
    if ! command -v gosu >/dev/null 2>&1; then
      echo "ERROR: gosu not found — cannot drop privileges. Install gosu in the Dockerfile." >&2
      exit 1
    fi
    # gosu resets HOME from /etc/passwd (UID 1000 → /home/node in node:lts).
    # OpenCode resolves user config via HOME, so we must preserve it.
    export HOME=/home/opencode
    exec gosu "$TARGET_UID:$TARGET_GID" env HOME=/home/opencode \
      $VARLOCK_CMD opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
  fi

  exec $VARLOCK_CMD opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
}

ensure_user_mapping
ensure_home_layout
maybe_set_memory_user_id
maybe_enable_ssh
maybe_proxy_lmstudio
maybe_unset_unused_provider_keys
start_opencode
