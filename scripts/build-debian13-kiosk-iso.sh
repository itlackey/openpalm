#!/usr/bin/env bash
set -euo pipefail

# Build a Debian 13 (trixie) ISO that boots into a lightweight kiosk login.
# After first successful login, the user is forced to change password and then
# sees Chromium in kiosk mode pointing at the OpenPalm admin URL.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BUILD_ROOT="${BUILD_ROOT:-$REPO_ROOT/.build/debian13-kiosk}"
ISO_OUT_DIR="${ISO_OUT_DIR:-$REPO_ROOT/.build/out}"

DEBIAN_MIRROR="${DEBIAN_MIRROR:-http://deb.debian.org/debian}"
DEBIAN_SECURITY_MIRROR="${DEBIAN_SECURITY_MIRROR:-http://security.debian.org/debian-security}"
DEBIAN_SUITE="${DEBIAN_SUITE:-trixie}"
DEBIAN_ARCH="${DEBIAN_ARCH:-arm64}"
ISO_VOLUME="${ISO_VOLUME:-OPENPALM_KIOSK}"

SUPPORTED_ARCHES=('arm64' 'amd64')

KIOSK_USER="${KIOSK_USER:-operator}"
KIOSK_PASSWORD="${KIOSK_PASSWORD:-ChangeMeNow123!}"
OPENPALM_ADMIN_URL="${OPENPALM_ADMIN_URL:-http://127.0.0.1:8100}"
OPENPALM_IMAGES_TAR="${OPENPALM_IMAGES_TAR:-$REPO_ROOT/.build/image-cache/openpalm-images.tar.zst}"

required_cmds=(lb docker zstd rsync)

require_tools() {
  for cmd in "${required_cmds[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "Missing required command: $cmd" >&2
      exit 1
    fi
  done
}


normalize_arch() {
  case "$DEBIAN_ARCH" in
    arm64|aarch64) DEBIAN_ARCH='arm64' ;;
    amd64|x86_64|amd) DEBIAN_ARCH='amd64' ;;
    *)
      echo "Unsupported DEBIAN_ARCH: $DEBIAN_ARCH" >&2
      echo "Supported values: ${SUPPORTED_ARCHES[*]}" >&2
      exit 1
      ;;
  esac
}

render_livebuild_tree() {
  rm -rf "$BUILD_ROOT"
  mkdir -p "$BUILD_ROOT/config/package-lists" \
    "$BUILD_ROOT/config/includes.chroot/etc/systemd/system" \
    "$BUILD_ROOT/config/includes.chroot/usr/local/bin" \
    "$BUILD_ROOT/config/includes.chroot/usr/share/xsessions" \
    "$BUILD_ROOT/config/includes.chroot/etc/lightdm/lightdm.conf.d" \
    "$BUILD_ROOT/config/hooks/live" \
    "$BUILD_ROOT/config/includes.chroot/opt/openpalm"

  cat > "$BUILD_ROOT/config/package-lists/openpalm-kiosk.list.chroot" <<'PKGEOF'
lightdm
xserver-xorg-core
xinit
openbox
chromium
x11-xserver-utils
docker.io
docker-compose-v2
ca-certificates
curl
git
unattended-upgrades
apt-listchanges
PKGEOF

  cat > "$BUILD_ROOT/config/includes.chroot/usr/share/xsessions/openpalm-kiosk.desktop" <<'XSEOF'
[Desktop Entry]
Name=OpenPalm Kiosk
Comment=OpenPalm admin kiosk session
Exec=/usr/local/bin/openpalm-kiosk-session.sh
Type=Application
DesktopNames=OpenPalmKiosk
XSEOF

  cat > "$BUILD_ROOT/config/includes.chroot/usr/local/bin/openpalm-kiosk-session.sh" <<SESSOF
#!/usr/bin/env bash
set -euo pipefail

xset -dpms
xset s off
xset s noblank

exec chromium --kiosk --noerrdialogs --disable-infobars "$OPENPALM_ADMIN_URL"
SESSOF

  cat > "$BUILD_ROOT/config/includes.chroot/etc/lightdm/lightdm.conf.d/50-openpalm.conf" <<'LDMEOF'
[Seat:*]
user-session=openpalm-kiosk
greeter-hide-users=false
allow-guest=false
LDMEOF

  cat > "$BUILD_ROOT/config/includes.chroot/usr/local/bin/openpalm-bootstrap.sh" <<'BOOTSHEOF'
#!/usr/bin/env bash
set -euo pipefail

OPENPALM_HOME='/opt/openpalm'
export OPENPALM_CONFIG_HOME='/var/lib/openpalm/config'
export OPENPALM_STATE_HOME='/var/lib/openpalm/state'
export OPENPALM_DATA_HOME='/var/lib/openpalm/data'
export OPENPALM_WORK_DIR='/var/lib/openpalm/work'

mkdir -p "$OPENPALM_CONFIG_HOME" "$OPENPALM_STATE_HOME" "$OPENPALM_DATA_HOME" "$OPENPALM_WORK_DIR"

if [[ ! -f "$OPENPALM_CONFIG_HOME/secrets.env" ]]; then
  cp "$OPENPALM_HOME/assets/secrets.env" "$OPENPALM_CONFIG_HOME/secrets.env"
  chmod 600 "$OPENPALM_CONFIG_HOME/secrets.env"
fi

if [[ ! -f "$OPENPALM_CONFIG_HOME/Caddyfile" ]]; then
  cp "$OPENPALM_HOME/assets/Caddyfile" "$OPENPALM_CONFIG_HOME/Caddyfile"
fi

if [[ ! -f "$OPENPALM_STATE_HOME/docker-compose.yml" ]]; then
  cp "$OPENPALM_HOME/assets/docker-compose.yml" "$OPENPALM_STATE_HOME/docker-compose.yml"
fi

if [[ ! -d "$OPENPALM_CONFIG_HOME/channels" ]]; then
  mkdir -p "$OPENPALM_CONFIG_HOME/channels"
fi

if [[ -f "$OPENPALM_HOME/image-cache/openpalm-images.tar.zst" && ! -f /var/lib/openpalm/.images-loaded ]]; then
  zstd -dc "$OPENPALM_HOME/image-cache/openpalm-images.tar.zst" | docker load
  touch /var/lib/openpalm/.images-loaded
fi

cd "$OPENPALM_STATE_HOME"
docker compose --env-file "$OPENPALM_CONFIG_HOME/secrets.env" -f "$OPENPALM_STATE_HOME/docker-compose.yml" up -d
BOOTSHEOF

  cat > "$BUILD_ROOT/config/includes.chroot/etc/systemd/system/openpalm-stack.service" <<'SVCEOF'
[Unit]
Description=Ensure OpenPalm stack is running
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/openpalm-bootstrap.sh

[Install]
WantedBy=multi-user.target
SVCEOF

  cat > "$BUILD_ROOT/config/includes.chroot/etc/systemd/system/openpalm-stack.timer" <<'TIMEREOF'
[Unit]
Description=Periodic OpenPalm stack reconciliation

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=openpalm-stack.service

[Install]
WantedBy=timers.target
TIMEREOF

  rsync -a "$REPO_ROOT/assets/" "$BUILD_ROOT/config/includes.chroot/opt/openpalm/assets/"

  if [[ -f "$OPENPALM_IMAGES_TAR" ]]; then
    mkdir -p "$BUILD_ROOT/config/includes.chroot/opt/openpalm/image-cache"
    cp "$OPENPALM_IMAGES_TAR" "$BUILD_ROOT/config/includes.chroot/opt/openpalm/image-cache/openpalm-images.tar.zst"
  fi

  cat > "$BUILD_ROOT/config/hooks/live/0100-openpalm-configure.chroot" <<HOOKEOF
#!/usr/bin/env bash
set -euo pipefail

useradd -m -s /bin/bash '$KIOSK_USER'
echo '$KIOSK_USER:$KIOSK_PASSWORD' | chpasswd
chage -d 0 '$KIOSK_USER'
usermod -aG docker '$KIOSK_USER'

chmod +x /usr/local/bin/openpalm-kiosk-session.sh /usr/local/bin/openpalm-bootstrap.sh
systemctl enable lightdm.service
systemctl enable docker.service
systemctl enable openpalm-stack.service
systemctl enable openpalm-stack.timer

cat > /etc/apt/apt.conf.d/52openpalm-auto-upgrades <<'APTCONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
APTCONF
HOOKEOF

  chmod +x "$BUILD_ROOT/config/hooks/live/0100-openpalm-configure.chroot"
}

