#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

errors=0

check_final_user_non_root() {
  local file="$1"
  local service="$2"
  local user_line
  user_line=$(awk '
    /^[[:space:]]*FROM[[:space:]]+/ { user=""; next }
    /^[[:space:]]*USER[[:space:]]+/ { user=$0 }
    END { print user }
  ' "$file")
  if [ -z "$user_line" ]; then
    echo "::error file=$file::${service} Dockerfile must end with an explicit non-root USER"
    errors=$((errors + 1))
    return
  fi
  if printf '%s\n' "$user_line" | grep -Eq '^[[:space:]]*USER[[:space:]]+(root([[:space:]:]|$)|0([[:space:]:]|$))'; then
    echo "::error file=$file::${service} Dockerfile regressed to USER root"
    errors=$((errors + 1))
  fi
}

check_final_user_non_root containers/portal/Dockerfile portal
check_final_user_non_root containers/voice/Dockerfile voice
check_final_user_non_root containers/guardian/Dockerfile guardian

assistant_user_line=$(awk '
  /^[[:space:]]*FROM[[:space:]]+/ { user=""; next }
  /^[[:space:]]*USER[[:space:]]+/ { user=$0 }
  END { print user }
' containers/assistant/Dockerfile)
if ! printf '%s\n' "$assistant_user_line" | grep -Eq '^[[:space:]]*USER[[:space:]]+(root|0)$'; then
  echo "::error file=containers/assistant/Dockerfile::assistant must start as root for Debian cron"
  errors=$((errors + 1))
fi

# Static invariant: no container other than Assistant may use the root identity
# remap required by its standard cron daemon. Assistant uses Debian's existing
# setpriv plus usermod/groupmod; it must not add another privilege-drop helper.
#
# NOTE: we deliberately do NOT grep entrypoints for `chown`/`chmod`. That check
# policed spelling, not behavior — it never caught the ownership-mutating
# equivalents (`install -m`, `mkdir -m`, `cp --preserve`) an entrypoint can use,
# and those same builtins have legitimate non-root uses (writing a 0600 npmrc,
# a crontab wrapper). The real "no root-owned files under OP_HOME after boot"
# guarantee is enforced by scripts/rootless-ownership-smoke.sh, which boots the
# stack and fails on any root-owned bind-mount file. That behavior test is the
# guard; a static token grep would be evadable theater.
unexpected_root_dockerfile_helpers=$(grep -RInwE '(gosu|usermod|groupmod)' containers \
  --include='Dockerfile' \
  || true)
if [ -n "$unexpected_root_dockerfile_helpers" ]; then
  echo "::error::Dockerfiles must not use gosu/usermod/groupmod (root+privilege-drop re-exec is banned in rootless images)"
  printf '%s\n' "$unexpected_root_dockerfile_helpers"
  errors=$((errors + 1))
fi

unexpected_root_entrypoint_helpers=$(grep -RInwE '(gosu|usermod|groupmod)' containers \
  --include='*.sh' \
  | grep -v '^containers/assistant/entrypoint.sh:' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' \
  || true)
if [ -n "$unexpected_root_entrypoint_helpers" ]; then
  echo "::error::Entrypoints must not use gosu/usermod/groupmod (root+privilege-drop re-exec is banned in rootless containers)"
  printf '%s\n' "$unexpected_root_entrypoint_helpers"
  errors=$((errors + 1))
fi

if grep -qw gosu containers/assistant/entrypoint.sh; then
  echo "::error file=containers/assistant/entrypoint.sh::assistant must use the image-baked setpriv rather than adding gosu"
  errors=$((errors + 1))
fi
for helper in setpriv usermod groupmod; do
  if ! grep -qw "$helper" containers/assistant/entrypoint.sh; then
    echo "::error file=containers/assistant/entrypoint.sh::assistant root boundary must retain ${helper}"
    errors=$((errors + 1))
  fi
done

require_service_user_directive() {
  local service="$1"
  local file="$2"
  if ! awk -v service="$service" '
    $0 ~ "^  " service ":$" { in_service=1; next }
    in_service && $0 ~ "^  [^[:space:]]" { exit found ? 0 : 1 }
    in_service && $0 ~ "^    user: \"\\$\\{OP_UID:-1000\\}:\\$\\{OP_GID:-1000\\}\"$" { found=1 }
    END { if (in_service && found) exit 0; exit found ? 0 : 1 }
  ' "$file"; then
    echo "::error file=${file}::${service} must keep user: \"\${OP_UID:-1000}:\${OP_GID:-1000}\""
    errors=$((errors + 1))
  fi
}

for service in ollama ollama-cuda ollama-rocm voice voice-cuda voice-rocm; do
  require_service_user_directive "$service" packages/skeleton/system/stack/services.compose.yml
done

if awk '
  $0 ~ "^  assistant:$" { in_service=1; next }
  in_service && $0 ~ "^  [^[:space:]]" { exit found ? 0 : 1 }
  in_service && $0 ~ "^    user:" { found=1 }
  END { exit found ? 0 : 1 }
' packages/skeleton/system/stack/core.compose.yml; then
  echo "::error file=packages/skeleton/system/stack/core.compose.yml::assistant must not override the image root startup user"
  errors=$((errors + 1))
fi

for service in discord slack; do
  require_service_user_directive "$service" packages/skeleton/system/stack/portals.compose.yml
done

require_service_user_directive guardian packages/skeleton/system/stack/portals.compose.yml

portal_root_user_overrides=$(awk '
  $0 ~ "^  (discord|slack):$" { service=$1; gsub(":", "", service); in_service=1; next }
  in_service && $0 ~ "^  [^[:space:]]" { in_service=0; next }
  in_service && $0 ~ "^    user:" { print service ":" $0 }
' packages/skeleton/system/stack/portals.compose.yml | grep -E '(root|0:0|user:[[:space:]]*"0|user:[[:space:]]*0($|[[:space:]])|user:[[:space:]]*"root)' || true)
if [ -n "$portal_root_user_overrides" ]; then
  echo "::error file=packages/skeleton/system/stack/portals.compose.yml::portal adapters must not override runtime user to root"
  printf '%s\n' "$portal_root_user_overrides"
  errors=$((errors + 1))
fi

if [ "$errors" -gt 0 ]; then
  echo "::error::rootless guardrail check failed ($errors violation(s))"
  exit 1
fi

echo "Rootless guardrails intact; only Assistant's cron supervisor starts as root."
