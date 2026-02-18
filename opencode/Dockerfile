FROM oven/bun:1.1.42

RUN bun add -g opencode-ai@latest
RUN apt-get update && apt-get install -y tini cron curl openssh-server && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# Bundle default OpenCode configuration/skills/plugins into the image.
COPY AGENTS.md /opt/opencode-defaults/AGENTS.md
COPY opencode.jsonc /opt/opencode-defaults/opencode.jsonc
COPY skills /opt/opencode-defaults/skills
COPY .opencode /opt/opencode-defaults/.opencode
COPY entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
