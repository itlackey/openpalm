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

unexpected_root_dockerfile_helpers=$(grep -RInE '\b(gosu|usermod|groupmod)\b' containers \
  --include='Dockerfile' \
  | grep -vE '^containers/assistant/Dockerfile:' || true)
if [ -n "$unexpected_root_dockerfile_helpers" ]; then
  echo "::error::Dockerfile root-only helper commands are only allowed in the temporary assistant/guardian exceptions"
  printf '%s\n' "$unexpected_root_dockerfile_helpers"
  errors=$((errors + 1))
fi

unexpected_root_entrypoint_helpers=$(grep -RInE '\b(gosu|usermod|groupmod|chown|chmod)\b' containers \
  --include='*.sh' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' \
  | grep -vE '^containers/assistant/entrypoint\.sh:' || true)
if [ -n "$unexpected_root_entrypoint_helpers" ]; then
  echo "::error::Entrypoint root-only ownership helper commands are only allowed in the temporary assistant/guardian exceptions"
  printf '%s\n' "$unexpected_root_entrypoint_helpers"
  errors=$((errors + 1))
fi

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

echo "Rootless guardrails intact for the services that are already expected to stay non-root."
