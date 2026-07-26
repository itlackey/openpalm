# ── Assistant Service ──────────────────────────────────────────────────────────
# OpenCode AI runtime with OpenPalm extensions for the akm stash, policy,
# and tools. Config, plugins, and persona are mounted at runtime — not baked
# into the image.
#
# Tool packages (opencode-ai, akm-cli, etc.) are managed via the standard
# package.json pattern: baked defaults live at /opt/openpalm/tools/package.json
# and are updated within their semver ranges on every container start via
# `bun update`. Operators may pin different versions by editing
# OP_HOME/data/assistant/tools/package.json (bind-mounted at runtime).
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

# ── Tool builder stage ────────────────────────────────────────────────────────
# Install the agent CLIs from the single operator-editable manifest, then
# PARTITION node_modules into balanced groups. A single `npm install` produces
# one ~3.5GB layer (~1.75GB compressed) that Docker Hub's CDN rejects on push
# (HTTP 400 on the oversized blob). The final stage COPYs each group as its own
# layer (each < ~1GB) so every blob is comfortably pushable. NOT --platform
# pinned: native deps (onnxruntime, opencode/codex/copilot binaries) must match
# the TARGET arch.
FROM node:22-trixie-slim AS toolbuild
WORKDIR /opt/openpalm/tools
COPY containers/assistant/tools/package.json ./package.json
RUN npm install --omit=dev --no-fund --no-audit \
    && find node_modules/@anthropic-ai/claude-code -name "install.cjs" -exec node {} \; 2>/dev/null || true \
    && find node_modules ! -perm -o+r -exec chmod a+rX {} + \
    && mkdir -p /split/g1 /split/g2 \
    && mv node_modules/@github node_modules/@huggingface /split/g1/ \
    && mv node_modules/onnxruntime-node node_modules/@openai node_modules/@anthropic-ai /split/g2/

FROM node:22-trixie-slim

ARG BUN_VERSION=bun-v1.3.10
# Platform version — drives the OP_SKELETON_VERSION default in the entrypoint
# when no per-component env var override is set.
ARG PLATFORM_VERSION

# Re-export for runtime introspection.
ENV BUN_VERSION=${BUN_VERSION} \
    PLATFORM_VERSION=${PLATFORM_VERSION}

# Combined OS packages: base tools (tini) + assistant-specific
# (busybox crond/crontab tooling, python3, jq, gh) + DB clients (sqlite3,
# postgresql-client) so agents can query SQLite and Postgres directly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini curl git ca-certificates bash unzip \
        libglib2.0-0 \
        libnss-wrapper \
        busybox \
        python3 jq \
        sqlite3 postgresql-client \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install Bun into /usr/local. Later we override BUN_INSTALL +
# BUN_INSTALL_CACHE_DIR to per-user paths so unprivileged users can install
# additional packages at runtime.
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s -- "$BUN_VERSION"
ENV BUN_INSTALL=

# Bake default tool packages at /opt/openpalm/tools, assembled from the toolbuild
# stage as THREE COPY layers (g1, g2, and the remainder) so no single blob is the
# ~1.75GB monolith Docker Hub rejects on push. --chown sets opencode (UID 1000)
# ownership in-layer (no copy-up). At runtime, OP_HOME/data/assistant/tools is
# bind-mounted over this path; operators edit package.json + `bun update` keeps
# it current. The package.json is the single source of truth for the tool set.
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

# uv (Python package manager for apprise venv).
RUN curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 sh \
    && mv /root/.local/bin/uv /usr/local/bin/ \
    && mv /root/.local/bin/uvx /usr/local/bin/

# apprise — isolated venv via uv (avoids pip --break-system-packages).
# Used by the `notify` akm skill (apprise-backed).
RUN uv venv /opt/assistant-tools \
    && uv pip install --python /opt/assistant-tools/bin/python apprise
