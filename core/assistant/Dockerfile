# ── Assistant Service ──────────────────────────────────────────────────────────
# OpenCode AI runtime with OpenPalm extensions for the akm stash, policy,
# and tools. Config, plugins, and persona are mounted at runtime — not baked
# into the image.
#
# Inherits Bun, OpenCode, and akm-cli from openpalm-base. See
# core/base/Dockerfile for the single source of truth on those versions.
# ──────────────────────────────────────────────────────────────────────────────

FROM openpalm-base

# Assistant-specific OS packages: sshd for remote agent sessions, sudo + socat
# for entrypoint privilege drop and Ollama proxy, Python (uv-managed venv for
# apprise — used by the notify skill), jq/ripgrep + gh for in-container tooling.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server sudo socat cron \
        python3 python3-pip python3-venv jq ripgrep \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Rename the base image's "node" user (UID 1000) to "opencode" for clarity.
# Passwordless sudo lets agents run root operations; the entrypoint's gosu
# drop keeps normal file I/O at the host user's UID.
RUN usermod -l opencode -d /home/opencode node \
    && groupmod -n opencode node \
    && mkdir -p /home/opencode \
    && chown opencode:opencode /home/opencode \
    && echo "opencode ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/opencode \
    && chmod 0440 /etc/sudoers.d/opencode

# yq (mikefarah), ast-grep, uv (Python package manager).
RUN set -e; \
    if [ "$(dpkg --print-architecture)" = "arm64" ]; then YQ_ARCH=arm64; else YQ_ARCH=amd64; fi \
    && curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${YQ_ARCH}" \
         -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq \
    && npm install -g @ast-grep/cli \
    && curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 sh \
    && mv /root/.local/bin/uv /usr/local/bin/ \
    && mv /root/.local/bin/uvx /usr/local/bin/

# apprise — isolated venv via uv (avoids pip --break-system-packages).
# Used by the `notify` skill in packages/assistant-tools.
RUN uv venv /opt/assistant-tools \
    && uv pip install --python /opt/assistant-tools/bin/python apprise
ENV PATH="/opt/assistant-tools/bin:$PATH"
ENV APPRISE_CONFIG="/etc/vault/apprise.conf"
ENV GOOGLE_APPLICATION_CREDENTIALS="/etc/vault/gcloud-credentials.json"
ENV CLOUDSDK_CONFIG="/etc/vault/.gcloud"

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

# OpenCode lives at /usr/local/.opencode/bin from the base image. Prepend the
# opencode user's local bin so per-user installs win.
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
# root-only setup (sshd, socat).
WORKDIR /work

# Point Bun's user-writable paths at the opencode user's home. Bun was
# installed into /usr/local by openpalm-base.
ENV BUN_INSTALL=/home/opencode/.bun
ENV BUN_INSTALL_CACHE_DIR=/home/opencode/.cache/bun/install
ENV PATH="/home/opencode/.local/bin:/home/opencode/.bun/bin:/usr/local/bin:$PATH"

RUN mkdir -p /etc/opencode
# Persona / config only. Built-in skills/commands/agents now live in the
# shared akm stash (bind-mounted at /akm), not in the image.
COPY core/assistant/opencode /etc/opencode


EXPOSE 4096 22

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD bash -c 'echo > /dev/tcp/localhost/${OPENCODE_PORT:-4096}' || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
