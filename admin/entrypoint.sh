#!/usr/bin/env bash
set -euo pipefail
cron
exec bun run src/server.ts
