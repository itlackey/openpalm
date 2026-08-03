#!/bin/bash
set -euo pipefail
umask 077

AKM_BIN="/usr/local/bin/akm"
AKM_MIGRATE_BIN="/usr/local/bin/akm-migrate"
NODE_BIN="/usr/local/bin/node"
ENTRYPOINT_BIN="/usr/local/bin/opencode-entrypoint.sh"
PREPARE_CONFIG_BIN="/usr/local/lib/openpalm/prepare-akm-09-config.mjs"
AKM_USER_ENV_FILE="/stash/env/user.env"
MIGRATION_TARGET_VERSION="0.9.0"
MIGRATION_PHASE_FILE="${AKM_STATE_DIR:-/opt/akm/state}/openpalm-0.9-migration-phase"
MIGRATION_FATAL_RC=78
MIGRATION_PHASE=""
MIGRATION_PHASE_AKM_VERSION=""

require_assistant_identity() {
  if [ "$EUID" -eq 0 ] || [ "$(id -un)" != "node" ]; then
    echo "ERROR: the AKM 0.9 migration must run as the configured node account." >&2
    return 70
  fi
}

run_akm_command() {
  /usr/bin/env -u OPENCODE_SERVER_PASSWORD HOME="${HOME:-/home/opencode}" "$@"
}

write_atomic_text() {
  local file="$1"
  local content="$2"
  "$NODE_BIN" -e '
    const crypto = require("crypto");
    const fs = require("fs");
    const path = require("path");
    const [file, content] = process.argv.slice(1);
    const dir = path.dirname(file);
    const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temp, "wx", 0o600);
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, content, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temp, file);
      const dirDescriptor = fs.openSync(dir, "r");
      try { fs.fsyncSync(dirDescriptor); } finally { fs.closeSync(dirDescriptor); }
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.rmSync(temp, { force: true }); } catch {}
      throw error;
    }
  ' "$file" "$content"
}

sync_durable_file() {
  local file="$1"
  "$NODE_BIN" -e '
    const fs = require("fs");
    const path = require("path");
    const file = process.argv[1];
    const descriptor = fs.openSync(file, "r+");
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const dirDescriptor = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dirDescriptor); } finally { fs.closeSync(dirDescriptor); }
  ' "$file"
}

write_migration_phase() {
  local phase="$1"
  local akm_version="$2"
  case "$phase" in
    apply|post-apply|complete) ;;
    *) return 64 ;;
  esac
  [[ "$akm_version" =~ ^[A-Za-z0-9._+-]+$ ]] || return 64
  write_atomic_text "$MIGRATION_PHASE_FILE" \
    "1|${MIGRATION_TARGET_VERSION}|${phase}|${akm_version}"$'\n'
}

load_migration_phase() {
  MIGRATION_PHASE=""
  MIGRATION_PHASE_AKM_VERSION=""
  [ -e "$MIGRATION_PHASE_FILE" ] || return 1

  local lines=()
  if ! mapfile -t lines < "$MIGRATION_PHASE_FILE"; then
    echo "error: cannot read OpenPalm AKM migration phase marker" >&2
    return "$MIGRATION_FATAL_RC"
  fi
  if [ "${#lines[@]}" -ne 1 ]; then
    echo "error: invalid OpenPalm AKM migration phase marker" >&2
    return "$MIGRATION_FATAL_RC"
  fi
  local pattern='^1\|0\.9\.0\|(apply|post-apply|complete)\|([A-Za-z0-9._+-]+)$'
  if [[ ! "${lines[0]}" =~ $pattern ]]; then
    echo "error: invalid OpenPalm AKM migration phase marker" >&2
    return "$MIGRATION_FATAL_RC"
  fi

  MIGRATION_PHASE="${BASH_REMATCH[1]}"
  MIGRATION_PHASE_AKM_VERSION="${BASH_REMATCH[2]}"
  return 0
}

