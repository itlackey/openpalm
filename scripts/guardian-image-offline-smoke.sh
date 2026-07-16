#!/usr/bin/env bash
# guardian-image-offline-smoke.sh — proves the guardian image boots with
# ZERO registry access (S.4, docs/reviews/fable-security-remediation-plan.md).
#
# The guardian is the trust boundary. Before S.4 it fetched its own code
# (@openpalm/guardian, @openpalm/skeleton) from npm at first boot via
# `bun add` in entrypoint.sh — an unpinned, unverified, network-dependent
# install of the very code that enforces the security boundary. This script
# builds the image (registry access allowed at BUILD time, where it is
# reviewable) and then boots a container with `--network none`: if the
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
# Run locally: ./scripts/guardian-image-offline-smoke.sh
#
# NOTE (2026-07): this guards a REAL security invariant (S.4) but is currently
# wired into NOTHING — no CI job and no package.json script runs it, so the
# baked-guardian invariant it protects is never actually exercised. TODO:
# either wire it into CI (a cheap `--network none` boot on image changes) or
# remove it if S.4 is covered elsewhere. Do not leave it as silently-
# unexercised guard code.
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
  rm -rf "$GUARDIAN_DATA_DIR"
}
trap cleanup EXIT

echo "Building guardian image (registry access permitted at build time) GUARDIAN_VERSION=${GUARDIAN_VERSION}..."
docker build -f containers/guardian/Dockerfile --build-arg GUARDIAN_VERSION="${GUARDIAN_VERSION}" -t "$IMAGE" .

echo "Booting with --network none (no DNS, no registry, no assistant reachability)"
echo "and an empty host bind-mount at /opt/openpalm/guardian (production mount topology)..."
docker run -d --network none --name "$CONTAINER" \
  -v "${GUARDIAN_DATA_DIR}:/opt/openpalm/guardian" \
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

# The reproducibility receipt (package@version + entry + auth strategy in one
# structured boot line) is asserted against LOCAL source in
# packages/guardian/src/server.test.ts ("Guardian boot receipt"), not here:
# this script builds from the currently-PUBLISHED @openpalm/guardian npm
# package, which only carries the receipt once this change ships a release.
# What this script verifies is the install itself: the baked package is used
# as-is with no re-fetch, which the "already installed, skipping" lines below
# confirm.
if ! docker logs "$CONTAINER" 2>&1 | grep -q "@openpalm/guardian@${GUARDIAN_VERSION} already installed, skipping"; then
  echo "FAIL: entrypoint did not skip the guardian install (baked package was re-fetched or missing)" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
fi
if ! docker logs "$CONTAINER" 2>&1 | grep -q "@openpalm/skeleton@${GUARDIAN_VERSION} already installed, skipping"; then
  echo "FAIL: entrypoint did not skip the skeleton install (baked package was re-fetched or missing)" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
fi
echo "PASS: baked package@version installs were no-ops at boot (no re-fetch)."

echo "guardian-image-offline-smoke: OK"
