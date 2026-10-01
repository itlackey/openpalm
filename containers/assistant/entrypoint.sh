#!/usr/bin/env bash
set -euo pipefail

readonly OPENCODE_PORT="${OPENCODE_PORT:-4096}"
readonly TASK_SPOOL_DIR=/tmp/openpalm-crontabs
readonly TASK_BIN_DIR=/tmp/openpalm-bin
readonly TASK_CRONTAB="$TASK_SPOOL_DIR/openpalm"
readonly RUNTIME_DIR=/tmp/openpalm-runtime

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

  # Native installers ran during the image build. Seed their generated caches,
  # never account files, trust decisions, or existing operator configuration.
  mkdir -p /home/opencode/.codex/plugins/cache /home/opencode/.claude/plugins
  cp -R -n /native-defaults/codex/plugins/cache/. /home/opencode/.codex/plugins/cache/
  cp -R -n /native-defaults/claude/plugins/cache/. /home/opencode/.claude/plugins/cache/
  for file in claude/settings.json claude/plugins/installed_plugins.json claude/plugins/known_marketplaces.json codex/config.toml; do
    local source="/native-defaults/$file" target="/home/opencode/.$file" previous="/home/opencode/.openpalm-native-defaults/$file"
    # Refresh only untouched generated defaults. Native user settings, installed
    # plugins, authentication and hook trust always take precedence.
    if [ ! -e "$target" ] || { [ -f "$previous" ] && cmp -s "$target" "$previous"; }; then
      cp "$source" "$target"
      mkdir -p "$(dirname "$previous")"
      cp "$source" "$previous"
    fi
  done

  for required in \
    opencode.jsonc \
    AGENTS.md \
    agents/remote.md \
    agents/remote-read.md \
    agents/remote-full.md \
    agents/scheduled.md \
    agents/memory.md \
    lib/memory.js \
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
  for name in TZ HOME AKM_BUNDLE_DIR AKM_CONFIG_DIR AKM_CACHE_DIR AKM_DATA_DIR AKM_STATE_DIR OPENCODE_API_URL OPENCODE_CONFIG_DIR; do
      if [ -n "${!name:-}" ]; then printf '%s=%s\n' "$name" "${!name}"; fi
    done
  } >"$file"
}

sync_tasks() {
  if akm task sync --rebind >&2; then
    date +%s >"$RUNTIME_DIR/tasks-synced"
  else
    rm -f "$RUNTIME_DIR/tasks-synced"
    echo 'assistant: task sync failed; health is degraded until schedules reconcile' >&2
    return 1
  fi
}

start_scheduler() {
  install_crontab_shim
  write_cron_environment
  sync_tasks || true
  supercronic -inotify "$TASK_CRONTAB" &
  scheduler_pid=$!
  printf '%s\n' "$scheduler_pid" >"$RUNTIME_DIR/scheduler.pid"
  (
    while sleep 60; do sync_tasks || true; done
  ) &
  reconciliation_pid=$!
  printf '%s\n' "$reconciliation_pid" >"$RUNTIME_DIR/reconciliation.pid"
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
mkdir -p "$RUNTIME_DIR"
start_scheduler

cd /work
opencode serve \
  --hostname 0.0.0.0 \
  --port "$OPENCODE_PORT" \
  --print-logs \
  --log-level "${OPENCODE_LOG_LEVEL:-INFO}" &
assistant_pid=$!
printf '%s\n' "$assistant_pid" >"$RUNTIME_DIR/assistant.pid"

remote_pids=()
for tool in codex claude; do
  variable="OPENPALM_${tool^^}_REMOTE"
  case "${!variable:-0}" in
    0) ;;
    1) openpalm-remote "$tool" & remote_pids+=("$!") ;;
    *) echo "assistant: $variable must be 0 or 1" >&2; exit 1 ;;
  esac
done

stop_children() {
  trap - TERM INT
  kill "$assistant_pid" "$scheduler_pid" "$reconciliation_pid" "${remote_pids[@]}" 2>/dev/null || true
  wait "$assistant_pid" "$scheduler_pid" "$reconciliation_pid" "${remote_pids[@]}" 2>/dev/null || true
}
trap 'stop_children; exit 0' TERM INT
# Any essential child exiting stops the container. Compose restart policy
# recovers all three together; cron resumes at future slots, never replays.
status=0
wait -n "$assistant_pid" "$scheduler_pid" "$reconciliation_pid" || status=$?
echo 'assistant: an essential process stopped; restarting the stack service' >&2
stop_children
exit "${status:-1}"
