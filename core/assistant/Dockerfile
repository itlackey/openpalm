# ── Assistant Service ──────────────────────────────────────────────────────────
# OpenCode AI runtime with OpenPalm extensions for memory, policy, and tools.
# Config, plugins, and persona are mounted at runtime — not baked into the image.
# ──────────────────────────────────────────────────────────────────────────────

FROM debian:trixie-slim AS varlock-fetch
ARG TARGETARCH
ARG VARLOCK_VERSION=0.4.0
ARG VARLOCK_SHA256_ARM64=e830baaa901b6389ecf281bdd2449bfaf7586e91fd3a7a038ec06f78e6fa92f8
ARG VARLOCK_SHA256_X64=820295b271cece2679b2b9701b5285ce39354fc2f35797365fa36c70125f51ab
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN set -e; \
  if [ "$TARGETARCH" = "arm64" ]; then ARCH=arm64; SHA256=$VARLOCK_SHA256_ARM64; \
  else ARCH=x64; SHA256=$VARLOCK_SHA256_X64; fi \
  && curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors "https://github.com/dmno-dev/varlock/releases/download/varlock%40${VARLOCK_VERSION}/varlock-linux-${ARCH}.tar.gz" -o /tmp/varlock.tar.gz \
  && echo "${SHA256}  /tmp/varlock.tar.gz" | sha256sum -c - \
  && tar xzf /tmp/varlock.tar.gz --strip-components=1 -C /usr/local/bin/ \
  && chmod +x /usr/local/bin/varlock && rm /tmp/varlock.tar.gz

FROM node:22-trixie-slim

