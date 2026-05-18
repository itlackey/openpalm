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
  # Create directories that may not exist on first run inside bind-mounted
  # /home/opencode (which shadows whatever was baked into the Dockerfile).
  # Pre-v0.11.0 the init service chowned these; that service was removed,
  # so we chown here when running as root before gosu drops privileges.
  mkdir -p \
    /home/opencode \
    /home/opencode/.cache \
    /home/opencode/.config/opencode \
    /home/opencode/.local/bin \
    /home/opencode/.local/state/opencode \
    /home/opencode/.local/share/opencode \
    /work

  if [ "$(id -u)" = "0" ]; then
    # New dirs created above are root-owned; chown so the opencode user
    # (mapped to TARGET_UID/GID) can write into .cache and .config at runtime.
    chown "$TARGET_UID:$TARGET_GID" \
      /home/opencode \
      /home/opencode/.cache \
      /home/opencode/.config \
      /home/opencode/.config/opencode \
      /home/opencode/.local \
      /home/opencode/.local/bin \
      /home/opencode/.local/state \
      /home/opencode/.local/state/opencode \
      /home/opencode/.local/share \
      /home/opencode/.local/share/opencode \
      2>/dev/null || true

    mkdir -p /etc/opencode /var/run/sshd
  fi
}

maybe_enable_ssh() {
  if [ "$ENABLE_SSH" != "1" ] && [ "$ENABLE_SSH" != "true" ]; then
    return 0
  fi

  local is_root=0
  [ "$(id -u)" = "0" ] && is_root=1

  mkdir -p /var/run/sshd /home/opencode/.ssh
  touch /home/opencode/.ssh/authorized_keys

  if [ "$is_root" = "1" ]; then
    chown -R "$TARGET_UID:$TARGET_GID" /home/opencode/.ssh
    chmod 755 /home/opencode
    chmod 700 /home/opencode/.ssh
    chmod 600 /home/opencode/.ssh/authorized_keys

    if command -v openssl >/dev/null 2>&1; then
      usermod -p "$(openssl passwd -6 "$(openssl rand -hex 16)")" opencode 2>/dev/null || true
    fi

    if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
      ssh-keygen -A
    fi
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

maybe_configure_lmstudio_provider() {
  # OpenCode allows overriding the lmstudio provider's hardcoded baseURL via the
  # `provider` config key in opencode.json:
  #   { "provider": { "lmstudio": { "options": { "baseURL": "..." } } } }
  # Write this into the user config when LMSTUDIO_BASE_URL is set so OpenCode
  # sends lmstudio requests to the correct host (e.g. Ollama via socat was the
  # old workaround; this is the direct, supported mechanism).
  local base_url="${LMSTUDIO_BASE_URL:-}"
  if [ -z "$base_url" ]; then
    return 0
  fi

  local user_config="/home/opencode/.config/opencode/opencode.json"
  # Ensure the directory exists (ensure_home_layout creates it, but be safe).
  mkdir -p "$(dirname "$user_config")"

  # Write a minimal user config with the lmstudio baseURL override.
  # This file is regenerated on every container start — user-managed config
  # lives in the project config (/etc/opencode/opencode.jsonc), not here.
  printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "provider": {\n    "lmstudio": {\n      "options": {\n        "baseURL": "%s"\n      }\n    }\n  }\n}\n' "$base_url" > "$user_config"
  echo "lmstudio: configured baseURL → $base_url"
}

