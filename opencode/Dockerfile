FROM oven/bun:1.1.42

RUN bun add -g opencode-ai@latest
RUN apt-get update && apt-get install -y tini curl openssh-server nodejs git && rm -rf /var/lib/apt/lists/*

# Core OpenPalm-managed OpenCode extensions (immutable).
COPY extensions/ /opt/opencode/

# Stable HOME mountpoint for user-global state.
RUN mkdir -p /home/opencode /work \
  && chmod 755 /home/opencode /work

WORKDIR /work

COPY entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
