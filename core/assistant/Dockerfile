FROM oven/bun:1.3.5

ARG OPENCODE_VERSION=1.2.10
RUN bun add -g opencode-ai@${OPENCODE_VERSION} \
  && chmod o+x /root \
  && chmod -R o+rX /root/.bun
RUN apt-get update && apt-get install -y tini curl openssh-server nodejs git && rm -rf /var/lib/apt/lists/*

# Core OpenPalm-managed OpenCode extensions (immutable).
COPY extensions/ /opt/opencode/
# Remove test files — OpenCode loads all .ts files in plugins/ as plugins.
# Pre-install plugin dependencies and give UID 1000 write access.
RUN find /opt/opencode -name "*.test.ts" -delete \
  && cd /opt/opencode && bun install \
  && chown -R 1000:1000 /opt/opencode

# Create non-root user for runtime (UID/GID match compose OPENPALM_UID/GID defaults).
# The oven/bun base image ships a "bun" user at 1000:1000 — rename it to openpalm
# so the user name is consistent across all OpenPalm containers.
RUN groupmod -n openpalm bun && \
    usermod -l openpalm -d /home/openpalm -m bun

# Stable HOME mountpoint for user-global state.
RUN mkdir -p /home/opencode /work \
  && chown openpalm:openpalm /home/opencode /work \
  && chmod 755 /home/opencode /work

WORKDIR /work

COPY entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

USER openpalm

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
