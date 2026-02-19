FROM oven/bun:1.1.42

RUN bun add -g opencode-ai@latest
RUN apt-get update && apt-get install -y tini cron curl openssh-server nodejs && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# Bundle default OpenCode configuration/skills/plugins into the image.
# Layout matches OPENCODE_CONFIG_DIR expectations:
#   /opt/opencode-defaults/
#     opencode.jsonc   — main config
#     AGENTS.md        — safety rules
#     skills/          — behavioral skill files
#     plugins/         — OpenCode plugins (auto-discovered)
#     lib/             — shared libraries used by plugins
COPY AGENTS.md /opt/opencode-defaults/AGENTS.md
COPY opencode.jsonc /opt/opencode-defaults/opencode.jsonc
COPY skills /opt/opencode-defaults/skills
COPY plugins /opt/opencode-defaults/plugins
COPY lib /opt/opencode-defaults/lib
COPY entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
