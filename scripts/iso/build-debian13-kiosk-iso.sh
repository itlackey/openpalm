#!/usr/bin/env bash
set -euo pipefail

# Build a Debian 13 (trixie) ISO that boots into a lightweight kiosk login.
# After first successful login, the user is forced to change password and then
# sees Chromium in kiosk mode pointing at the OpenPalm admin URL.
#
# Template files live alongside this script in files/ and are copied into the
# live-build tree at build time.  Placeholders such as __KIOSK_USER__ are
# replaced with the values of the corresponding environment variables.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
FILES_DIR="$SCRIPT_DIR/files"
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

# Replace placeholder tokens in a file with runtime values.
render_template() {
  local src="$1" dst="$2"
  sed \
    -e "s|__KIOSK_USER__|$KIOSK_USER|g" \
    -e "s|__KIOSK_PASSWORD__|$KIOSK_PASSWORD|g" \
    -e "s|__OPENPALM_ADMIN_URL__|$OPENPALM_ADMIN_URL|g" \
    "$src" > "$dst"
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

  # --- Package list (no templating needed) ---
  cp "$FILES_DIR/package-lists/openpalm-kiosk.list.chroot" \
    "$BUILD_ROOT/config/package-lists/openpalm-kiosk.list.chroot"

  # --- X session desktop entry (no templating needed) ---
  cp "$FILES_DIR/xsessions/openpalm-kiosk.desktop" \
    "$BUILD_ROOT/config/includes.chroot/usr/share/xsessions/openpalm-kiosk.desktop"

  # --- Kiosk session launcher (templated: OPENPALM_ADMIN_URL) ---
  render_template "$FILES_DIR/bin/openpalm-kiosk-session.sh" \
    "$BUILD_ROOT/config/includes.chroot/usr/local/bin/openpalm-kiosk-session.sh"

  # --- LightDM seat configuration (no templating needed) ---
  cp "$FILES_DIR/lightdm/50-openpalm.conf" \
    "$BUILD_ROOT/config/includes.chroot/etc/lightdm/lightdm.conf.d/50-openpalm.conf"

  # --- Bootstrap script (no templating needed) ---
  cp "$FILES_DIR/bin/openpalm-bootstrap.sh" \
    "$BUILD_ROOT/config/includes.chroot/usr/local/bin/openpalm-bootstrap.sh"

  # --- Systemd units (no templating needed) ---
  cp "$FILES_DIR/systemd/openpalm-stack.service" \
    "$BUILD_ROOT/config/includes.chroot/etc/systemd/system/openpalm-stack.service"
  cp "$FILES_DIR/systemd/openpalm-stack.timer" \
    "$BUILD_ROOT/config/includes.chroot/etc/systemd/system/openpalm-stack.timer"

  # --- Repository assets ---
  rsync -a "$REPO_ROOT/assets/" "$BUILD_ROOT/config/includes.chroot/opt/openpalm/assets/"

  # --- Pre-built Docker image cache (optional) ---
  if [[ -f "$OPENPALM_IMAGES_TAR" ]]; then
    mkdir -p "$BUILD_ROOT/config/includes.chroot/opt/openpalm/image-cache"
    cp "$OPENPALM_IMAGES_TAR" "$BUILD_ROOT/config/includes.chroot/opt/openpalm/image-cache/openpalm-images.tar.zst"
  fi

  # --- Chroot configuration hook (templated: KIOSK_USER, KIOSK_PASSWORD) ---
  render_template "$FILES_DIR/hooks/0100-openpalm-configure.chroot" \
    "$BUILD_ROOT/config/hooks/live/0100-openpalm-configure.chroot"
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
