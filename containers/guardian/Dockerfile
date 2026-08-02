FROM oven/bun:1.3-slim AS bunbase

FROM node:22-trixie-slim

# Guardian runs on Bun, while npm-global AKM requires the Node 22/npm installation
# used to verify its scheduler-safe package root. Bun is a standalone binary.
COPY --from=bunbase /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bash ca-certificates && rm -rf /var/lib/apt/lists/*

COPY containers/guardian/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Baked at build time so the thin host boots with NO operator configuration
# AND no network access: the trust boundary's own local Guardian candidate is
# installed into the image layers right here, not fetched by entrypoint.sh on
# first boot. entrypoint.sh's
# install_artifact() remains only for the explicit override path for
# downstream distributions that set OP_GUARDIAN_NPM_VERSION / OP_GUARDIAN_PACKAGE
# to a different package/version (see containers/guardian/README.md).
#
# The local Guardian package is installed into /opt/openpalm/guardian-pkg, NOT
# /opt/openpalm/guardian ($HOME). Compose bind-mounts OP_HOME/data/guardian
# over /opt/openpalm/guardian for runtime state (nonce/rate-limit store,
# OpenCode auth.json/config) — an empty host bind-mount unconditionally
# shadows whatever the image baked at that path, so baking the package there
# would make it re-fetch from npm on every real deployment despite passing a
# bare `docker run` smoke test. /opt/openpalm/guardian-pkg has no mount over
# it at all in the shipped compose (#585 deleted the guardian-cache named
# volume), so the image-baked install is served straight from the image
# layer, unshadowed.
ENV HOME=/opt/openpalm/guardian \
    PORT=8080 \
    OPENCODE_CONFIG_DIR=/etc/opencode \
    PATH="/opt/openpalm/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Point Bun's install-tarball cache at $HOME/.cache/bun/install (a stable,
# operator-owned location under the guardian HOME bind) rather than Bun's own
# default ($HOME/.bun/install/cache). NOTE: relocating $HOME/.cache into a
# separate purgeable named volume is deferred — nesting a named volume inside
# the HOME bind makes Docker create a root-owned mountpoint that fails the
# rootless-ownership smoke test.
ENV BUN_INSTALL_CACHE_DIR=/opt/openpalm/guardian/.cache/bun/install

# Bake exact-pinned OpenCode at /opt/openpalm/tools. No bind mount overlays this
# path; bump the manifest and rebuild the image to change the version.
#
# `bun install` (below) does not apply npm's os/cpu/libc optionalDependencies
# filtering the way `npm install` does, so all four opencode-ai
# linux-x64/arm64 platform variants (modern + baseline glibc, modern +
# baseline musl) land here even though only one can ever run on this glibc
# base for this arch. Pruned post-install (IMG-4, 0.13.0; ~482 MB) —
# docs/system-requirements.md documents the resulting AVX2-era CPU floor.
COPY containers/guardian/tools/package.json /opt/openpalm/tools/package.json

# AKM is an explicitly shipped Guardian CLI even though Guardian does not invoke
# it today. Install it in npm's real global root, matching the Assistant's
# scheduler-safe and runtime-immutable layout.
ARG AKM_CLI_VERSION=0.9.0-rc.13
ENV AKM_CLI_VERSION=${AKM_CLI_VERSION}
RUN ONNXRUNTIME_NODE_INSTALL=skip npm install --global --omit=dev --include=optional --no-fund --no-audit \
      "akm-cli@${AKM_CLI_VERSION}" \
    && AKM_MODULES=/usr/local/lib/node_modules/akm-cli/node_modules \
    && OTHER_ARCH="$([ "$(dpkg --print-architecture)" = "arm64" ] && printf x64 || printf arm64)" \
    && rm -rf "${AKM_MODULES}/onnxruntime-node/bin/napi-v6/win32" \
              "${AKM_MODULES}/onnxruntime-node/bin/napi-v6/darwin" \
              "${AKM_MODULES}/onnxruntime-node/bin/napi-v6/linux/${OTHER_ARCH}" \
              "${AKM_MODULES}/onnxruntime-web" \
    && chmod -R a+rX /usr/local/lib/node_modules/akm-cli \
    && test "$(npm root --global)" = "/usr/local/lib/node_modules" \
    && test "$(/usr/local/bin/akm --version)" = "${AKM_CLI_VERSION}" \
    && test "$(readlink -f /usr/local/bin/akm)" = "/usr/local/lib/node_modules/akm-cli/dist/akm" \
    && test "$(readlink -f /usr/local/bin/akm-migrate)" = "/usr/local/lib/node_modules/akm-cli/dist/akm-migrate" \
    && rm -rf /root/.npm

# IMG-6: install OpenCode in its OWN layer, ABOVE the release-version ARG below.
# The heavy package layers depend only on exact tool pins, so they stay cached
# across releases instead of being repushed when the version stamp changes.
RUN mkdir -p /opt/openpalm/guardian/.cache/bun/install \
    && bun install --cwd /opt/openpalm/tools --production \
    && rm -rf /opt/openpalm/tools/node_modules/opencode-linux-x64-musl \
              /opt/openpalm/tools/node_modules/opencode-linux-x64-baseline \
              /opt/openpalm/tools/node_modules/opencode-linux-x64-baseline-musl \
              /opt/openpalm/tools/node_modules/opencode-linux-arm64-musl \
    && chmod -R a+rwX /opt/openpalm /opt/openpalm/tools

# Release version — everything below this line is cache-invalidated on every
# release, so keep it below the heavy tools layer above (IMG-6).
ARG GUARDIAN_VERSION
ENV GUARDIAN_VERSION=${GUARDIAN_VERSION}

# Copy and pack the candidate source in the image build. External dependencies
# are resolved normally, but the Guardian package itself never comes from npm.
COPY packages/guardian /opt/openpalm/local-src/guardian

# Make the app trees world-writable so a container entered with
# `--user ${OP_UID}:${OP_GID}` can populate them on first boot. The container
# runs as the host operator's ARBITRARY uid:gid (not 1000), and this build
# never knows that id, so a fixed owner/group (the g=u "arbitrary uid"
# convention needs gid 0, which OpenPalm does not use) can never match it —
# world-writable is the only image-side mode that lets an arbitrary uid write
# into these trees. This applies ONLY to these app/cache trees; the secret
# tree (knowledge/secrets, 0600) is a bind mount and is never touched here.
RUN test -n "$GUARDIAN_VERSION" \
    && mkdir -p /opt/openpalm/local-artifacts \
    && (cd /opt/openpalm/local-src/guardian && bun pm pack --destination /opt/openpalm/local-artifacts --quiet) \
    && mkdir -p /opt/openpalm/guardian/.local/share/opencode /opt/openpalm/guardian/.local/state/opencode /opt/openpalm/guardian/.cache/bun/install /opt/openpalm/guardian-pkg \
    && (cd /opt/openpalm/guardian-pkg && bun add /opt/openpalm/local-artifacts/openpalm-guardian-*.tgz --production) \
    && rm -rf /opt/openpalm/local-src /opt/openpalm/local-artifacts \
    # Scope this chmod to ONLY the trees this layer creates. A recursive chmod
    # over /opt/openpalm would touch every file in the cached tools layer above
    # and copy the whole ~700 MB tree up into this layer (measured: +790 MB on
    # the image). /opt/openpalm and tools/ are already chmod'ed in that layer.
    && chmod -R a+rwX /opt/openpalm/guardian /opt/openpalm/guardian-pkg

EXPOSE 8080
# K6: interval/timeout/retries/start-period below MUST match
# portals.compose.yml's guardian healthcheck — that definition governs the
# shipped stack; this one only matters for a bare `docker run` or image-smoke
# path with no compose in front of it. healthcheck-parity.test.ts pins them
# together so a future edit to one side alone fails CI instead of drifting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD curl -sf http://localhost:8080/health/ready || exit 1

USER node

CMD ["/entrypoint.sh"]
