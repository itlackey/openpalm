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
      opencode-core/     Core agent extensions (plugins, skills, lib)
      opencode-gateway/  Intake agent extensions (skills)
      channel-env/       Channel-specific env files
  .env
  scripts/install.sh     Linux/macOS installer
  scripts/install.ps1    Windows PowerShell installer

  opencode/              OpenCode Core Dockerfile + entrypoint (no baked-in extensions)
  gateway/               Gateway service (Bun)
  admin/                 Admin API + bundled admin UI service (Bun)
  controller/            Container lifecycle service (Bun + Docker socket)
  channels/
    chat/                HTTP chat adapter
    discord/             Discord adapter
    voice/               Voice/STT adapter
    telegram/            Telegram adapter
  docker-compose.yml     Local override for source builds
  scripts/               CLI tools (extensions-cli.ts)
  docs/                  Architecture, API reference, guides
```

### 2) Compose file
> All host mounts follow the XDG Base Directory layout — data, config, and state
> are separated into `~/.local/share/openpalm`, `~/.config/openpalm`, and
> `~/.local/state/openpalm` respectively. The three `OPENPALM_*` env vars are
> resolved by `scripts/install.sh` / `scripts/install.ps1` and written into `.env`.

The installer also persists container runtime settings in `.env` so lifecycle actions stay consistent:
- `OPENPALM_CONTAINER_PLATFORM` (`docker`, `podman`, `orbstack`)
- `OPENPALM_COMPOSE_BIN` + `OPENPALM_COMPOSE_SUBCOMMAND`
- `OPENPALM_CONTAINER_SOCKET_PATH` + `OPENPALM_CONTAINER_SOCKET_URI`

For local development, start by copying `assets/system.env` to `.env`.
Treat `system.env` as installer/system-managed (advanced users only), and put user-specific overrides in `assets/user.env`.

The full `assets/docker-compose.yml` file defines all services using published OpenPalm images. For local development builds, layer `docker-compose.yml` on top. Key design points:

- **Single OpenCode runtime** — `opencode-core` (port 4096) hosts both the full agent (approval gates) and the `channel-intake` agent (all tools denied). Agent-level permissions provide isolation without requiring a separate runtime. Extensions (plugins, skills, lib) are volume-mounted from the host config directory, not baked into the container image.
- **Gateway** connects to `opencode-core` via `OPENCODE_CORE_BASE_URL` and uses the `channel-intake` agent for intake validation.
- **Caddy** sits in front as the reverse proxy, routing `/channels/*` to channel adapters and `/admin/*` to the admin app and dashboard UIs.
- **Channel adapters** are optional, enabled via `--profile channels`.
- **Admin-app** manages extensions, config, and containers via the controller.
- **Controller** is the only service with container engine socket access and runs compose commands using the persisted runtime settings.

See `assets/docker-compose.yml` for install/runtime defaults and `docker-compose.yml` for local build overrides.

---

## B) Containerizing OpenCode (no assumptions about official images)

### `opencode/Dockerfile`
```dockerfile
FROM oven/bun:1.1.42

RUN bun add -g opencode-ai@latest
RUN apt-get update && apt-get install -y tini cron curl openssh-server nodejs && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# Extensions (plugins, skills, agents, lib) are NOT baked into the image.
# They are kept in assets/config/opencode-core/, copied to the host config
# directory during install, and volume-mounted into /config at runtime.

COPY entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod +x /usr/local/bin/opencode-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opencode-entrypoint.sh"]
```

**Operational tips**
- Pin `opencode-ai` version after validation.
- Keep OpenCode on a private network; only expose the Gateway.
- Extensions are managed via the `assets/config/opencode-core/` directory and seeded into the host config home by the installer. This keeps the container image lean and allows extensions to be updated without rebuilding the image.

---

## C) Observability in Compose (minimal -> real)

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
Channel adapter maps platform identity -> your stable `userId`.
Gateway enforces per-user sessions, memory namespaces, tool policies.

---

## E) Extending with additional tools

### Prefer MCP servers for big integrations
- Isolate capabilities in separate processes/containers.
- Easier to revoke and secure.
- Add service + add MCP config.

### Use custom tools for "glue"
- redaction wrapper
- safe fetch allowlist
- gateway RPC tools

---

## F) Safety hard rules as you extend
Before shipping a channel/tool, check:
- adds network egress? -> allowlist required
- touches filesystem? -> sandbox paths + ask approvals
- stores memory? -> explicit save + redaction
- replayable? -> idempotency keys
- audited? -> logs/spans with correlation IDs
