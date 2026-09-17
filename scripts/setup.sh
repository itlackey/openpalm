#!/usr/bin/env bash
# Install the checksum-verified OpenPalm CLI, then install the lean stack.
set -euo pipefail

die() {
  printf 'openpalm: %s\n' "$*" >&2
  exit 1
}

normalize_version() {
  printf '%s\n' "${1#v}"
}

validate_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
    die "invalid release version: $1"
}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) binary=openpalm-cli-linux-x64 ;;
  Linux-aarch64) binary=openpalm-cli-linux-arm64 ;;
  Darwin-x86_64) binary=openpalm-cli-darwin-x64 ;;
  Darwin-arm64) binary=openpalm-cli-darwin-arm64 ;;
  *) die "unsupported platform: $(uname -s)/$(uname -m)" ;;
esac

version="${OP_VERSION:-}"
cli_only=0
passthrough=()
while (($#)); do
  case "$1" in
    --version)
      (($# >= 2)) || die "--version requires a value"
      version=$2
      shift 2
      ;;
    --version=*)
      version="${1#--version=}"
      shift
      ;;
    --cli-only)
      cli_only=1
      shift
      ;;
    *)
      passthrough+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$version" ]]; then
  latest_url="$(curl -fsSL --retry 3 --retry-delay 2     -o /dev/null -w '%{url_effective}'     https://github.com/itlackey/openpalm/releases/latest)" ||
    die "could not resolve the latest release"
  [[ "$latest_url" == */releases/tag/* ]] ||
    die "GitHub returned an invalid latest-release URL"
  version="${latest_url##*/}"
fi
version="$(normalize_version "$version")"
validate_version "$version"

install_dir="${OP_INSTALL_DIR:-${HOME}/.local/bin}"
destination="$install_dir/openpalm"
mkdir -p "$install_dir" ||
  die "could not create $install_dir; set OP_INSTALL_DIR to a writable directory"
temporary="$(mktemp "$install_dir/.openpalm.XXXXXX")" ||
  die "could not create a temporary file in $install_dir"
trap 'rm -f "$temporary"' EXIT

release_url="https://github.com/itlackey/openpalm/releases/download/$version"
printf 'Downloading OpenPalm %s...\n' "$version"
curl -fsSL --retry 5 --retry-delay 2 "$release_url/$binary" -o "$temporary" ||
  die "could not download $binary for release $version"
checksums="$(curl -fsSL --retry 3 --retry-delay 2 "$release_url/checksums-sha256.txt")" ||
  die "could not download release checksums"
expected="$(printf '%s\n' "$checksums" | awk -v name="$binary" '$2 == name || $2 == "*" name { print $1; exit }')"
[[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] ||
  die "release checksums do not contain $binary"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$temporary" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$temporary" | awk '{print $1}')"
else
  die "sha256sum or shasum is required"
fi
[[ "$actual" == "$expected" ]] || die "checksum mismatch for $binary"

chmod 0755 "$temporary"
mv "$temporary" "$destination"
trap - EXIT

if [[ "$(uname -s)" == Darwin ]]; then
  xattr -cr "$destination" 2>/dev/null || true
  codesign --force --sign - "$destination" 2>/dev/null || true
fi

printf 'Installed %s\n' "$destination"
case ":${PATH}:" in
  *":$install_dir:"*) ;;
  *) printf 'Add %s to PATH.\n' "$install_dir" ;;
esac

((cli_only)) && exit 0
exec "$destination" install "${passthrough[@]}"