start_cron_and_sync_tasks() {
  # Register AKM markdown tasks with the OS cron daemon.
  # Tasks are markdown files at /akm/tasks/*.md (AKM_STASH_DIR).
  # Scheduling, execution, and history are delegated to `akm tasks run`.
  command -v akm >/dev/null 2>&1 || return 0

  local op_home="${OP_HOME:-/openpalm}"
  # /openpalm/logs is bind-mounted from ${OP_HOME}/state/logs — writes are persisted.
  local sync_log="/openpalm/logs/akm-tasks-sync.log"
  mkdir -p /openpalm/logs || true

  # Build the crontab env preamble. Cron jobs run in a stripped environment
  # so every variable our automations need must be listed here.
  local preamble
  preamble=$(
    printf '# openpalm-env — rebuilt at container start, do not edit\n'
    printf 'PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin\n'
    printf 'AKM_STASH_DIR=/akm\n'
    printf 'AKM_CONFIG_DIR=/etc/openpalm/akm\n'
    printf 'AKM_DATA_DIR=/akm-op/data\n'
    printf 'AKM_STATE_DIR=/akm-op/state\n'
    printf 'AKM_CACHE_DIR=/akm-cache\n'
    printf 'OP_HOME=/openpalm\n'
    printf 'OP_ASSISTANT_TOKEN=%s\n' "${OP_ASSISTANT_TOKEN:-}"
    printf 'TZ=%s\n' "${TZ:-UTC}"
    # Include all vault:user keys (LLM API keys etc.) so automation commands
    # that call external services have the keys in their environment.
    local vault_path
    vault_path="$(akm vault path vault:user 2>/dev/null || true)"
    if [ -n "$vault_path" ] && [ -f "$vault_path" ]; then
      grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$vault_path" 2>/dev/null || true
    fi
  )

  # Write preamble to crontab. `akm tasks sync` appends task entries below it.
  printf '%s\n' "$preamble" | crontab -

  # Start the cron daemon.
  cron

  # Register all stash/tasks/*.md with cron (idempotent).
  akm tasks sync >>"$sync_log" 2>&1 || true

  # Background loop: re-sync every 60 s to pick up task files written by the
  # host admin process into the shared stash/tasks/ directory.
  (while sleep 60; do akm tasks sync >>"$sync_log" 2>&1 || true; done) &
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

maybe_configure_akm() {
  # Configure akm LLM and embedding from OP_CAP_* capability vars so that
  # akm improve, distill, and semantic search use the same provider as the
  # stack. Uses SLM preferentially for akm's own LLM (lightweight operations);
  # falls back to primary LLM when SLM is not configured.
  # Provider API keys live in OpenCode's auth.json (bind-mounted into this
  # container). akm reads keys from /etc/vault/user.env (sourced above by
  # maybe_source_akm_user_vault) — never from compose-forwarded env vars.
  if ! command -v akm >/dev/null 2>&1; then
    return 0
  fi

  # Prefer SLM for akm operations (lightweight); fall back to LLM
  local llm_provider="${OP_CAP_SLM_PROVIDER:-${OP_CAP_LLM_PROVIDER:-}}"
  local llm_model="${OP_CAP_SLM_MODEL:-${OP_CAP_LLM_MODEL:-}}"
  local llm_base_url="${OP_CAP_SLM_BASE_URL:-${OP_CAP_LLM_BASE_URL:-}}"

  if [ -z "$llm_provider" ] || [ -z "$llm_model" ] || [ -z "$llm_base_url" ]; then
    return 0
  fi

  # Build OpenAI-compatible endpoint URLs from the resolved base URL
  local base_no_slash="${llm_base_url%/}"
  local llm_endpoint
  case "$base_no_slash" in
    */v1) llm_endpoint="${base_no_slash}/chat/completions" ;;
    *)    llm_endpoint="${base_no_slash}/v1/chat/completions" ;;
  esac

  # Feature toggles — propagated from stack.yml.capabilities.akm by
  # writeCapabilityVars. Unset values default to "true" to preserve the
  # pre-toggle behaviour for upgraded installs.
  local feat_fd="${OP_CAP_AKM_FEEDBACK_DISTILLATION:-true}"
  local feat_mi="${OP_CAP_AKM_MEMORY_INFERENCE:-true}"
  local feat_mc="${OP_CAP_AKM_MEMORY_CONSOLIDATION:-true}"

  local features
  features='"feedback_distillation":'"$feat_fd"',"memory_inference":'"$feat_mi"',"memory_consolidation":'"$feat_mc"

  local akm_config
  akm_config='{"llm":{"endpoint":"'"$llm_endpoint"'","model":"'"$llm_model"'","provider":"'"$llm_provider"'","features":{'"$features"'}}}'

  # Append embedding config when all required vars are present
  local emb_provider="${OP_CAP_EMBEDDINGS_PROVIDER:-}"
  local emb_model="${OP_CAP_EMBEDDINGS_MODEL:-}"
  local emb_base_url="${OP_CAP_EMBEDDINGS_BASE_URL:-}"
  local emb_dims="${OP_CAP_EMBEDDINGS_DIMS:-0}"

  if [ -n "$emb_provider" ] && [ -n "$emb_model" ] && [ -n "$emb_base_url" ] && [ "$emb_dims" != "0" ]; then
    local emb_base_no_slash="${emb_base_url%/}"
    local emb_endpoint
    case "$emb_base_no_slash" in
      */v1) emb_endpoint="${emb_base_no_slash}/embeddings" ;;
      *)    emb_endpoint="${emb_base_no_slash}/v1/embeddings" ;;
    esac
    akm_config='{"llm":{"endpoint":"'"$llm_endpoint"'","model":"'"$llm_model"'","provider":"'"$llm_provider"'","features":{'"$features"'}},"embedding":{"endpoint":"'"$emb_endpoint"'","model":"'"$emb_model"'","provider":"'"$emb_provider"'","dimension":'"$emb_dims"'}}'
  fi

  akm setup --config "$akm_config" --yes 2>/dev/null || true
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

  # Build the opencode command. If running as root, prepend gosu so we
  # drop to the opencode user. gosu resets HOME from /etc/passwd, so forward
  # HOME explicitly via env.
  local cmd=(opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs)
  if [ "$(id -u)" = "0" ]; then
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
maybe_configure_lmstudio_provider
# Source the akm `vault:user` env file before starting cron so vault keys
# land in the crontab preamble that start_cron_and_sync_tasks builds.
# Runs as root because gosu has not been invoked yet — root can read the
# 0600 vault file and re-export to children.
maybe_source_akm_user_vault
maybe_configure_akm
start_cron_and_sync_tasks
start_opencode
