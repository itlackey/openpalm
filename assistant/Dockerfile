FROM oven/bun:1.1.42

RUN bun add -g opencode-ai@latest \
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
ARG OPENPALM_UID=1000
ARG OPENPALM_GID=1000
RUN addgroup --system --gid ${OPENPALM_GID} openpalm && \
    adduser --system --uid ${OPENPALM_UID} --ingroup openpalm openpalm

# Stable HOME mountpoint for user-global state.
RUN mkdir -p /home/opencode /work \
  && chown ${OPENPALM_UID}:${OPENPALM_GID} /home/opencode /work \
  && chmod 755 /home/opencode /work

WORKDIR /work

COPY entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

USER openpalm

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
