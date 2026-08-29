# ── Assistant Service ──────────────────────────────────────────────────────────
# OpenCode AI runtime with OpenPalm extensions for the akm stash, policy,
# and tools. Config, plugins, and persona are mounted at runtime — not baked
# into the image.
#
# Tool packages (opencode-ai, akm-cli) are exact-pinned in
# containers/assistant/tools/package.json and baked into the image at
# /opt/openpalm/tools by the toolbuild stage below. There is no runtime
# install or update — no bind mount overlays this path anymore (image-baked-
# only model). Bumping a tool version means editing the manifest and cutting
# a new image.
#
# The four AI coding CLIs (claude-code, codex, copilot, pi) and the Google
# Cloud SDK (gcloud) used to be baked here too (~1.4 GB combined). Nothing
# shipped in this image invokes them — OpenCode is the runtime the assistant
# actually drives — so they were dropped (IMG-1/IMG-3, 0.13.0). Either is
# available on request via the `install-optional-tool` akm skill
# (packages/skeleton/system/skills/install-optional-tool/), which installs
# into the `assistant-persistent` volume at /opt/persistent so the install
# survives container recreation.
# ──────────────────────────────────────────────────────────────────────────────

# ── embedder model bundle ──
# akm's default local embedder (Xenova/bge-small-en-v1.5, 384-dim) ships
# pre-baked from the prebuilt `openpalm/assistant-models` image
# (containers/assistant/Dockerfile.models, published out-of-band by
# publish-assistant-models.yml) — NOT downloaded here. This means an assistant
# build never touches HuggingFace for the model (no transformers.js `get_files`
# network flakes — see issue #505) and the ~128 MB download happens once per
# model bump instead of on every assistant build. The model is platform-agnostic
# data, so we pull the bundle for the BUILD host arch (`--platform=$BUILDPLATFORM`,
# amd64 on CI) and COPY --from it into the runtime image.
#
# Bumping the model: publish a new openpalm/assistant-models tag (see
# Dockerfile.models) and update this default. Operators/CI can override via
# --build-arg.
ARG ASSISTANT_MODELS_IMAGE=openpalm/assistant-models:v1
FROM --platform=$BUILDPLATFORM ${ASSISTANT_MODELS_IMAGE} AS modelfetch

# ── Prebuilt tool binaries ────────────────────────────────────────────────────
# bun and uv are COPY'd out of their publishers' official images instead of
# being fetched by an install script at build time. Both scripts pulled from
# GitHub's release CDN, which is exactly the dependency that broke a release:
# a 503 there failed the image build, and the same outage independently failed
# setup-bun and electron-builder in other jobs. Docker Hub / GHCR is a
# different path, buildx caches these layers, and a COPY cannot half-succeed.
#
# This also makes the assistant match guardian and portal, which already build
# `FROM oven/bun:<tag>` — the assistant was the only one still curling.
#
# Tags are literal, not ARGs: the BUN_VERSION sync check in ci.yml greps them.
FROM oven/bun:1.3.14 AS bunsrc
FROM ghcr.io/astral-sh/uv:0.12.3 AS uvsrc

