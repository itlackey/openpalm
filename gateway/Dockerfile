FROM oven/bun:1.1.42

RUN bun add -g opencode-ai@latest && apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY gateway/package.json gateway/tsconfig.json ./
COPY gateway/src ./src
COPY gateway/entrypoint.sh /usr/local/bin/gateway-entrypoint.sh
COPY opencode-channel/AGENTS.md /opt/opencode-channel-defaults/AGENTS.md
COPY opencode-channel/opencode.channel.jsonc /opt/opencode-channel-defaults/opencode.channel.jsonc
COPY opencode-channel/skills /opt/opencode-channel-defaults/skills
COPY opencode-channel/.opencode /opt/opencode-channel-defaults/.opencode

RUN bun install --production && chmod +x /usr/local/bin/gateway-entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/gateway-entrypoint.sh"]
