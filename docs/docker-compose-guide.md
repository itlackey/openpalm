# Hosting in a Single Docker Compose Stack + Extending with Channels/Tools
*Extension guide: run everything in one compose file and safely grow the system.*

## A) Single `docker-compose.yml` stack

### 1) Recommended layout
```
openpalm/
  docker-compose.yml
  .env
  install.sh

  opencode/              OpenCode Dockerfile (shared by core + channel runtimes)
  gateway/               Gateway service (Bun)
  admin-app/             Admin API service (Bun)
  controller/            Container lifecycle service (Bun + Docker socket)
  admin-ui/              Vanilla JS SPA for admin dashboard
  caddy/                 Caddyfile (reverse proxy config)
  channels/
    chat/                HTTP chat adapter
    discord/             Discord adapter
    voice/               Voice/STT adapter
    telegram/            Telegram adapter
  config/
    opencode-core/       Default agent config for core runtime
    opencode-channel/    Default agent config for channel runtime
    channel-env/         Default channel env files
  scripts/               CLI tools (extensions-cli.ts)
  docs/                  Architecture, API reference, guides
```

### 2) Compose file
> All host mounts follow the XDG Base Directory layout — data, config, and state
> are separated into `~/.local/share/openpalm`, `~/.config/openpalm`, and
> `~/.local/state/openpalm` respectively. The three `OPENPALM_*` env vars are
> resolved by `install.sh` and written into `.env`.

The full `docker-compose.yml` in the repository root defines all services. Key design points:

- **Two OpenCode runtimes** — `opencode-core` (port 4096, approval gates) and `opencode-channel` (port 4097, deny-by-default permissions). Both build from `./opencode` but use different config files.
- **Gateway** connects to both runtimes via `OPENCODE_CORE_BASE_URL` and `OPENCODE_CHANNEL_BASE_URL`.
- **Caddy** sits in front as the reverse proxy, routing `/channels/*` to channel adapters and `/admin/*` to the admin app and dashboard UIs.
- **Channel adapters** are optional, enabled via `--profile channels`.
- **Admin-app** manages extensions, config, and containers via the controller.
- **Controller** is the only service with Docker socket access.

See `docker-compose.yml` for the complete service definitions.

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
