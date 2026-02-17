# Hosting in a Single Docker Compose Stack + Extending with Channels/Tools
*Extension guide: run everything in one compose file and safely grow the system.*

## A) Single `docker-compose.yml` stack

### 1) Recommended layout
```
openclaw-min/
  docker-compose.yml
  .env

  opencode/
    Dockerfile
    opencode.jsonc
    AGENTS.md
    skills/
    .opencode/
      plugins/
      tools/

  gateway/
    Dockerfile
    src/
      server.ts
      channels/
      telemetry/
```

### 2) Compose file (Gateway + OpenCode + OpenMemory)
> Adjust image names/ports to your chosen OpenMemory distribution.
> All host mounts follow the XDG Base Directory layout — data, config, and state
> are separated into `~/.local/share/openpalm`, `~/.config/openpalm`, and
> `~/.local/state/openpalm` respectively. The three `OPENPALM_*` env vars are
> resolved by `install.sh` and written into `.env`.

```yaml
services:
  openmemory:
    image: skpassegna/openmemory-mcp:latest
    restart: unless-stopped
    ports:
      - "3000:3000"   # UI
      - "8765:8765"   # MCP/API
    volumes:
      - ${OPENPALM_DATA_HOME}/openmemory:/data
    networks: [assistant_net]

  opencode:
    build: ./opencode
    restart: unless-stopped
    environment:
      - OPENCODE_CONFIG=/config/opencode.jsonc
    ports:
      - "4096:4096"
    volumes:
      - ${OPENPALM_CONFIG_HOME}/opencode-core:/config
      - ${OPENPALM_STATE_HOME}/opencode-core:/state
      - ${OPENPALM_STATE_HOME}/workspace:/work
      - ${OPENPALM_DATA_HOME}/shared:/shared
    working_dir: /work
    command: ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
    networks: [assistant_net]
    depends_on: [openmemory]

  gateway:
    build: ./gateway
    restart: unless-stopped
    environment:
      - OPENCODE_BASE_URL=http://opencode:4096
      - OPENMEMORY_MCP_URL=http://openmemory:8765/mcp/gateway/sse/default-user
    ports:
      - "8080:8080"
    volumes:
      - ${OPENPALM_STATE_HOME}/gateway:/app/data
    networks: [assistant_net]
    depends_on: [opencode, openmemory]

networks:
  assistant_net:
```

---

## B) Containerizing OpenCode (no assumptions about official images)

### `opencode/Dockerfile`
```dockerfile
FROM node:22-slim

RUN npm i -g bun
RUN npm i -g opencode-ai

WORKDIR /work
RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
```

**Operational tips**
- Pin `opencode-ai` version after validation.
- Keep OpenCode on a private network; only expose the Gateway.

---

## C) Observability in Compose (minimal → real)

### Minimal
- Gateway subscribes to OpenCode SSE events and logs JSON lines.
- Use Docker logs for triage.

### Upgrade path
Add `otel-collector` + Grafana/Loki/Tempo (or integrate with your existing stack).
Gateway emits spans/metrics; OpenCode/OpenMemory logs ship to your aggregator.

---

## D) Extending with additional channels (without spaghetti)

### Rule: channels are dumb adapters
A channel container should only:
1) receive message/webhook
2) normalize to `{userId, channel, text, attachments, metadata}`
3) `POST /channel/inbound` to the Gateway via channel adapter
4) return response to the channel

### Add a channel to Compose
```yaml
  telegram:
    build: ./channels/telegram
    restart: unless-stopped
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - GATEWAY_URL=http://gateway:8080
    networks: [assistant_net]
    depends_on: [gateway]
```

### Channel identity
Channel adapter maps platform identity → your stable `userId`.
Gateway enforces per-user sessions, memory namespaces, tool policies.

---

## E) Extending with additional tools

### Prefer MCP servers for big integrations
- Isolate capabilities in separate processes/containers.
- Easier to revoke and secure.
- Add service + add MCP config.

### Use custom tools for “glue”
- redaction wrapper
- safe fetch allowlist
- gateway RPC tools

---

## F) Safety hard rules as you extend
Before shipping a channel/tool, check:
- adds network egress? → allowlist required
- touches filesystem? → sandbox paths + ask approvals
- stores memory? → explicit save + redaction
- replayable? → idempotency keys
- audited? → logs/spans with correlation IDs