# ── Tool builder stage ────────────────────────────────────────────────────────
# Install the tool packages from the single exact-pinned manifest (edit +
# rebuild the image to change a version — no runtime override, E2/S2), prune
# the content IMG-1/onnxruntime pruning below removed, then PARTITION the
# remaining node_modules into balanced groups. A single `npm install` used to
# produce one ~3.5GB layer (~1.75GB compressed) that Docker Hub's CDN rejects
# on push (HTTP 400 on the oversized blob) — the split keeps every COPY layer
# comfortably under that ceiling even though the tree is far smaller now.
# NOT --platform pinned: native deps (onnxruntime, the opencode binary) must
# match the TARGET arch.
FROM node:24-trixie-slim AS toolbuild
WORKDIR /opt/openpalm/tools
COPY containers/assistant/tools/package.json ./package.json
# ONNXRUNTIME_NODE_INSTALL=skip stops onnxruntime-node's postinstall from
# downloading the CUDA/TensorRT execution provider (~301 MB, fetched from
# NuGet on every install) — nothing in this stack maps a GPU device into any
# container, so that provider can never run. The base linux/x64 (or
# linux/arm64) binding still ships pre-bundled in the npm package itself, so
# this does not touch the CPU codepath akm's local embedder actually uses.
#
# opencode-ai ships one npm package per platform/libc/microarch combination as
# optionalDependencies; `npm install` filters by os/cpu but not by the
# "baseline" (pre-AVX2) vs. modern split, and this image's glibc base can
# never run the musl builds at all. Prune everything except the modern glibc
# build for the arch being built (docs/system-requirements.md documents the
# resulting AVX2-era CPU floor).
#
# @huggingface/transformers (akm's local embedder) depends on both
# onnxruntime-node (the Node/native backend it actually uses here) and
# onnxruntime-web (browser/WASM — unreachable in this Node runtime, ~130 MB).
# onnxruntime-node itself pre-bundles win32/darwin binaries and the
# non-target linux arch, none of which this container can ever load.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm install --omit=dev --no-fund --no-audit \
    && find node_modules ! -perm -o+r -exec chmod a+rX {} + \
    && rm -rf node_modules/opencode-linux-x64-musl \
              node_modules/opencode-linux-x64-baseline \
              node_modules/opencode-linux-x64-baseline-musl \
              node_modules/opencode-linux-arm64-musl \
    && OTHER_ARCH="$([ "$(dpkg --print-architecture)" = "arm64" ] && echo x64 || echo arm64)" \
    && rm -rf node_modules/onnxruntime-node/bin/napi-v6/win32 \
              node_modules/onnxruntime-node/bin/napi-v6/darwin \
              "node_modules/onnxruntime-node/bin/napi-v6/linux/${OTHER_ARCH}" \
              node_modules/onnxruntime-web \
    && mkdir -p /split/g1 /split/g2 \
    && mv node_modules/@huggingface /split/g1/ \
    && mv node_modules/onnxruntime-node /split/g2/

FROM node:24-trixie-slim

ARG BUN_VERSION=bun-v1.3.14

# Re-export for runtime introspection.
ENV BUN_VERSION=${BUN_VERSION}

# Combined OS packages: base tools (tini) + assistant-specific (python3, jq,
# gh) + sqlite3 so agents can query SQLite directly. The Postgres client
# package and the unused GLib runtime library were dropped (IMG-5, 0.13.0):
# nothing links the latter, and nothing in this image talks to Postgres — its
# client is one `apt-get install` away on-session for anyone who needs it.
#
# busybox went with them. It was here only for crond/crontab, and neither can
# work in this image: busybox crond loads a crontab only when the file is owned
# by uid 0 (DAEMON_UID in miscutils/crond.c — other files are skipped with no
# log line at all), and its job children call setgroups/setgid/setuid before
# exec, which fail as "Operation not permitted" for an unprivileged user. This
# image runs as uid 1000, so scheduled tasks silently never ran. See the
# supercronic install below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini curl git ca-certificates bash unzip \
        libnss-wrapper \
        python3 jq \
        sqlite3 \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# supercronic — cron that runs correctly as an unprivileged user. It executes
# jobs as the invoking user (no setuid, no root-owned-crontab requirement), and
# `-inotify` reloads the crontab in place when `akm task sync` rewrites it, so
# the entrypoint needs no restart/signal plumbing. Logs go to stderr, which is
# how scheduled runs finally become visible in `openpalm logs assistant`.
#
# Pinned by version AND per-arch sha256 (upstream publishes no checksum file),
# verified before the binary is made executable.
ARG SUPERCRONIC_VERSION=v0.2.48
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) supercronic_sha=88c1b66b94c486f972fdd1a4d1f901e3e75ff04f749cddd60c5db573e3a33c6c ;; \
      arm64) supercronic_sha=50ae8755e04fa72812d0a1bc47a112a856811cc91cce7b6c875c378a850788bc ;; \
      *) echo "unsupported TARGETARCH for supercronic: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}"; \
    echo "${supercronic_sha}  /usr/local/bin/supercronic" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/supercronic; \
    supercronic -version

# Bun at /usr/local/bin. BUN_INSTALL + BUN_INSTALL_CACHE_DIR are set to
# per-user paths further down so unprivileged users can install packages at
# runtime; they are not needed here now that the binary is copied in place
# rather than placed by an installer that reads them.
COPY --from=bunsrc /usr/local/bin/bun /usr/local/bin/bun

