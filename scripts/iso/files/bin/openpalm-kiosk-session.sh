#!/usr/bin/env bash
set -euo pipefail

xset -dpms
xset s off
xset s noblank

exec chromium --kiosk --noerrdialogs --disable-infobars __OP_ADMIN_URL__
