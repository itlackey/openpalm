# Varlock Fetch — shared build stage for runtime secret redaction binary
#
# This Dockerfile is the single source of truth for the varlock version,
# checksums, and download logic. All service Dockerfiles consume the built
# image via Docker Compose additional_contexts:
#
#   additional_contexts:
#     varlock: docker-image://${OP_IMAGE_NAMESPACE:-openpalm}/varlock:${OP_IMAGE_TAG:-latest}
#
# Then in each Dockerfile:
#   COPY --from=varlock /usr/local/bin/varlock /usr/local/bin/varlock
#
# Build:
#   docker compose build varlock   (via compose.dev.yaml)

FROM debian:trixie-slim
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