# Bake default tool packages at /opt/openpalm/tools, assembled from the toolbuild
# stage as THREE COPY layers (g1, g2, and the remainder) so no single blob is the
# ~1.75GB monolith Docker Hub rejects on push. --chown sets opencode (UID 1000)
# ownership in-layer (no copy-up). This baked tree IS what runs — no bind mount
# overlays it anymore (E2/S2), so the image alone is the source of truth for
# the tool set; bump containers/assistant/tools/package.json and rebuild to
# change a version.
COPY --from=toolbuild --chown=1000:1000 /opt/openpalm/tools/node_modules /opt/openpalm/tools/node_modules
COPY --from=toolbuild --chown=1000:1000 /split/g2/ /opt/openpalm/tools/node_modules/
COPY --from=toolbuild --chown=1000:1000 /split/g1/ /opt/openpalm/tools/node_modules/
COPY containers/assistant/tools/package.json /opt/openpalm/tools/package.json

# Pre-bake akm's default local embedding model so semantic search works out of
# the box with NO embedding configuration and NO runtime network. When
# config/akm/config.json has no embedding endpoint (the default), akm self-embeds
# in-process via @huggingface/transformers (default model Xenova/bge-small-en-v1.5,
# 384-dim) — see akm-cli dist/llm/embedders/local.js. transformers.js reads from its
# package-local .cache (an image path, NOT the bind-mounted akm cache), so the model
# ships baked into the image.
#
# The model artifacts are COPY'd from the prebuilt openpalm/assistant-models bundle
# (see modelfetch stage) into the EXACT path transformers.js reads — the package's
# .cache dir — instead of being downloaded here. This removes the flaky HuggingFace
# `get_files` network call that broke 2/2 releases (issue #505). The bundle already
# fails its own build if the cache is empty, so no silent empty bundle reaches here.
#
# We STILL run one real inference at assistant-build time, but now OFFLINE against
# the copied cache (env.allowRemoteModels=false — transformers.js v4 does NOT honor
# HF_HUB_OFFLINE). This preserves the fail-closed guarantee: the build FAILS if the
# @huggingface/transformers / onnxruntime native binary can't load on this arch or
# the copied cache is incomplete — no silent fallback to keyword-only search, and
# no network access.
COPY --from=modelfetch /opt/embedder-cache/ /opt/openpalm/tools/node_modules/@huggingface/transformers/.cache/
RUN cd /opt/openpalm/tools/node_modules \
    && node --input-type=module -e "import { env, pipeline } from '@huggingface/transformers'; env.allowRemoteModels = false; const embed = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5'); const out = await embed('warmup', { pooling: 'mean', normalize: true }); if (!out?.data?.length) { console.error('local embedder produced no vector'); process.exit(1); } console.log('akm local embedder OK offline (' + out.data.length + ' dims)');" \
    && chmod -R a+rX /opt/openpalm/tools/node_modules/@huggingface/transformers/.cache

# Keep the image-baked runtime user simple: the base `node` user remains UID 1000,
# while `/home/opencode` stays the stable home path used by mounts and runtime env.
RUN mkdir -p /home/opencode \
    && chown node:node /home/opencode

# uv (Python package manager for the apprise venv). Static musl binaries from
# Astral's official image — no installer, no PATH mutation to undo.
COPY --from=uvsrc /uv /uvx /usr/local/bin/

# apprise — isolated venv via uv (avoids pip --break-system-packages).
# Used by the `notify` akm skill (apprise-backed).
RUN uv venv /opt/assistant-tools \
    && uv pip install --python /opt/assistant-tools/bin/python apprise
ENV PATH="/opt/assistant-tools/bin:$PATH"
ENV APPRISE_NOTIFY_CONFIG="/stash/env/apprise.conf"
# GOOGLE_APPLICATION_CREDENTIALS is NOT set here — it must be supplied at
# runtime via stack.env or user.env if Google Cloud tools are needed.
# Baking a path here causes OpenCode to detect google-vertex-anthropic as
# connected on every install, even when the credentials file does not exist.

# gcloud CLI is NOT baked here (IMG-3, 0.13.0: ~550 MB). It installs on
# request via the `install-optional-tool` akm skill into /opt/persistent,
# which is already on PATH below; gcloud then defaults its own config dir to
# $HOME/.config/gcloud, which persists via the assistant home bind mount
# without needing a CLOUDSDK_CONFIG override here.

