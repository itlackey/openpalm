# ── Assistant Service ──────────────────────────────────────────────────────────
# OpenCode AI runtime with OpenPalm extensions for the akm stash, policy,
# and tools. Config, plugins, and persona are mounted at runtime — not baked
# into the image.
#
# v0.11.0: this is the only image that needs Bun + OpenCode + akm-cli, so
# the previously-shared `openpalm-base` image has been inlined here.
# Guardian/channel use `oven/bun:1.3-slim` directly. CI keeps AKM_CLI_VERSION
# between this file and core/guardian/Dockerfile in lockstep.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:22-trixie-slim

ARG OPENCODE_VERSION=1.3.3
ARG BUN_VERSION=bun-v1.3.10
ARG AKM_CLI_VERSION=^0.8.0-rc2

# Re-export for runtime introspection.
ENV OPENCODE_VERSION=${OPENCODE_VERSION} \
    BUN_VERSION=${BUN_VERSION} \
    AKM_CLI_VERSION=${AKM_CLI_VERSION}

# Combined OS packages: base tools (tini, gosu) + assistant-specific
# (openssh-server, sudo, cron, python3, jq, gh).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini curl git ca-certificates bash gosu unzip \
        openssh-server sudo cron python3 jq \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# OpenCode installer drops the binary under $HOME/.opencode/bin. Pin
# HOME=/usr/local so the binary lands at /usr/local/.opencode/bin and is
# reachable from every user the entrypoint switches to.
RUN HOME=/usr/local curl -fsSL https://opencode.ai/install \
        | HOME=/usr/local bash -s -- --no-modify-path --version "$OPENCODE_VERSION"
ENV PATH="/usr/local/.opencode/bin:$PATH"

# Install Bun into /usr/local. Later we override BUN_INSTALL +
# BUN_INSTALL_CACHE_DIR to per-user paths so unprivileged users can install
# additional packages at runtime.
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s -- "$BUN_VERSION"

# Install akm-cli globally. chmod a+rX makes it world-readable so the
# unprivileged opencode user can exec the binary.
RUN BUN_INSTALL=/usr/local bun add -g "akm-cli@${AKM_CLI_VERSION}" \
    && chmod -R a+rX /usr/local/install/global \
    && chmod 755 /usr/local/bin/akm \
    && akm --version
ENV BUN_INSTALL=

# Rename the base "node" user (UID 1000) to "opencode" for clarity.
# Passwordless sudo lets agents run root operations; the entrypoint's gosu
# drop keeps normal file I/O at the host user's UID.
RUN usermod -l opencode -d /home/opencode node \
    && groupmod -n opencode node \
    && mkdir -p /home/opencode \
    && chown opencode:opencode /home/opencode \
    && echo "opencode ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/opencode \
    && chmod 0440 /etc/sudoers.d/opencode

# uv (Python package manager for apprise venv).
RUN curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 sh \
    && mv /root/.local/bin/uv /usr/local/bin/ \
    && mv /root/.local/bin/uvx /usr/local/bin/

# apprise — isolated venv via uv (avoids pip --break-system-packages).
# Used by the `notify` skill in packages/assistant-tools.
RUN uv venv /opt/assistant-tools \
    && uv pip install --python /opt/assistant-tools/bin/python apprise
ENV PATH="/opt/assistant-tools/bin:$PATH"
ENV APPRISE_CONFIG="/etc/vault/apprise.conf"
ENV CLOUDSDK_CONFIG="/etc/vault/.gcloud"
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

# Prepend opencode user's local bin so per-user installs win.
ENV PATH="/home/opencode/.local/bin:/usr/local/.opencode/bin:$PATH"

RUN mkdir -p /home/opencode/.cache /work /akm \
    && chmod 755 /home/opencode /home/opencode/.cache /akm \
    && chown opencode:opencode /home/opencode /home/opencode/.cache /work /akm \
    && sed -i 's@^#\?PasswordAuthentication .*@PasswordAuthentication no@' /etc/ssh/sshd_config \
    && sed -i 's@^#\?UsePAM .*@UsePAM no@' /etc/ssh/sshd_config \
    && sed -i 's@^#\?PermitRootLogin .*@PermitRootLogin no@' /etc/ssh/sshd_config

COPY core/assistant/entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

# Container starts as root intentionally. The entrypoint uses gosu to drop to
# the "opencode" user (UID/GID from OP_UID/OP_GID, default 1000:1000) after
# root-only setup (sshd, uid/gid adjustment).
WORKDIR /work

# Point Bun's user-writable paths at the opencode user's home.
ENV BUN_INSTALL=/home/opencode/.bun
ENV BUN_INSTALL_CACHE_DIR=/home/opencode/.cache/bun/install
ENV PATH="/home/opencode/.local/bin:/home/opencode/.bun/bin:/usr/local/bin:$PATH"

# OpenCode config (opencode.jsonc, openpalm.md, system.md) now lives in
# OP_HOME/config/assistant/ and is bind-mounted at OPENCODE_CONFIG_DIR.
# Nothing needs to be baked into the image.


EXPOSE 4096 22

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD bash -c 'echo > /dev/tcp/localhost/${OPENCODE_PORT:-4096}' || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
