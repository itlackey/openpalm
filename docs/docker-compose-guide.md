# Hosting in a Single Compose Stack + Extending with Channels/Tools
*Extension guide: run everything in one compose file and safely grow the system.*

## A) Single `assets/docker-compose.yml` stack

### 1) Recommended layout
```
openpalm/
  assets/
    system.env
    user.env
    docker-compose.yml
    caddy/
    config/
  .env
  install.sh             Cross-platform installer (Linux/macOS/Windows Bash)

  opencode/              OpenCode Dockerfile (shared by core + channel runtimes)
  gateway/               Gateway service (Bun)
  admin/                 Admin API + bundled admin UI service (Bun)
  controller/            Container lifecycle service (Bun + Docker socket)
  channels/
    chat/                HTTP chat adapter
    discord/             Discord adapter
    voice/               Voice/STT adapter
    telegram/            Telegram adapter
  docker-compose.dev.yml Local override for source builds
  scripts/               CLI tools (extensions-cli.ts)
  docs/                  Architecture, API reference, guides
```

### 2) Compose file
> All host mounts follow the XDG Base Directory layout — data, config, and state
> are separated into `~/.local/share/openpalm`, `~/.config/openpalm`, and
> `~/.local/state/openpalm` respectively. The three `OPENPALM_*` env vars are
> resolved by `install.sh` and written into `.env`.

`install.sh` also persists container runtime settings in `.env` so lifecycle actions stay consistent:
- `OPENPALM_CONTAINER_PLATFORM` (`docker`, `podman`, `orbstack`)
- `OPENPALM_COMPOSE_BIN` + `OPENPALM_COMPOSE_SUBCOMMAND`
- `OPENPALM_CONTAINER_SOCKET_PATH` + `OPENPALM_CONTAINER_SOCKET_URI`

For local development, start by copying `assets/system.env` to `.env`.
Treat `system.env` as installer/system-managed (advanced users only), and put user-specific overrides in `assets/user.env`.

The full `assets/docker-compose.yml` file defines all services using published OpenPalm images. For local development builds, layer `docker-compose.dev.yml` on top. Key design points:

- **Two OpenCode runtimes** — `opencode-core` (port 4096, approval gates) and `opencode-channel` (port 4097, deny-by-default permissions). They use separate images: `openpalm-opencode-core` (user-configurable) and `openpalm-opencode-channel` (channel config bundled in image).
- **Gateway** connects to both runtimes via `OPENCODE_CORE_BASE_URL` and `OPENCODE_CHANNEL_BASE_URL`.
- **Caddy** sits in front as the reverse proxy, routing `/channels/*` to channel adapters and `/admin/*` to the admin app and dashboard UIs.
- **Channel adapters** are optional, enabled via `--profile channels`.
- **Admin-app** manages extensions, config, and containers via the controller.
- **Controller** is the only service with container engine socket access and runs compose commands using the persisted runtime settings.

See `assets/docker-compose.yml` for install/runtime defaults and `docker-compose.dev.yml` for local build overrides.

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