# Seed the runtime dirs and make them group-writable so a container entered with
# `--user ${OP_UID}:${OP_GID}` can populate them on first boot. The container
# runs as the host operator's ARBITRARY uid:gid (not 1000), and this build never
# knows that id, so a fixed owner/group (the g=u "arbitrary uid" convention
# needs gid 0, which OpenPalm does not use) can never match it; world-writable
# is the only image-side mode that works. These paths fall into three
# different cases, not one:
#   - `/opt/persistent` is a real named volume (still mounted — #585 kept it).
#     Docker seeds a fresh volume from this image path WITH this ownership the
#     first time the volume is created, so this chmod is what the arbitrary
#     uid actually inherits.
#   - `/opt/openpalm/ui` has no mount over it at all (#585 deleted the named
#     volume that used to cover /opt/openpalm), so the image layer is served
#     straight through, unshadowed — this chmod is likewise what the arbitrary
#     uid sees at runtime.
#   - `/home/opencode`, `/work`, `/stash`, `/opt/akm` are core.compose.yml BIND
#     mount targets: at runtime the host directory's ownership wins and this
#     chmod is shadowed. It still matters at the mountPOINT level — it is what
#     stops Docker from creating an as-yet-nonexistent bind-mount destination
#     root-owned inside the image layer before the host directory is mounted
#     over it.
# Scope the chmod to these freshly created seed dirs ONLY — deliberately
# excluding /opt/openpalm/tools, whose baked node_modules + @huggingface model
# cache is a multi-hundred-MB tree split across COPY layers (Docker Hub rejects
# giant blobs); a recursive chmod over it would materialize a duplicate overlay
# layer. E2/S2: the tools tree is no longer bind-mounted (image-baked only, no
# runtime install/update), and the toolbuild stage already leaves it world-
# readable+executable (`find ... -exec chmod a+rX`), so an arbitrary-uid
# container only ever READS it — no write access needed here. Secrets
# (knowledge/secrets, 0600) are a separate bind-mount tree.
RUN mkdir -p /home/opencode/.cache /home/opencode/.local/bin /work /stash /opt/akm/cache /opt/akm/data /opt/akm/data/state /opt/persistent/bin \
    && mkdir -p /opt/openpalm/ui /opt/openpalm/tools \
    && chown -R node:node /home/opencode /work /stash /opt/akm /opt/persistent /opt/openpalm/ui \
    && chmod -R a+rwX /home/opencode /work /stash /opt/akm /opt/persistent /opt/openpalm/ui

# Platform version for runtime introspection. The UI source copied below is the
# candidate being tested and is never resolved from the public npm registry.
#
# IMG-6: this MUST stay below every heavy layer. It changes on every release,
# so anything under it is cache-invalidated and re-pushed/re-pulled each time.
# Above the tool COPYs it cost ~3.3 GB of "new" layers per upgrade to deliver
# ~25 MB of actual change, and forced old+new images to coexist on disk with
# nothing shared. Nothing between the base image and here reads it.
ARG PLATFORM_VERSION
# Re-export for runtime introspection.
ENV PLATFORM_VERSION=${PLATFORM_VERSION}

# ── @openpalm/ui bake ────────────────────────────────────────────────────────
# The compiled candidate is copied from the checkout and packed locally. This
# keeps live builds and coordinated dry runs on the same path without requiring
# the candidate UI version to have been published first.
COPY containers/assistant/workspace.package.json /opt/openpalm/local-src/package.json
COPY packages/lib /opt/openpalm/local-src/packages/lib
COPY packages/ui /opt/openpalm/local-src/packages/ui
RUN mkdir -p /opt/openpalm/local-artifacts \
    && (cd /opt/openpalm/local-src && bun install --lockfile-only --ignore-scripts) \
    && (cd /opt/openpalm/local-src/packages/ui && bun pm pack --destination /opt/openpalm/local-artifacts --quiet) \
    && npm install --prefix /opt/openpalm/ui /opt/openpalm/local-artifacts/openpalm-ui-*.tgz \
         --omit=dev --no-fund --no-audit \
    && rm -rf /opt/openpalm/local-src /opt/openpalm/local-artifacts \
    && chmod -R a+rwX /opt/openpalm/ui

COPY containers/assistant/entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

WORKDIR /work

# Point Bun's user-writable paths at the opencode user's home, under
# /home/opencode/.cache (a stable, operator-owned location on the HOME bind).
# NPM_CONFIG_CACHE does the same for any ad hoc `npm install` an agent runs
# on-session (the entrypoint itself no longer installs anything at boot).
# NOTE: relocating /home/opencode/.cache into a separate purgeable named
# volume is deferred — nesting a named volume inside the HOME bind makes
# Docker create a root-owned mountpoint that fails the rootless smoke test.
ENV BUN_INSTALL=/home/opencode/.bun
ENV BUN_INSTALL_CACHE_DIR=/home/opencode/.cache/bun/install
ENV NPM_CONFIG_CACHE=/home/opencode/.cache/npm

