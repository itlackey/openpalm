# ── OpenPalm Base Image ───────────────────────────────────────────────────────
# Shared foundation for admin and assistant. Bundles Bun, OpenCode, and
# akm-cli at pinned versions so admin and assistant CANNOT drift apart.
#
# This file is the SINGLE SOURCE OF TRUTH for OPENCODE_VERSION, BUN_VERSION,
# and AKM_CLI_VERSION across the admin and assistant images.
#
# Guardian uses oven/bun:1.3-slim and only needs akm-cli + bun, so it does NOT
# inherit from this image. Its AKM_CLI_VERSION is kept manually in sync.
#
# Built locally via `docker compose --profile build build openpalm-base`.
# Not published to a registry as part of normal releases — CI publishes a
# SHA-tagged copy to ghcr.io for use as a build-context only.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:22-trixie-slim

ARG OPENCODE_VERSION=1.3.3
ARG BUN_VERSION=bun-v1.3.10
ARG AKM_CLI_VERSION=^0.8.0-rc2

# Re-export so child images and runtime introspection can see pinned versions.
ENV OPENCODE_VERSION=${OPENCODE_VERSION} \
    BUN_VERSION=${BUN_VERSION} \
    AKM_CLI_VERSION=${AKM_CLI_VERSION}

# Intersection of admin + assistant runtime needs. tini + gosu live here
# because the assistant uses them as init/privilege-drop primitives; they're
# tiny and harmless when admin doesn't reference them.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini curl git ca-certificates bash gosu unzip \
    && rm -rf /var/lib/apt/lists/*

# OpenCode installer drops the binary under $HOME/.opencode/bin. Pin
# HOME=/usr/local so the binary lands at /usr/local/.opencode/bin and is
# reachable from every user the child images switch to.
RUN HOME=/usr/local curl -fsSL https://opencode.ai/install \
        | HOME=/usr/local bash -s -- --no-modify-path --version "$OPENCODE_VERSION"
ENV PATH="/usr/local/.opencode/bin:$PATH"

# Install Bun into /usr/local. Children override BUN_INSTALL +
# BUN_INSTALL_CACHE_DIR to user-writable paths at runtime so subsequent
# `bun install -g` and the install cache work for unprivileged users.
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s -- "$BUN_VERSION"

# Install akm-cli globally with BUN_INSTALL=/usr/local so the install tree
# lands at /usr/local/install/global. chmod a+rX makes it world-readable so
# unprivileged users in child images can exec the binary.
RUN BUN_INSTALL=/usr/local bun add -g "akm-cli@${AKM_CLI_VERSION}" \
    && chmod -R a+rX /usr/local/install/global \
    && chmod 755 /usr/local/bin/akm \
    && akm --version

ENV BUN_INSTALL=