ENV PATH="/opt/assistant-tools/bin:$PATH"
ENV APPRISE_NOTIFY_CONFIG="/stash/env/apprise.conf"
ENV CLOUDSDK_CONFIG="/etc/openpalm/gcloud"
# GOOGLE_APPLICATION_CREDENTIALS is NOT set here — it must be supplied at
# runtime via stack.env or user.env if Google Cloud tools are needed.
# Baking a path here causes OpenCode to detect google-vertex-anthropic as
# connected on every install, even when the credentials file does not exist.

# gcloud CLI — required by the `gws-setup` skill for OAuth credential bootstrap.
RUN curl -fsSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-$(uname -m | sed 's/aarch64/arm/' | sed 's/x86_64/x86_64/').tar.gz \
      -o /tmp/gcloud.tar.gz \
    && tar xzf /tmp/gcloud.tar.gz -C /opt/ \
    && /opt/google-cloud-sdk/install.sh --quiet --usage-reporting false --path-update false \
    && rm /tmp/gcloud.tar.gz
ENV PATH="/opt/google-cloud-sdk/bin:$PATH"

# Google Workspace CLI — used by the `gws-setup` skill (gws-verify.sh + drive operations).
ARG GWS_VERSION=0.22.3
RUN set -e; \
    if [ "$(dpkg --print-architecture)" = "arm64" ]; then GWS_TRIPLE=aarch64-unknown-linux-gnu; else GWS_TRIPLE=x86_64-unknown-linux-gnu; fi \
    && curl -fsSL "https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/google-workspace-cli-${GWS_TRIPLE}.tar.gz" \
         | tar xz --strip-components=1 -C /usr/local/bin "google-workspace-cli-${GWS_TRIPLE}/gws" \
    && chmod +x /usr/local/bin/gws

# Seed the runtime dirs and make them group-writable so a container entered with
# `--user ${OP_UID}:${OP_GID}` can populate them on first boot. The container
# runs as the host operator's ARBITRARY uid:gid (not 1000), and Docker seeds a
# fresh `assistant-artifacts`/`assistant-persistent` named volume from these
# image paths WITH their ownership — so a fixed owner/group (the g=u "arbitrary
# uid" convention needs gid 0, which OpenPalm does not use) is not guaranteed to
# match the runtime ids; world-writable is the only image-side mode that works.
# Scope the chmod to these freshly created seed dirs ONLY — deliberately
# excluding /opt/openpalm/tools, whose baked node_modules + @huggingface model
# cache is a multi-hundred-MB tree split across COPY layers (Docker Hub rejects
# giant blobs); a recursive chmod over it would materialize a duplicate overlay
# layer. The tools tree is bind-mounted (host-owned) at runtime, so its baked
# mode is moot. Secrets (knowledge/secrets, 0600) are a separate bind-mount tree.
RUN mkdir -p /home/opencode/.cache /home/opencode/.local/bin /work /stash /opt/akm/cache /opt/akm/data /opt/persistent/bin \
    && mkdir -p /opt/openpalm/ui /opt/openpalm/skeleton /opt/openpalm/tools \
    && chown -R node:node /home/opencode /work /stash /opt/akm /opt/persistent /opt/openpalm/ui /opt/openpalm/skeleton \
    && chmod -R a+rwX /home/opencode /work /stash /opt/akm /opt/persistent /opt/openpalm/ui /opt/openpalm/skeleton

# ── Fallback @openpalm/ui bake ──────────────────────────────────────────────
# Same approach as containers/guardian/Dockerfile's baked guardian/skeleton
# install: put a real @openpalm/ui build at its runtime path INSIDE the image,
# so an offline/air-gapped/npm-outage first boot still has a UI to serve on the
# UI co-process port instead of silently publishing an empty port (the
# entrypoint's boot-time `npm install` in install_runtime_artifacts then
# upgrades this in place on every boot that CAN reach the registry — this bake
# is only the floor, not the steady-state install path). This works because
# assistant-artifacts (the named volume compose mounts at /opt/openpalm) is
# seeded from this image path the FIRST time the volume is created — unlike a
# bind mount, it does not shadow the baked content with an empty host directory.
# Skipped when PLATFORM_VERSION is unset (local/dev builds with no resolvable
# exact pin) so the image still builds without one; every versioned release
# build gets the fallback.
RUN if [ -n "$PLATFORM_VERSION" ]; then \
      npm install --prefix /opt/openpalm/ui "@openpalm/ui@${PLATFORM_VERSION}" \
        --omit=dev --no-fund --no-audit \
      && chmod -R a+rwX /opt/openpalm/ui; \
    else \
      echo "WARN: PLATFORM_VERSION unset at build time — no fallback @openpalm/ui baked (dev/local build only)" >&2; \
    fi

