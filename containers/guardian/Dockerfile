FROM oven/bun:1.3.14-slim

# nodejs provides npm, required for opencode-ai's postinstall (binary download).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bash ca-certificates nodejs && rm -rf /var/lib/apt/lists/*

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

# Bake default tool packages (opencode-ai) at /opt/openpalm/tools. No bind
# mount overlays this path anymore (image-baked-only model) — bump this
# manifest and rebuild the image to change a version, not by editing anything
# under OP_HOME.
#
# `bun install` (below) does not apply npm's os/cpu/libc optionalDependencies
# filtering the way `npm install` does, so all four opencode-ai
# linux-x64/arm64 platform variants (modern + baseline glibc, modern +
# baseline musl) land here even though only one can ever run on this glibc
# base for this arch. Pruned post-install (IMG-4, 0.13.0; ~482 MB) —
# docs/system-requirements.md documents the resulting AVX2-era CPU floor.
COPY containers/guardian/tools/package.json /opt/openpalm/tools/package.json

# IMG-6: install the tools tree in its OWN layer, ABOVE the release-version
# ARG below. This is the heavy layer (the opencode binary) and it depends only
# on the manifest COPY'd above, so it stays cached across releases instead of
# being re-pushed and re-pulled every time the version stamp changes.
# OPENCODE_CONFIG_DIR is the moderator's DISPOSABLE runtime config copy, which
# the entrypoint republishes from the read-only managed mount on every boot.
# The shipped compose binds cache/guardian-opencode/runtime over it; create it
# here (world-writable, same arbitrary-uid rationale as the trees below) so a
# bare `docker run` still has somewhere to publish to.
RUN mkdir -p /opt/openpalm/guardian/.cache/bun/install /etc/opencode \
    && bun install --cwd /opt/openpalm/tools --production \
    && rm -rf /opt/openpalm/tools/node_modules/opencode-linux-x64-musl \
              /opt/openpalm/tools/node_modules/opencode-linux-x64-baseline \
              /opt/openpalm/tools/node_modules/opencode-linux-x64-baseline-musl \
              /opt/openpalm/tools/node_modules/opencode-linux-arm64-musl \
    && chmod -R a+rwX /opt/openpalm /opt/openpalm/tools /etc/opencode

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
  CMD curl -s --fail-with-body http://localhost:8080/health/ready || exit 1

USER bun

CMD ["/entrypoint.sh"]
