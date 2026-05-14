# ── Assistant Service ──────────────────────────────────────────────────────────
# OpenCode AI runtime with OpenPalm extensions for memory, policy, and tools.
# Config, plugins, and persona are mounted at runtime — not baked into the image.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:22-trixie-slim

# ── Pinned installer versions ────────────────────────────────────────────────
# Bump these ARGs when upgrading; keeps curl|bash installs reproducible.
ARG OPENCODE_VERSION=1.3.3
ARG BUN_VERSION=bun-v1.3.10
# akm-cli — Agent Kit Manager, installed globally via bun add -g.
ARG AKM_CLI_VERSION=^0.8.0-rc2

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

RUN mkdir -p /home/opencode/.cache /work /akm \
    && chmod 755 /home/opencode /home/opencode/.cache /akm \
    && chown opencode:opencode /home/opencode /home/opencode/.cache /work /akm \
    && sed -i 's@^#\?PasswordAuthentication .*@PasswordAuthentication no@' /etc/ssh/sshd_config \
    && sed -i 's@^#\?UsePAM .*@UsePAM no@' /etc/ssh/sshd_config \
    && sed -i 's@^#\?PermitRootLogin .*@PermitRootLogin no@' /etc/ssh/sshd_config

COPY core/assistant/entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

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

# Install akm-cli globally so every container shares the same stash CLI.
# BUN_INSTALL=/usr/local for this RUN puts the global install tree at
# /usr/local/install/global so the unprivileged opencode user (which the
# entrypoint drops to via gosu) can exec the binary without writing to its
# own $HOME. chmod -R a+rX makes the tree world-readable.
RUN BUN_INSTALL=/usr/local bun add -g "akm-cli@${AKM_CLI_VERSION}" \
    && chmod -R a+rX /usr/local/install/global \
    && chmod 755 /usr/local/bin/akm \
    && akm --version

RUN mkdir -p /etc/opencode
# Persona / config only — opencode.jsonc, system.md, openpalm.md. Built-in
# skills, commands, and agents now live in the shared akm stash
# (bind-mounted at /akm), not in the image. See `.openpalm/stash-seeds/`
# for the source-of-truth seeds and `seedStashAssets()` in @openpalm/lib
# for the install-time copy that respects user edits.
COPY core/assistant/opencode /etc/opencode

# ── Scheduler co-process ─────────────────────────────────────────────────
# The scheduler runs alongside OpenCode inside this container. It has no
# HTTP port — automations are read from /openpalm/config/automations and
# manual triggers come from sentinel files under /openpalm/data/scheduler/
# triggers. See core/assistant/entrypoint.sh for the supervisor logic.
#
# Pattern matches the previous standalone scheduler image: copy
# @openpalm/lib source into node_modules so the workspace:* dep resolves,
# then install the scheduler's remaining deps with bun (already on PATH).
COPY packages/lib /opt/scheduler/node_modules/@openpalm/lib
RUN cd /opt/scheduler/node_modules/@openpalm/lib && bun install --production
COPY packages/scheduler/package.json /opt/scheduler/package.json
COPY packages/scheduler/src /opt/scheduler/src
RUN cd /opt/scheduler \
    && bun -e "import {readFileSync,writeFileSync} from 'node:fs';const p=JSON.parse(readFileSync('package.json','utf8'));delete p.dependencies['@openpalm/lib'];writeFileSync('package.json',JSON.stringify(p,null,2))" \
    && rm -f bun.lock bun.lockb \
    && bun install --production \
    && chown -R opencode:opencode /opt/scheduler

EXPOSE 4096 22

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD bash -c 'echo > /dev/tcp/localhost/${OPENCODE_PORT:-4096}' || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
