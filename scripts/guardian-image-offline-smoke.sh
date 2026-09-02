#!/usr/bin/env bash
# guardian-image-offline-smoke.sh — proves the guardian image boots with
# ZERO registry access (S.4).
#
# The guardian is the trust boundary. Before S.4 it fetched its own code
# (@openpalm/guardian) from npm at first boot via
# `bun add` in entrypoint.sh — an unpinned, unverified, network-dependent
# install of the very code that enforces the security boundary. This script
# builds the image from the local candidate source and then boots a container
# with `--network none`: if the
# guardian package is genuinely baked into the image layers, boot is a
# no-op install-skip and the server reaches healthy with no network at all.
#
# Critically, it also replicates the SHIPPED mount topology
# (packages/skeleton/system/stack/portals.compose.yml): compose bind-mounts
# OP_HOME/data/guardian over /opt/openpalm/guardian. A bind-mount never seeds
# from the image, so an empty host directory mounted there unconditionally
# shadows anything the image baked at that exact path — a bare `docker run`
# with no such mount would miss that regression entirely. This script mounts
# an empty host dir at /opt/openpalm/guardian, matching production, so the
# baked-package invariant is only proven "green" when it actually survives
# under the real deployment shape.
#
# The managed moderator config is part of that topology: compose mounts
# OP_HOME/system/guardian read-only at /opt/openpalm/guardian-config and the
# entrypoint republishes it into OPENCODE_CONFIG_DIR. With content validation
# enabled (the default this script boots under) that mount is mandatory — the
# entrypoint fails closed rather than moderate against no policy — so the
# skeleton's copy is mounted here the same way. OPENCODE_CONFIG_DIR itself is
# left as the image's own writable directory; it is a disposable runtime copy,
# and nothing about the baked-package invariant lives there.
#
# Run locally: ./scripts/guardian-image-offline-smoke.sh
#
# Wired into CI (.github/workflows/ci.yml, "Guardian offline-boot smoke").
# It previously ran nowhere, which is exactly how its assertions rotted
# unnoticed against a reworded log line.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GUARDIAN_VERSION="$(node -p "require('./packages/guardian/package.json').version")"
IMAGE="openpalm-guardian-offline-smoke:test"
CONTAINER="guardian-offline-smoke-$$"
# NEVER use a /tmp source for a docker bind-mount here: when dockerd runs
# with systemd PrivateTmp=true (or the daemon otherwise has a /tmp mount
# namespace distinct from this shell's), `-v /tmp/x:/dest` silently mounts an
# EMPTY directory from the daemon's own /tmp instead of this host path,
# masking the very regression this script exists to catch. Use ~/.cache
# instead (see project memory: docker-bind-mount-from-tmp-privatetmp-trap).
mkdir -p "${HOME}/.cache/openpalm-guardian-smoke"
GUARDIAN_DATA_DIR="$(mktemp -d "${HOME}/.cache/openpalm-guardian-smoke/data.XXXXXX")"
# World-writable so the container's runtime user (an arbitrary OP_UID:OP_GID
# in real deployments, adopted via host ownership) can populate it — mirrors
# the image-side `chmod -R a+rwX` rationale in containers/guardian/Dockerfile.
chmod 0777 "$GUARDIAN_DATA_DIR"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # Delete the fixture FROM A CONTAINER, not with a host `rm`. The guardian
  # writes into this bind as its own image user, so under rootful Docker (CI)
  # those files are owned by a uid the runner cannot unlink — a host `rm -rf`
  # fails with EACCES and, under `set -e`, fails the whole job even though
  # every assertion above passed. Under rootless Docker (typical dev machine)
  # the uid maps back to the caller and a host rm happens to work, which is
  # exactly why this only ever failed in CI. Same pattern as the rootless
  # smokes (scripts/rootless-ownership-smoke.sh).
  docker run --rm -v "$(dirname "$GUARDIAN_DATA_DIR"):/smoke-parent" alpine \
    sh -c 'rm -rf "/smoke-parent/$1"' _ "$(basename "$GUARDIAN_DATA_DIR")" >/dev/null 2>&1 || true
  rm -rf "$GUARDIAN_DATA_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "Building guardian image from local candidate GUARDIAN_VERSION=${GUARDIAN_VERSION}..."
docker build -f containers/guardian/Dockerfile \
  --build-arg GUARDIAN_VERSION="${GUARDIAN_VERSION}" \
  -t "$IMAGE" .

echo "Booting with --network none (no DNS, no registry, no assistant reachability)"
echo "and an empty host bind-mount at /opt/openpalm/guardian (production mount topology)..."
docker run -d --network none --name "$CONTAINER" \
  -v "${GUARDIAN_DATA_DIR}:/opt/openpalm/guardian" \
  -v "${ROOT}/packages/skeleton/system/guardian:/opt/openpalm/guardian-config:ro" \
  -e GUARDIAN_AUDIT_PATH=/opt/openpalm/guardian/logs/audit.log \
  "$IMAGE" >/dev/null

ok=0
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" curl -sf http://localhost:8080/health >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done

if [ "$ok" != "1" ]; then
  echo "FAIL: guardian did not reach healthy within 30s under --network none" >&2
  echo "--- container logs ---" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
fi
echo "PASS: guardian reached healthy under --network none."

# What this script verifies is that the baked package is used as-is with no
# re-fetch. The entrypoint no longer announces that with its own log line — the
# boot-time package override it used to print around was deleted outright
# (a000687), and the exec is now unconditional — so the proof is the guardian's
# structured boot receipt: its `entry` is Bun.main, and only the image layer
# puts @openpalm/guardian at this path (the shipped compose bind-mounts
# /opt/openpalm/guardian, never /opt/openpalm/guardian-pkg).
BAKED_ENTRY="/opt/openpalm/guardian-pkg/node_modules/@openpalm/guardian/src/server.ts"
# Capture once because `docker logs | grep -q` races under pipefail: grep can
# close the pipe after a match and turn docker's resulting SIGPIPE into failure.
CONTAINER_LOGS="$(docker logs "$CONTAINER" 2>&1)"
if ! grep -qF "\"entry\":\"${BAKED_ENTRY}\"" <<<"$CONTAINER_LOGS"; then
  echo "FAIL: guardian boot receipt does not name the image-baked entry ${BAKED_ENTRY}" >&2
  printf '%s\n' "$CONTAINER_LOGS" >&2
  exit 1
fi
echo "PASS: local candidate package was used at boot (no re-fetch)."

echo "guardian-image-offline-smoke: OK"
