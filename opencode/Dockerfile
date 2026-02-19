FROM oven/bun:1.1.42

RUN bun add -g opencode-ai@latest
RUN apt-get update && apt-get install -y tini cron curl openssh-server nodejs && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# Extensions (plugins, skills, agents, lib) are NOT baked into the image.
# They are kept in the assets directory, copied to the host config directory
# during install, and volume-mounted into /config at runtime.
# See assets/config/opencode-core/ for the canonical extension source.

COPY entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
