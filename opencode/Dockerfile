FROM oven/bun:1.1.42

RUN bun add -g opencode-ai@latest
RUN apt-get update && apt-get install -y tini cron curl openssh-server nodejs git && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# Extensions (skills/, commands/, agents/, tools/, plugins/) are baked into the image from
# opencode/extensions/ and installed to /root/.config/opencode/ at build time.
# At runtime, a host config volume may be mounted at /config to override defaults.
COPY extensions/ /root/.config/opencode/

COPY entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
