FROM oven/bun:1.3-slim

# nodejs provides npm, required for opencode-ai's postinstall (binary download).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bash ca-certificates nodejs && rm -rf /var/lib/apt/lists/*

COPY containers/guardian/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Baked at build time so the thin host boots with NO operator configuration
# AND no network access: the trust boundary's own code (@openpalm/guardian
# and its co-released @openpalm/skeleton) is installed into the image layers
# right here, not fetched by entrypoint.sh on first boot. entrypoint.sh's
# install_artifact() already-at-version check then makes that boot-time step
# a no-op in the default case; it remains the explicit-override path for
# downstream distributions that set OP_GUARDIAN_NPM_VERSION / OP_GUARDIAN_PACKAGE
# to a different package/version (see containers/guardian/README.md).
#
# The guardian PACKAGE is installed into /opt/openpalm/guardian-pkg, NOT
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
# default ($HOME/.bun/install/cache). NOTE: S1 (relocating $HOME/.cache into a
# separate purgeable named volume) is deferred — nesting a named volume inside
# the HOME bind makes Docker create a root-owned mountpoint that fails the
# rootless-ownership smoke test. See docs/public-seams-review.md §S1.
ENV BUN_INSTALL_CACHE_DIR=/opt/openpalm/guardian/.cache/bun/install

# Bake default tool packages (opencode-ai) at /opt/openpalm/tools. E2/S2: no
# bind mount overlays this path anymore (image-baked-only model) — bump this
# manifest and rebuild the image to change a version, not by editing anything
# under OP_HOME. See docs/public-seams-review.md §E2/§S2.
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
ARG GUARDIAN_USE_LOCAL_SOURCE=false
ARG SKELETON_USE_LOCAL_SOURCE=false

# Optional dry-run/smoke path: copy the local guardian/skeleton workspaces into
# the build context so callers can bake unpublished source at the target version
# without needing it to exist on npm yet.
COPY packages/guardian /opt/openpalm/local-src/guardian
COPY packages/skeleton /opt/openpalm/local-src/skeleton

# Make the app trees world-writable so a container entered with
# `--user ${OP_UID}:${OP_GID}` can populate them on first boot. The container
# runs as the host operator's ARBITRARY uid:gid (not 1000), and this build
# never knows that id, so a fixed owner/group (the g=u "arbitrary uid"
# convention needs gid 0, which OpenPalm does not use) can never match it —
# world-writable is the only image-side mode that lets an arbitrary uid write
# into these trees. This applies ONLY to these app/cache trees; the secret
# tree (knowledge/secrets, 0600) is a bind mount and is never touched here.
RUN test -n "$GUARDIAN_VERSION" \
    && guardian_spec="@openpalm/guardian@${GUARDIAN_VERSION}" \
    && skeleton_spec="@openpalm/skeleton@${GUARDIAN_VERSION}" \
    && mkdir -p /opt/openpalm/local-artifacts \
    && if [ "$GUARDIAN_USE_LOCAL_SOURCE" = "true" ]; then \
         (cd /opt/openpalm/local-src/guardian && bun pm pack --destination /opt/openpalm/local-artifacts --quiet); \
         guardian_spec="$(find /opt/openpalm/local-artifacts -maxdepth 1 -name 'openpalm-guardian-*.tgz' | head -n 1)"; \
       fi \
    && if [ "$SKELETON_USE_LOCAL_SOURCE" = "true" ]; then \
         (cd /opt/openpalm/local-src/skeleton && bun pm pack --destination /opt/openpalm/local-artifacts --quiet); \
         skeleton_spec="$(find /opt/openpalm/local-artifacts -maxdepth 1 -name 'openpalm-skeleton-*.tgz' | head -n 1)"; \
       fi \
    && mkdir -p /opt/openpalm /opt/openpalm/guardian/.local/share/opencode /opt/openpalm/guardian/.local/state/opencode /opt/openpalm/guardian/.cache/bun/install /opt/openpalm/guardian-pkg /opt/openpalm/skeleton \
    && (cd /opt/openpalm/guardian-pkg && bun add "$guardian_spec" --production) \
    && (cd /opt/openpalm/skeleton && bun add "$skeleton_spec" --production) \
    && rm -rf /opt/openpalm/local-src /opt/openpalm/local-artifacts \
    # Scope this chmod to ONLY the trees this layer creates. A recursive chmod
    # over /opt/openpalm would touch every file in the cached tools layer above
    # and copy the whole ~700 MB tree up into this layer (measured: +790 MB on
    # the image). /opt/openpalm and tools/ are already chmod'ed in that layer.
    && chmod -R a+rwX /opt/openpalm/guardian /opt/openpalm/guardian-pkg /opt/openpalm/skeleton

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -sf http://localhost:8080/health/ready || exit 1

USER bun

CMD ["/entrypoint.sh"]