COPY containers/assistant/entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

WORKDIR /work

# Point Bun's user-writable paths at the opencode user's home.
ENV BUN_INSTALL=/home/opencode/.bun
ENV BUN_INSTALL_CACHE_DIR=/home/opencode/.cache/bun/install

# PATH precedence (highest first):
#   /opt/persistent/bin        — prefix-style global installs (escape hatch)
#   /opt/openpalm/tools/node_modules/.bin — managed tool packages (bun update)
#   /home/opencode/.local/bin  — per-user installs in the persistent home bind mount
#   /home/opencode/.bun/bin    — bun install -g (BUN_INSTALL points here)
#   /usr/local/bin             — image-baked system tools
ENV PATH="/opt/persistent/bin:/opt/openpalm/tools/node_modules/.bin:/home/opencode/.local/bin:/home/opencode/.bun/bin:/usr/local/bin:$PATH"

# A login shell (`bash -l`, e.g. the release smoke test and interactive ssh)
# re-runs /etc/profile, which on Debian overwrites PATH with the system default
# and drops the managed tool dirs from the ENV PATH above. Re-prepend them via
# profile.d so agent CLIs (opencode/akm/claude/codex/copilot/pi) resolve in
# login shells too.
RUN printf 'export PATH="/opt/persistent/bin:/opt/openpalm/tools/node_modules/.bin:/home/opencode/.local/bin:/home/opencode/.bun/bin:/opt/assistant-tools/bin:/opt/google-cloud-sdk/bin:$PATH"\n' \
      > /etc/profile.d/openpalm-tools.sh

# The MANAGED OpenCode config (opencode.jsonc, instructions/) lives in
# OP_HOME/system/assistant/ and is bind-mounted at OPENCODE_CONFIG_DIR
# (/etc/opencode). OP_HOME/config/assistant/ is a DIFFERENT tree — the user's
# OpenCode global config, mounted at ~/.config/opencode.
# AGENTS.md is baked here as a default; the entrypoint seeds it into
# OPENCODE_CONFIG_DIR only if the operator has not placed their own copy there.
COPY AGENTS.md /usr/local/share/openpalm/AGENTS.md

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
# #564 P1-1 (D3 mirror): the /health probe authenticates iff OPENCODE_AUTH is
# truthy, using the same truthy set and username/password resolution as
# core.compose.yml. This variant additionally prefers a raw OPENCODE_SERVER_
# PASSWORD env value over the secret file (env wins, file fallback — mirrors
# the entrypoint's own resolve_opencode_server_password precedence) because a
# bare `docker run` may supply the password as env with no secret file
# mounted; the managed compose stack forbids raw `*_PASSWORD` env (secret-
# audit) so core.compose.yml's probe deliberately omits that branch. A
# HEALTHCHECK CMD is expanded by the container's own shell, not at Dockerfile
# build time, so healthcheck processes see created env (compose `environment:`
# / `docker run -e`) but never variables the entrypoint exports later.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD bash -c 'case "${OPENCODE_AUTH:-false}" in true|TRUE|True|1|yes|YES) curl -sf -u "${OPENCODE_SERVER_USERNAME:-opencode}:${OPENCODE_SERVER_PASSWORD:-$(cat "${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}")}" http://localhost:${OPENCODE_PORT:-4096}/health >/dev/null ;; *) curl -sf http://localhost:${OPENCODE_PORT:-4096}/health >/dev/null ;; esac && { [ -f /tmp/openpalm-ui-skip ] || curl -sf http://localhost:${OP_UI_PORT:-3000}/health >/dev/null; }' || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
USER node