# PATH precedence (highest first):
#   /opt/persistent/bin        — prefix-style global installs (escape hatch)
#   /opt/openpalm/tools/node_modules/.bin — image-baked tool packages (exact-pinned, E2/S2)
#   /home/opencode/.local/bin  — per-user installs in the persistent home bind mount
#   /home/opencode/.bun/bin    — bun install -g (BUN_INSTALL points here)
#   /usr/local/bin             — image-baked system tools
ENV PATH="/opt/persistent/bin:/opt/openpalm/tools/node_modules/.bin:/home/opencode/.local/bin:/home/opencode/.bun/bin:/usr/local/bin:$PATH"

# A login shell (`bash -l`, e.g. the release smoke test and interactive ssh)
# re-runs /etc/profile, which on Debian overwrites PATH with the system default
# and drops the managed tool dirs from the ENV PATH above. Re-prepend them via
# profile.d so opencode/akm and any on-demand-installed tools
# (install-optional-tool skill, /opt/persistent/bin) resolve in login shells
# too.
RUN printf 'export PATH="/opt/persistent/bin:/opt/openpalm/tools/node_modules/.bin:/home/opencode/.local/bin:/home/opencode/.bun/bin:/opt/assistant-tools/bin:$PATH"\n' \
      > /etc/profile.d/openpalm-tools.sh

# The MANAGED OpenCode config (opencode.jsonc, instructions/) lives in
# OP_HOME/system/assistant/ and is bind-mounted at OPENCODE_CONFIG_DIR
# (/etc/opencode). OP_HOME/config/assistant/ is a DIFFERENT tree — the user's
# OpenCode global config, mounted at ~/.config/opencode.
# AGENTS.md is baked here as a default; the entrypoint seeds it into
# OPENCODE_CONFIG_DIR only if the operator has not placed their own copy there.
COPY containers/assistant/AGENTS.md /usr/local/share/openpalm/AGENTS.md

EXPOSE 4096 3000

# Probes OpenCode unconditionally, plus the UI co-process unless its build is
# absent or the supervisor exhausted its restart attempts. Those conditions
# write /tmp/openpalm-ui-skip and must not themselves register as a healthcheck
# failure. The UI probe hits the login/setup-exempt
# /health route on the FIXED in-container UI port 3000 (OP_UI_PORT is the
# host-facing knob and is deliberately NEVER passed into the container env, so
# the container-side default 3000 is always the real listen port). Mirrors
# core.compose.yml's own healthcheck (same skip-marker exemption, same fixed
# port). curl is already installed above.
#
# The /health probe ALWAYS authenticates — OpenCode requires a password in
# every configuration, so there is no posture to gate on. This variant
# additionally prefers a raw OPENCODE_SERVER_
# PASSWORD env value over the secret file (env wins, file fallback — mirrors
# the entrypoint's own resolve_opencode_server_password precedence) because a
# bare `docker run` may supply the password as env with no secret file
# mounted; the managed compose stack forbids raw `*_PASSWORD` env (secret-
# audit) so core.compose.yml's probe deliberately omits that branch. A
# HEALTHCHECK CMD is expanded by the container's own shell, not at Dockerfile
# build time, so healthcheck processes see created env (compose `environment:`
# / `docker run -e`) but never variables the entrypoint exports later.
#
# K6: interval/timeout/retries/start-period below MUST match core.compose.yml's
# assistant healthcheck (the raw-env-password branch above is the one
# deliberate exception — see the paragraph above). The compose values win in
# the shipped stack; this Dockerfile default only governs a bare `docker run`
# or image-smoke-test path with no compose in front of it — there is no
# reason for that path to have a different failure-detection threshold than
# the real stack, and healthcheck-parity.test.ts pins the two together so a
# future edit to one side alone fails CI instead of silently drifting again.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD bash -c 'curl -sf -u "${OPENCODE_SERVER_USERNAME:-opencode}:${OPENCODE_SERVER_PASSWORD:-$(cat "${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}")}" http://localhost:${OPENCODE_PORT:-4096}/health >/dev/null && { [ -f /tmp/openpalm-ui-skip ] || curl -sf http://localhost:3000/health >/dev/null; }' || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
USER node