build_image_cache() {
  local cache_dir
  cache_dir="$(dirname -- "$OPENPALM_IMAGES_TAR")"

  mkdir -p "$cache_dir"

  if [[ -f "$OPENPALM_IMAGES_TAR" ]]; then
    echo "Using existing image cache at $OPENPALM_IMAGES_TAR"
    return
  fi

  local images=(
    'docker.io/library/caddy:2'
    'docker.io/library/postgres:16-alpine'
    'docker.io/qdrant/qdrant:latest'
    'docker.io/mem0/openmemory:latest'
    'ghcr.io/sst/opencode:latest'
    'docker.io/itlackey/openpalm-guardian:latest'
    'docker.io/itlackey/openpalm-admin:latest'
  )

  local tmp_tar
  tmp_tar="$cache_dir/openpalm-images.tar"
  rm -f "$tmp_tar"

  for image in "${images[@]}"; do
    docker pull "$image"
  done

  docker save -o "$tmp_tar" "${images[@]}"
  zstd -19 -T0 "$tmp_tar" -o "$OPENPALM_IMAGES_TAR"
  rm -f "$tmp_tar"
}

run_live_build() {
  mkdir -p "$ISO_OUT_DIR"

  echo "Building Debian $DEBIAN_SUITE kiosk ISO for architecture: $DEBIAN_ARCH"

  pushd "$BUILD_ROOT" >/dev/null
  lb config \
    --distribution "$DEBIAN_SUITE" \
    --architectures "$DEBIAN_ARCH" \
    --binary-images iso-hybrid \
    --archive-areas 'main contrib non-free-firmware' \
    --mirror-bootstrap "$DEBIAN_MIRROR" \
    --mirror-chroot "$DEBIAN_MIRROR" \
    --mirror-binary "$DEBIAN_MIRROR" \
    --mirror-binary-security "$DEBIAN_SECURITY_MIRROR" \
    --debian-installer live \
    --iso-volume "$ISO_VOLUME"

  lb build

  local iso_path
  iso_path="$(find . -maxdepth 1 -type f -name '*.iso' | head -n 1)"
  if [[ -z "$iso_path" ]]; then
    echo 'live-build completed but no ISO was generated.' >&2
    exit 1
  fi

  cp "$iso_path" "$ISO_OUT_DIR/openpalm-debian13-kiosk-${DEBIAN_ARCH}.iso"
  popd >/dev/null

  echo "ISO available at: $ISO_OUT_DIR/openpalm-debian13-kiosk-${DEBIAN_ARCH}.iso"
}

main() {
  require_tools
  normalize_arch
  build_image_cache
  render_livebuild_tree
  run_live_build
}

main "$@"
