# ── Assistant Service ──────────────────────────────────────────────────────────
# OpenCode AI runtime with OpenPalm extensions for memory, policy, and tools.
# Config, plugins, and persona are mounted at runtime — not baked into the image.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:lts-trixie

# ── Pinned installer versions ────────────────────────────────────────────────
# Bump these ARGs when upgrading; keeps curl|bash installs reproducible.
ARG OPENCODE_VERSION=1.2.24
ARG BUN_VERSION=bun-v1.3.10
ARG AGENTIKIT_VERSION=v0.0.15

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini curl git ca-certificates bash openssh-server gosu \
        python3 python3-pip \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*


# Install opencode to /usr/local/.opencode/bin (set HOME so installer puts it there)
RUN HOME=/usr/local curl -fsSL https://opencode.ai/install | HOME=/usr/local bash -s -- --no-modify-path --version "$OPENCODE_VERSION"
ENV PATH="/usr/local/.opencode/bin:$PATH"

RUN mkdir -p /home/opencode/.cache /work \
    && chmod 777 /home/opencode /home/opencode/.cache \
    && chown node:node /home/opencode /home/opencode/.cache /work \
    && sed -i 's@^#\?PasswordAuthentication .*@PasswordAuthentication no@' /etc/ssh/sshd_config \
    && sed -i 's@^#\?UsePAM .*@UsePAM no@' /etc/ssh/sshd_config \
    && sed -i 's@^#\?PermitRootLogin .*@PermitRootLogin no@' /etc/ssh/sshd_config

COPY core/assistant/entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

USER root
WORKDIR /work

# Install Bun binary to /usr/local so it's on PATH for all users.
# After install, reset BUN_INSTALL to a user-writable path so that
# bun install -g and the install cache work for the unprivileged user.
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s -- "$BUN_VERSION"
ENV BUN_INSTALL=/home/opencode/.bun
ENV BUN_INSTALL_CACHE_DIR=/home/opencode/.cache/bun/install
ENV PATH="/home/opencode/.bun/bin:/usr/local/bin:$PATH"

# Install agentikit CLI; fix permissions so bun-compiled binary is readable
# by unprivileged users (bun-compiled binaries read themselves at runtime).
# The install script downloads a checksums.txt from the release and verifies
# the binary SHA-256 before installing.
RUN curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/"$AGENTIKIT_VERSION"/install.sh | bash -s -- "$AGENTIKIT_VERSION" \
    && chmod 755 /usr/local/bin/akm

EXPOSE 4096 22

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD bash -c 'echo > /dev/tcp/localhost/${OPENCODE_PORT:-4096}' || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
