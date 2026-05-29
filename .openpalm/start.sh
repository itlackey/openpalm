#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OP_HOME="${OP_HOME:-$SCRIPT_DIR}"

if [[ ! -x "${OP_HOME}/run.sh" ]]; then
  echo "Missing generated run.sh at ${OP_HOME}/run.sh" >&2
  exit 1
fi

exec "${OP_HOME}/run.sh"
