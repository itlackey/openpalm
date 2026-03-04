# ── Assistant Service ──────────────────────────────────────────────────────────
# OpenCode AI runtime with OpenPalm extensions for memory, policy, and tools.
# Installs opencode via official installer and loads extensions from /opt/opencode.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:lts-trixie

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini curl git ca-certificates bash openssh-server \
        python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*


# Install opencode to /usr/local/.opencode/bin (set HOME so installer puts it there)
RUN HOME=/usr/local curl -fsSL https://opencode.ai/install | HOME=/usr/local bash -s -- --no-modify-path
ENV PATH="/usr/local/.opencode/bin:$PATH"

RUN mkdir -p /home/opencode /work /opt/opencode \
    && chown node:node /home/opencode /work /opt/opencode \
    && sed -i 's@^#\?PasswordAuthentication .*@PasswordAuthentication no@' /etc/ssh/sshd_config \
    && sed -i 's@^#\?UsePAM .*@UsePAM no@' /etc/ssh/sshd_config \
    && sed -i 's@^#\?PermitRootLogin .*@PermitRootLogin no@' /etc/ssh/sshd_config

# Install plugin dependencies (offline fallback for npm registry)
COPY --chown=node:node packages/assistant-tools/ /opt/opencode/node_modules/@openpalm/assistant-tools/
COPY --chown=node:node core/assistant/package.json /opt/opencode/package.json
RUN cd /opt/opencode && npm install --omit=dev
RUN chown -R node:node /opt/opencode

# Copy openkit as a file-based plugin (workaround: OpenCode v1.2.15 only loads
# the last npm plugin from OPENCODE_CONFIG_DIR/node_modules/)
RUN mkdir -p /opt/opencode/plugins \
    && cp /opt/opencode/node_modules/@itlackey/openkit/dist/index.js /opt/opencode/plugins/openkit.js \
    && chown -R node:node /opt/opencode/plugins

# Copy config and persona
COPY --chown=node:node core/assistant/opencode.jsonc /opt/opencode/opencode.jsonc
COPY --chown=node:node packages/assistant-tools/AGENTS.md /opt/opencode/AGENTS.md

COPY core/assistant/entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

USER root
WORKDIR /work

# Install Bun to /usr/local so it's on PATH for all users
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/usr/local/bin:$PATH"

EXPOSE 4096 22

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD bash -c 'echo > /dev/tcp/localhost/${OPENCODE_PORT:-4096}' || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
