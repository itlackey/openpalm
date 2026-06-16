# ── Guardian Service ───────────────────────────────────────────────────────────
# Bun-based message guardian. Receives signed channel messages, validates
# HMAC + nonce + rate limits, forwards to the assistant. Ships the OpenCode
# binary so guardian-side OpenCode instances share provider config with the
# assistant (auth.json) and read their global config from /etc/opencode.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.3-slim

# curl + unzip + bash + ca-certificates are required by the OpenCode installer.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip bash ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# OpenCode binary. Mirrors the assistant image: install with HOME=/usr/local so
# the binary lands at /usr/local/.opencode/bin and is reachable from any user.
# Keep OPENCODE_VERSION in lockstep with containers/assistant/Dockerfile.
ARG OPENCODE_VERSION=1.17.7
ENV OPENCODE_VERSION=${OPENCODE_VERSION}
RUN HOME=/usr/local curl -fsSL https://opencode.ai/install \
        | HOME=/usr/local bash -s -- --no-modify-path --version "$OPENCODE_VERSION"
ENV PATH="/usr/local/.opencode/bin:$PATH"

# OpenCode reads its operator-managed global config from /etc/opencode, which
# is bind-mounted from OP_HOME/config/guardian (see portals.compose.yml).
ENV OPENCODE_CONFIG_DIR=/etc/opencode

# NOTE: akm-cli is intentionally NOT installed here. The guardian's OpenCode is
# a pure content moderator (opencode.jsonc denies bash/edit/webfetch and uses no
# akm-opencode plugin) and portals.compose.yml mounts NO stash/config/cache/data
# or AKM_* env into the guardian — so an installed akm would only ever operate on
# an ephemeral default stash under $HOME, never the managed one. Removed to avoid
# an unmanaged third akm instance and unjustified image weight (proposal I-7). If
# the guardian ever needs akm, wire it as a read-ONLY reader (own data/cache,
# never a third writer) — do not reintroduce a bare global install.

WORKDIR /app
COPY containers/guardian/ .
RUN rm -f bun.lock bun.lockb \
    && bun install --production

RUN mkdir -p /opt/openpalm/guardian /app/audit /app/secrets \
    && chmod +x /app/entrypoint.sh

ENV HOME=/opt/openpalm/guardian
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1

# The entrypoint starts the local OpenCode moderator (when content validation is
# enabled) and then launches the guardian server.
CMD ["./entrypoint.sh"]
