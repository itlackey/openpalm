# syntax=docker/dockerfile:1.20
FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46

ARG PAPERCLIP_VERSION=2026.722.0

# Agent CLIs Paperclip's built-in local adapters spawn BY BARE NAME
# (`claude`, `codex`, `opencode`, `gemini` — see @paperclipai/server
# dist/adapters/registry.js). Upstream's own runtime image bakes these; this
# image must too, or every local agent run dies on a missing binary while the
# service still reports healthy (its healthcheck only probes /api/health).
#
# opencode-ai is pinned to the SAME version as the assistant and guardian
# images (containers/{assistant,guardian}/tools/package.json). AGENTS.md
# requires those pins stay in lockstep; this is now the third one — bump all
# three together.
ARG CLAUDE_CODE_VERSION=2.1.222
ARG CODEX_VERSION=0.146.0
ARG OPENCODE_VERSION=1.18.9
ARG GEMINI_CLI_VERSION=0.53.1

# ripgrep/python3/openssh-client/wget mirror upstream's runtime image: agent
# sessions shell out to them routinely, and a missing `rg` degrades an agent
# silently rather than loudly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl git wget ripgrep python3 openssh-client \
    && npm install --global --omit=dev \
      "paperclipai@${PAPERCLIP_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
      "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
    && node --input-type=module --eval \
      "import('/usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/db/dist/embedded-postgres-native.js').then(({ prepareEmbeddedPostgresNativeRuntime }) => prepareEmbeddedPostgresNativeRuntime())" \
    # Fail the BUILD, not the first agent run, if npm's hoisting ever stops
    # placing the server entry at the path CMD hardcodes. The package's own
    # `bin` (paperclipai) is a setup/ops CLI with no plain "serve" verb, so the
    # server entry is the correct target for a container — it just needs to be
    # asserted rather than assumed.
    && test -f /usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/index.js \
    # Same fail-fast for the adapter binaries: a silently missing CLI is the
    # exact defect this block exists to prevent.
    && for bin in claude codex opencode gemini; do command -v "$bin" >/dev/null || { echo "missing adapter CLI: $bin" >&2; exit 1; }; done \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /paperclip \
    && chown node:node /paperclip

ENV HOME=/paperclip \
    HOST=0.0.0.0 \
    PORT=3100 \
    SERVE_UI=true \
    PAPERCLIP_HOME=/paperclip \
    PAPERCLIP_INSTANCE_ID=default \
    PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
    PAPERCLIP_DEPLOYMENT_MODE=authenticated \
    PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
    PAPERCLIP_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1

EXPOSE 3100
USER node
CMD ["node", "/usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/index.js"]
