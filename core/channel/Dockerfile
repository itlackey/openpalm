# ── Channel Runner — Unified container for npm-based OpenPalm channels ────────
#
# Runs any channel published as an npm package that extends BaseChannel.
# Set CHANNEL_PACKAGE to the npm package name at runtime.
# Falls back to CHANNEL_FILE for legacy file-based channels.
# ──────────────────────────────────────────────────────────────────────────────

# ── Varlock Fetch ─────────────────────────────────────────────────────────────
FROM debian:trixie-slim AS varlock-fetch
ARG TARGETARCH
ARG VARLOCK_VERSION=0.4.0
ARG VARLOCK_SHA256_AMD64=820295b271cece2679b2b9701b5285ce39354fc2f35797365fa36c70125f51ab
ARG VARLOCK_SHA256_ARM64=e830baaa901b6389ecf281bdd2449bfaf7586e91fd3a7a038ec06f78e6fa92f8
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN set -e; \
  if [ "$TARGETARCH" = "arm64" ]; then \
    VARLOCK_ARCH=arm64; VARLOCK_SHA256="$VARLOCK_SHA256_ARM64"; \
  else \
    VARLOCK_ARCH=x64; VARLOCK_SHA256="$VARLOCK_SHA256_AMD64"; \
  fi \
  && curl -fsSL \
       --retry 5 --retry-delay 10 --retry-all-errors \
       "https://github.com/dmno-dev/varlock/releases/download/varlock%40${VARLOCK_VERSION}/varlock-linux-${VARLOCK_ARCH}.tar.gz" \
       -o /tmp/varlock.tar.gz \
  && echo "${VARLOCK_SHA256}  /tmp/varlock.tar.gz" | sha256sum -c - \
  && tar xzf /tmp/varlock.tar.gz --strip-components=1 -C /usr/local/bin/ \
  && chmod +x /usr/local/bin/varlock \
  && rm /tmp/varlock.tar.gz

FROM oven/bun:1.3-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Install the channels SDK
COPY packages/channels-sdk /app/node_modules/@openpalm/channels-sdk
RUN cd /app/node_modules/@openpalm/channels-sdk && bun install --production

# Startup script installs the channel package (if set) then runs the entrypoint
COPY core/channel/start.sh /app/start.sh
RUN chmod +x /app/start.sh

COPY --from=varlock-fetch /usr/local/bin/varlock /usr/local/bin/varlock
COPY assets/secrets.env.schema /app/secrets.env.schema

RUN chown -R bun:bun /app

ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf "http://localhost:${PORT}/health" || exit 1

USER bun
CMD ["/app/start.sh"]