# ── Pinned installer versions ────────────────────────────────────────────────
# Bump these ARGs when upgrading; keeps curl|bash installs reproducible.
ARG OPENCODE_VERSION=1.3.3
ARG BUN_VERSION=bun-v1.3.10
ARG AGENTIKIT_VERSION=v0.2.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini curl git ca-certificates bash openssh-server gosu sudo socat unzip \
        python3 python3-pip python3-venv \
        jq ripgrep \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ── opencode user (rename the base image's node user to opencode) ────────
# The node:22-trixie-slim base ships a "node" user at UID 1000. Rename it
# so the container has a purpose-named user. Passwordless sudo lets OpenCode
# agents run root operations (apt install, pip install, etc.) while the
# entrypoint's gosu drop keeps normal file I/O at the host user's UID.
RUN usermod -l opencode -d /home/opencode node \
    && groupmod -n opencode node \
    && mkdir -p /home/opencode \
    && chown opencode:opencode /home/opencode \
    && echo "opencode ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/opencode \
    && chmod 0440 /etc/sudoers.d/opencode

# ── CLI tools (yq, ast-grep, uv, azure-cli, huggingface-cli) ──────────────
# yq — YAML processor (mikefarah/yq)
RUN set -e; \
    if [ "$(dpkg --print-architecture)" = "arm64" ]; then YQ_ARCH=arm64; else YQ_ARCH=amd64; fi \
    && curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${YQ_ARCH}" \
         -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq

# ast-grep — structural code search (https://ast-grep.github.io/)
RUN npm install -g @ast-grep/cli

# uv — fast Python package manager (https://docs.astral.sh/uv/)
RUN curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 sh \
    && mv /root/.local/bin/uv /usr/local/bin/ \
    && mv /root/.local/bin/uvx /usr/local/bin/

# Azure CLI + Hugging Face CLI — installed into an isolated venv via uv
# (avoids pip --break-system-packages which modifies the system Python)
RUN uv venv /opt/assistant-tools \
    && uv pip install --python /opt/assistant-tools/bin/python azure-cli huggingface-hub[cli] apprise
ENV PATH="/opt/assistant-tools/bin:$PATH"
ENV APPRISE_CONFIG="/etc/vault/apprise.conf"
ENV GOOGLE_APPLICATION_CREDENTIALS="/etc/vault/gcloud-credentials.json"
ENV CLOUDSDK_CONFIG="/etc/vault/.gcloud"
ENV MGC_CONFIG_DIR="/etc/vault/.mgc"

# gcloud CLI — Google Cloud SDK
RUN curl -fsSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-$(uname -m | sed 's/aarch64/arm/' | sed 's/x86_64/x86_64/').tar.gz \
      -o /tmp/gcloud.tar.gz \
    && tar xzf /tmp/gcloud.tar.gz -C /opt/ \
    && /opt/google-cloud-sdk/install.sh --quiet --usage-reporting false --path-update false \
    && rm /tmp/gcloud.tar.gz
ENV PATH="/opt/google-cloud-sdk/bin:$PATH"

# Google Workspace CLI (https://github.com/googleworkspace/cli)
ARG GWS_VERSION=0.22.3
RUN set -e; \
    if [ "$(dpkg --print-architecture)" = "arm64" ]; then GWS_TRIPLE=aarch64-unknown-linux-gnu; else GWS_TRIPLE=x86_64-unknown-linux-gnu; fi \
    && curl -fsSL "https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/google-workspace-cli-${GWS_TRIPLE}.tar.gz" \
         | tar xz --strip-components=1 -C /usr/local/bin "google-workspace-cli-${GWS_TRIPLE}/gws" \
    && chmod +x /usr/local/bin/gws

# Microsoft Graph CLI (https://github.com/microsoftgraph/msgraph-cli)
# Only linux-x64 binaries are published; skip on arm64.
ARG MGC_VERSION=1.9.0
RUN set -e; \
    if [ "$(dpkg --print-architecture)" = "arm64" ]; then \
      echo "mgc: skipping — no linux-arm64 binary available"; \
    else \
      apt-get update \
      && apt-get install -y --no-install-recommends dbus gnome-keyring libsecret-1-0 \
      && rm -rf /var/lib/apt/lists/* \
      && curl -fsSL "https://github.com/microsoftgraph/msgraph-cli/releases/download/v${MGC_VERSION}/msgraph-cli-linux-x64-${MGC_VERSION}.tar.gz" \
           | tar xz -C /usr/local/bin; \
    fi


# Install opencode to /usr/local/.opencode/bin (set HOME so installer puts it there)
RUN HOME=/usr/local curl -fsSL https://opencode.ai/install | HOME=/usr/local bash -s -- --no-modify-path --version "$OPENCODE_VERSION"
ENV PATH="/home/opencode/.local/bin:/usr/local/.opencode/bin:$PATH"

RUN mkdir -p /home/opencode/.cache /work /home/opencode/.akm \
    && chmod 755 /home/opencode /home/opencode/.cache /home/opencode/.akm \
    && chown opencode:opencode /home/opencode /home/opencode/.cache /work /home/opencode/.akm \
    && sed -i 's@^#\?PasswordAuthentication .*@PasswordAuthentication no@' /etc/ssh/sshd_config \
    && sed -i 's@^#\?UsePAM .*@UsePAM no@' /etc/ssh/sshd_config \
    && sed -i 's@^#\?PermitRootLogin .*@PermitRootLogin no@' /etc/ssh/sshd_config

COPY core/assistant/entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
COPY core/assistant/varlock-shell.sh /usr/local/bin/varlock-shell
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh /usr/local/bin/varlock-shell

# NOTE: No final USER directive — container starts as root intentionally.
# The entrypoint uses gosu to drop to the "opencode" user (UID/GID from
# OP_UID/OP_GID, default 1000:1000) after root-only setup (sshd, socat).
# Agents get root access via passwordless sudo; normal file I/O runs as
# the unprivileged user so bind-mounted files keep the host user's ownership.
WORKDIR /work

# Install Bun binary to /usr/local so it's on PATH for all users.
# After install, reset BUN_INSTALL to a user-writable path so that
# bun install -g and the install cache work for the unprivileged user.
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s -- "$BUN_VERSION"
ENV BUN_INSTALL=/home/opencode/.bun
ENV BUN_INSTALL_CACHE_DIR=/home/opencode/.cache/bun/install
ENV PATH="/home/opencode/.local/bin:/home/opencode/.bun/bin:/usr/local/bin:$PATH"

# Install agentikit CLI; fix permissions so bun-compiled binary is readable
# by unprivileged users (bun-compiled binaries read themselves at runtime).
# The install script downloads a checksums.txt from the release and verifies
# the binary SHA-256 before installing.
RUN curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/"$AGENTIKIT_VERSION"/install.sh | bash -s -- "$AGENTIKIT_VERSION" \
    && chmod 755 /usr/local/bin/akm

COPY --from=varlock-fetch /usr/local/bin/varlock /usr/local/bin/varlock
RUN mkdir -p /usr/local/etc/varlock && mkdir -p /etc/opencode
COPY .openpalm/vault/redact.env.schema /usr/local/etc/varlock/.env.schema
COPY core/assistant/opencode /etc/opencode

EXPOSE 4096 22

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD bash -c 'echo > /dev/tcp/localhost/${OPENCODE_PORT:-4096}' || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
