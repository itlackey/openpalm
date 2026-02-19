FROM oven/bun:1.1.42

RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src

# Opencode agent config (AGENTS.md, opencode.jsonc, skills) baked into the image.
COPY opencode/ /root/.config/opencode/

RUN bun install --production

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "bun", "run", "src/server.ts"]