migration_phase_decision() {
  local marker_present="$1"
  local phase="$2"
  local config_present="$3"
  local config_version="$4"
  if [ "$marker_present" = "1" ]; then
    case "$phase" in
      post-apply|complete)
        if [ "$config_present" != "1" ]; then
          echo "error: persisted AKM migration phase $phase requires a live $MIGRATION_TARGET_VERSION config" >&2
          return "$MIGRATION_FATAL_RC"
        fi
        case "$config_version" in
          "$MIGRATION_TARGET_VERSION") printf '%s\n' "$phase" ;;
          ""|0.8.0) printf '%s\n' start ;;
          *)
            echo "error: persisted AKM migration phase $phase has invalid live config version $config_version" >&2
            return "$MIGRATION_FATAL_RC"
            ;;
        esac
        ;;
      apply) printf '%s\n' "$phase" ;;
      *) return 64 ;;
    esac
  elif [ "$config_present" = "1" ] && [ "$config_version" != "$MIGRATION_TARGET_VERSION" ]; then
    printf '%s\n' start
  else
    printf '%s\n' native
  fi
}

read_config_version() {
  local config_file="$1"
  if [ ! -f "$config_file" ]; then return 0; fi
  "$NODE_BIN" -e '
    const fs = require("fs");
    const file = process.argv[1];
    let config;
    try {
      config = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      console.error(`error: cannot parse live AKM config ${file}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(78);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      console.error(`error: live AKM config ${file} must be a JSON object`);
      process.exit(78);
    }
    const version = config.configVersion;
    if (version === undefined) process.exit(0);
    if (typeof version !== "string" || version.length === 0) {
      console.error(`error: live AKM config ${file} has an invalid configVersion`);
      process.exit(78);
    }
    process.stdout.write(version);
  ' "$config_file"
}

validate_live_config_version() {
  local config_version="$1"
  case "$config_version" in
    ""|0.8.0|0.9.0) return 0 ;;
    *)
      echo "error: unsupported live AKM config version $config_version; expected missing, 0.8.0, or 0.9.0" >&2
      return "$MIGRATION_FATAL_RC"
      ;;
  esac
}

require_current_live_config() {
  local config_file="$1"
  if [ ! -f "$config_file" ]; then
    echo "error: AKM post-apply requires a live $MIGRATION_TARGET_VERSION config; startup remains blocked" >&2
    return "$MIGRATION_FATAL_RC"
  fi

  local config_version=""
  local config_rc=0
  config_version="$(read_config_version "$config_file")" || config_rc=$?
  if [ "$config_rc" -ne 0 ]; then return "$config_rc"; fi
  if [ "$config_version" != "$MIGRATION_TARGET_VERSION" ]; then
    echo "error: AKM post-apply requires exact live config version $MIGRATION_TARGET_VERSION; got ${config_version:-missing}" >&2
    return "$MIGRATION_FATAL_RC"
  fi
}

check_akm_health() {
  echo "entrypoint: checking akm health..." >&2
  local rc=0
  run_akm_command "$AKM_BIN" health >&2 || rc=$?
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 4 ]; then
    echo "entrypoint: akm health check complete (exit $rc)" >&2
    return 0
  fi
  echo "error: akm health check failed (exit $rc)" >&2
  return "$rc"
}

# Apply can rewrite task files that AKM's recovery manifest does not cover.
# Post-apply failures therefore retain this phase and retry; they never restore.
run_post_apply_steps() {
  local migration_version="$1"
  local config_file="$2"
  local rc=0
  require_current_live_config "$config_file" || return $?
  if [ -x "$AKM_MIGRATE_BIN" ]; then
    run_akm_command "$AKM_MIGRATE_BIN" storage --from 0.8 --yes >&2 || rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "error: akm legacy storage migration failed (exit $rc); post-apply will retry on restart" >&2
      return "$rc"
    fi
  fi

  rc=0
  "$ENTRYPOINT_BIN" --sync-once --rebind || rc=$?
  if [ "$rc" -eq 2 ]; then
    echo "warning: migrated task reconciliation contains skipped tasks; fix the task files and retry without changing AKM versions" >&2
  elif [ "$rc" -ne 0 ]; then
    echo "error: migrated task reconciliation failed (exit $rc); post-apply will retry on restart" >&2
    return "$rc"
  fi

  rc=0
  run_akm_index || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "error: akm index failed (exit $rc); post-apply will retry on restart" >&2
    return "$rc"
  fi

  rc=0
  check_akm_health || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "error: akm health verification failed; post-apply will retry on restart" >&2
    return "$rc"
  fi
  require_current_live_config "$config_file" || return $?
  if ! write_migration_phase complete "$migration_version"; then
    echo "error: AKM migration completed but its completion phase could not be persisted; startup remains blocked" >&2
    return "$MIGRATION_FATAL_RC"
  fi
  return 0
}

run_akm_index() {
  if [ -f "$AKM_USER_ENV_FILE" ]; then
    run_akm_command "$AKM_BIN" env run env/user -- "$AKM_BIN" index >&2
  else
    run_akm_command "$AKM_BIN" index >&2
  fi
}

prepare_target_config() {
  local config_file="$1"
  local target_file="$2"
  "$NODE_BIN" "$PREPARE_CONFIG_BIN" "$config_file" "$target_file"
}

resume_migration_apply() {
  local config_file="$1"
  local target_file="$2"
  local migration_version="$3"
  local config_version=""
  local config_rc=0
  config_version="$(read_config_version "$config_file")" || config_rc=$?
  if [ "$config_rc" -ne 0 ]; then return "$config_rc"; fi

  local apply_rc=0
  case "$config_version" in
    0.8.0)
      prepare_target_config "$config_file" "$target_file"
      run_akm_command "$AKM_BIN" migrate apply --config "$target_file" >&2 || apply_rc=$?
      ;;
    0.9.0)
      run_akm_command "$AKM_BIN" migrate apply >&2 || apply_rc=$?
      ;;
    *)
      echo "error: pending AKM migration apply requires an exact 0.8.0 or 0.9.0 live config" >&2
      return "$MIGRATION_FATAL_RC"
      ;;
  esac
  if [ "$apply_rc" -ne 0 ]; then
    echo "error: akm migration apply did not complete (exit $apply_rc); the pending phase will resume on restart" >&2
    return "$apply_rc"
  fi

  if ! write_migration_phase post-apply "$migration_version"; then
    echo "error: could not persist the AKM post-apply phase; startup remains blocked" >&2
    return "$MIGRATION_FATAL_RC"
  fi
  run_post_apply_steps "$migration_version" "$config_file"
}

copy_preflight_file() {
  local source="$1"
  local destination="$2"
  local name="$3"
  if [ -L "$source" ] || [ ! -f "$source" ]; then
    echo "error: pre-0.9 preflight source $name is not a regular file; startup remains blocked" >&2
    return "$MIGRATION_FATAL_RC"
  fi
  if [ -L "$destination" ] || { [ -e "$destination" ] && [ ! -f "$destination" ]; }; then
    echo "error: pre-0.9 preflight stage $name is not a regular file; startup remains blocked" >&2
    return "$MIGRATION_FATAL_RC"
  fi
  if ! cp -p "$source" "$destination" || ! sync_durable_file "$destination"; then
    echo "error: could not copy $name into the pre-0.9 preflight backup; startup remains blocked" >&2
    return "$MIGRATION_FATAL_RC"
  fi
}

ensure_missing_version_preflight_backup() {
  local config_file="$1"
  local preflight_backup="${AKM_STATE_DIR:-/opt/akm/state}/openpalm-pre-0.9-missing-version"
  local preflight_stage="${preflight_backup}.stage"
  local complete_marker="$preflight_backup/.complete"
  local artifact

  if [ -L "$preflight_backup" ]; then
    echo "error: pre-0.9 preflight backup must not be a symlink; startup remains blocked" >&2
    return "$MIGRATION_FATAL_RC"
  fi
  if [ -e "$preflight_backup" ]; then
    if [ ! -d "$preflight_backup" ] || [ -L "$preflight_backup/config.json" ] || \
      [ ! -f "$preflight_backup/config.json" ] || [ -L "$complete_marker" ] || \
      [ ! -f "$complete_marker" ] || [ "$(<"$complete_marker")" != "1|$MIGRATION_TARGET_VERSION" ]; then
      echo "error: existing pre-0.9 preflight backup is incomplete; startup remains blocked" >&2
      return "$MIGRATION_FATAL_RC"
    fi
    for artifact in state.db state.db-wal state.db-shm workflow.db workflow.db-wal workflow.db-shm; do
      if [ -L "$preflight_backup/$artifact" ] || \
        { [ -e "$preflight_backup/$artifact" ] && [ ! -f "$preflight_backup/$artifact" ]; }; then
        echo "error: existing pre-0.9 preflight backup contains invalid $artifact; startup remains blocked" >&2
        return "$MIGRATION_FATAL_RC"
      fi
    done
    return 0
  fi

  if [ -L "$preflight_stage" ] || { [ -e "$preflight_stage" ] && [ ! -d "$preflight_stage" ]; }; then
    echo "error: pre-0.9 preflight stage must be a regular directory; startup remains blocked" >&2
    return "$MIGRATION_FATAL_RC"
  fi
  if [ ! -e "$preflight_stage" ]; then
    if ! mkdir -m 700 "$preflight_stage"; then
      echo "error: could not create the pre-0.9 preflight stage; startup remains blocked" >&2
      return "$MIGRATION_FATAL_RC"
    fi
  fi
  chmod 700 "$preflight_stage"
  copy_preflight_file "$config_file" "$preflight_stage/config.json" config.json || return $?

  for artifact in state.db state.db-wal state.db-shm workflow.db workflow.db-wal workflow.db-shm; do
    local source="${AKM_DATA_DIR:-/opt/akm/data}/$artifact"
    local destination="$preflight_stage/$artifact"
    if [ -L "$source" ] || { [ -e "$source" ] && [ ! -f "$source" ]; }; then
      echo "error: pre-0.9 preflight source $artifact is not a regular file; startup remains blocked" >&2
      return "$MIGRATION_FATAL_RC"
    fi
    if [ -f "$source" ]; then
      copy_preflight_file "$source" "$destination" "$artifact" || return $?
    elif [ -L "$destination" ] || [ -e "$destination" ]; then
      echo "error: pre-0.9 preflight stage has stale $artifact; startup remains blocked" >&2
      return "$MIGRATION_FATAL_RC"
    fi
  done

  if [ -L "$preflight_stage/.complete" ] || \
    { [ -e "$preflight_stage/.complete" ] && [ ! -f "$preflight_stage/.complete" ]; }; then
    echo "error: pre-0.9 preflight stage completion marker is invalid; startup remains blocked" >&2
    return "$MIGRATION_FATAL_RC"
  fi
  if ! printf '1|%s\n' "$MIGRATION_TARGET_VERSION" > "$preflight_stage/.complete" || \
    ! sync_durable_file "$preflight_stage/.complete"; then
    echo "error: could not seal the pre-0.9 preflight backup; startup remains blocked" >&2
    return "$MIGRATION_FATAL_RC"
  fi
  if ! "$NODE_BIN" -e '
    const fs = require("fs");
    const path = require("path");
    const [source, target] = process.argv.slice(1);
    const sourceStat = fs.lstatSync(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      throw new Error(`Invalid preflight stage at ${source}`);
    }
    try {
      fs.lstatSync(target);
      throw new Error(`Refusing to replace existing preflight backup at ${target}`);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    fs.renameSync(source, target);
    const descriptor = fs.openSync(path.dirname(target), "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  ' "$preflight_stage" "$preflight_backup"; then
    echo "error: could not publish the pre-0.9 preflight backup; startup remains blocked" >&2
    return "$MIGRATION_FATAL_RC"
  fi
}

prepare_new_migration() {
  local config_file="$1"
  local target_file="$2"
  local akm_version="$3"
  local config_version="$4"

  case "$config_version" in
    "")
      # OpenPalm's 0.8 writer emitted the native shape without a version.
      # Preserve a separate snapshot before adding the migrator sentinel.
      ensure_missing_version_preflight_backup "$config_file"
      "$NODE_BIN" "$PREPARE_CONFIG_BIN" --stamp-missing "$config_file"
      ;;
    0.8.0) ;;
    *)
      echo "error: refusing to prepare unsupported live AKM config version $config_version" >&2
      return "$MIGRATION_FATAL_RC"
      ;;
  esac

  echo "entrypoint: preparing akm 0.8 to 0.9 migration..." >&2
  prepare_target_config "$config_file" "$target_file"
  run_akm_command "$AKM_BIN" migrate status --config "$target_file" >&2
  run_akm_command "$AKM_BIN" migrate apply --config "$target_file" --dry-run >&2
  if ! write_migration_phase apply "$akm_version"; then
    return "$MIGRATION_FATAL_RC"
  fi
  return 0
}

run_akm_09_migration() {
  require_assistant_identity
  if [ ! -x "$AKM_BIN" ]; then return 0; fi

  local config_file="${AKM_CONFIG_DIR:-/etc/akm}/config.json"
  local target_file="${AKM_STATE_DIR:-/opt/akm/state}/openpalm-0.9-target.json"
  local akm_version=""
  akm_version="$(run_akm_command "$AKM_BIN" --version)"

  local config_version=""
  local config_rc=0
  config_version="$(read_config_version "$config_file")" || config_rc=$?
  if [ "$config_rc" -ne 0 ]; then return "$config_rc"; fi
  validate_live_config_version "$config_version" || return $?
  local config_present=0
  if [ -f "$config_file" ]; then config_present=1; fi

  local marker_present=0
  local marker_rc=0
  load_migration_phase || marker_rc=$?
  if [ "$marker_rc" -eq 0 ]; then
    marker_present=1
  elif [ "$marker_rc" -ne 1 ]; then
    return "$marker_rc"
  fi
  if [ "$marker_present" -eq 1 ] && [ "$MIGRATION_PHASE" != complete ] && \
    [ "$MIGRATION_PHASE_AKM_VERSION" != "$akm_version" ]; then
    echo "error: pending AKM migration was started by $MIGRATION_PHASE_AKM_VERSION, not $akm_version; startup remains blocked" >&2
    return "$MIGRATION_FATAL_RC"
  fi

  local decision=""
  local decision_rc=0
  decision="$(migration_phase_decision "$marker_present" "$MIGRATION_PHASE" "$config_present" "$config_version")" || decision_rc=$?
  if [ "$decision_rc" -ne 0 ]; then return "$decision_rc"; fi
  case "$decision" in
    native)
      check_akm_health
      ;;
    complete)
      require_current_live_config "$config_file" || return $?
      check_akm_health
      ;;
    start)
      prepare_new_migration "$config_file" "$target_file" "$akm_version" "$config_version"
      resume_migration_apply "$config_file" "$target_file" "$akm_version"
      ;;
    apply)
      resume_migration_apply "$config_file" "$target_file" "$MIGRATION_PHASE_AKM_VERSION"
      ;;
    post-apply)
      run_post_apply_steps "$MIGRATION_PHASE_AKM_VERSION" "$config_file"
      ;;
    *)
      echo "error: unsupported OpenPalm AKM migration phase" >&2
      return "$MIGRATION_FATAL_RC"
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [ "$#" -ne 0 ]; then
    echo "error: the AKM migration helper accepts no arguments" >&2
    exit 64
  fi
  exec /usr/bin/timeout --signal=TERM --kill-after=5s 2h \
    /bin/bash -c 'source "$1"; run_akm_09_migration' _ "$0"
fi
