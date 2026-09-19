#!/usr/bin/env bash
set -euo pipefail

readonly OPENCODE_PORT="${OPENCODE_PORT:-4096}"
readonly TASK_SPOOL_DIR=/tmp/openpalm-crontabs
readonly TASK_BIN_DIR=/tmp/openpalm-bin
readonly TASK_CRONTAB="$TASK_SPOOL_DIR/openpalm"

prepare_identity() {
  if getent passwd "$(id -u)" >/dev/null 2>&1; then return; fi
  local wrapper=""
  for candidate in /usr/lib/*/libnss_wrapper.so /lib/*/libnss_wrapper.so; do
    if [ -e "$candidate" ]; then wrapper="$candidate"; break; fi
  done
  if [ -z "$wrapper" ]; then
    echo "assistant: uid $(id -u) has no passwd entry and libnss-wrapper is unavailable" >&2
    exit 1
  fi
  printf 'opencode:x:%s:%s:OpenPalm Assistant:/home/opencode:/bin/bash\n' "$(id -u)" "$(id -g)" >/tmp/openpalm-passwd
  printf 'opencode:x:%s:\n' "$(id -g)" >/tmp/openpalm-group
  export NSS_WRAPPER_PASSWD=/tmp/openpalm-passwd
  export NSS_WRAPPER_GROUP=/tmp/openpalm-group
  export LD_PRELOAD="$wrapper${LD_PRELOAD:+:$LD_PRELOAD}"
}

prepare_filesystem() {
  mkdir -p \
    /home/opencode/.cache/opencode \
    /home/opencode/.config/opencode \
    /home/opencode/.local/share/opencode \
    /home/opencode/.local/state/opencode \
    /opt/akm/cache /opt/akm/data/state /stash/tasks /stash/inbox /stash/disabled-tasks /work

  for required in \
    opencode.jsonc \
    AGENTS.md \
    agents/remote.md \
    agents/remote-read.md \
    agents/remote-full.md \
    agents/scheduled.md \
    plugins/akm.js; do
    if [ ! -r "${OPENCODE_CONFIG_DIR:-/etc/opencode}/$required" ]; then
      echo "assistant: managed OpenCode config is missing $required" >&2
      exit 1
    fi
  done
  if [ ! -r /opt/openpalm/tools/node_modules/akm-opencode/dist/index.js ]; then
    echo 'assistant: image-baked AKM OpenCode plugin is missing' >&2
    exit 1
  fi
  if [ ! -x /usr/local/bin/openpalm-task ]; then
    echo 'assistant: OpenPalm task helper is missing' >&2
    exit 1
  fi
}

load_opencode_password() {
  local file="${OPENCODE_SERVER_PASSWORD_FILE:-}"
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ] && [ -n "$file" ] && [ -s "$file" ]; then
    OPENCODE_SERVER_PASSWORD="$(tr -d '\r\n' <"$file")"
    export OPENCODE_SERVER_PASSWORD
  fi
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
    echo 'assistant: refusing to start without an OpenCode server password' >&2
    exit 1
  fi
}

install_crontab_shim() {
  mkdir -p "$TASK_SPOOL_DIR" "$TASK_BIN_DIR"
  local shim="$TASK_BIN_DIR/crontab"
  cat >"$shim" <<'SHIM'
#!/usr/bin/env sh
set -eu
file="/tmp/openpalm-crontabs/openpalm"
case "${1:--}" in
  -l) cat "$file" 2>/dev/null ;;
  -r) rm -f "$file" ;;
  -) cat >"$file" ;;
  -*) echo "crontab: unsupported option: $1" >&2; exit 1 ;;
  *) cat "$1" >"$file" ;;
esac
SHIM
  chmod 0755 "$shim"
  export PATH="$TASK_BIN_DIR:$PATH"
}

write_cron_environment() {
  local file="$TASK_CRONTAB"
  {
    echo '# openpalm managed environment'
    echo 'SHELL=/bin/bash'
    echo "PATH=$PATH"
    for name in HOME AKM_BUNDLE_DIR AKM_CONFIG_DIR AKM_CACHE_DIR AKM_DATA_DIR AKM_STATE_DIR OPENCODE_API_URL OPENCODE_CONFIG_DIR; do
      if [ -n "${!name:-}" ]; then printf '%s=%s\n' "$name" "${!name}"; fi
    done
  } >"$file"
}

sync_tasks() {
  if ! akm task sync --rebind >&2; then
    echo 'assistant: task sync failed; the agent will continue without the invalid schedules' >&2
  fi
}

start_scheduler() {
  install_crontab_shim
  write_cron_environment
  sync_tasks
  supercronic -inotify "$TASK_CRONTAB" &
  (
    while sleep 60; do sync_tasks; done
  ) &
}

for binary in opencode akm supercronic; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "assistant: required binary not found: $binary" >&2
    exit 1
  fi
done

prepare_identity
prepare_filesystem
load_opencode_password
start_scheduler

cd /work
exec opencode serve \
  --hostname 0.0.0.0 \
  --port "$OPENCODE_PORT" \
  --print-logs \
  --log-level "${OPENCODE_LOG_LEVEL:-INFO}"
