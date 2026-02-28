# OpenPalm Configuration Files

This directory contains the static infrastructure configuration for OpenPalm. These files work in two modes:

1. **Standalone** — Copy to a directory, create a `.env` or `secrets.env`, run `docker compose up`.
2. **Admin-managed** — The admin service bundles channel definitions from `registry/` at build time as a catalog. Channels are installed on demand via `POST /admin/channels/install`, which copies files to `CONFIG_HOME/channels/`. Channels can also be added manually by dropping files into the same directory.

## File Layout

```
docker-compose.yml       # Core services (never changes for channel additions)
Caddyfile                # Core reverse proxy routes (auto-imports channel routes)
secrets.env              # Environment variable reference with documentation
```

Channel definitions live in the `registry/` directory at the repo root (see `registry/`).

## How It Works

### Docker Compose Overlays

The core `docker-compose.yml` defines infrastructure services. Channel services live in separate compose files that are merged at runtime using the `-f` flag:

```bash
docker compose \
  -f docker-compose.yml \
  -f registry/chat.yml \
  -f registry/discord.yml \
  --env-file secrets.env \
  up -d
```

Docker Compose merges all `-f` files into a single configuration. Channel overlays can reference networks and services defined in the core file.

### Caddy Imports

The core `Caddyfile` includes these lines:

```caddy
import channels/public/*.caddy
import channels/lan/*.caddy
```

Caddy loads staged `.caddy` files from the `channels/public/` and `channels/lan/` directories at startup. No changes to the core Caddyfile are needed when adding or removing channels.

In admin-managed mode, this file is seeded to and managed from
`DATA_HOME/caddy/Caddyfile`, then staged to `STATE_HOME/artifacts/Caddyfile` during apply.

**Caddy files are optional.** If a channel has no `.caddy` file, it gets no HTTP route through Caddy and is only accessible on the Docker network (host and other containers). This is the default for channels that don't need public or LAN access.

### Access Control

The Caddyfile defines a `(lan_only)` snippet:

```caddy
(lan_only) {
    @denied not remote_ip 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 ::1 fc00::/7 fe80::/10
    abort @denied
}
```

Channel `.caddy` files are LAN-restricted by default. Add `import public_access` to opt into public routing.

For host-only access (localhost only), replace the IP ranges with `127.0.0.1 ::1`.

### Environment Variables

Each service's `environment:` block lists only the `${VAR}` references it needs. Docker Compose substitutes values from:

- A `.env` file in the project directory (standalone default)
- An explicit `--env-file secrets.env` flag

This means each container only receives the secrets it explicitly declares — the guardian gets channel secrets, the assistant gets API keys, postgres gets its password, etc.

## Adding a New Channel

To add a channel called `my-channel` that runs on port 8185:

### 1. Create the compose overlay

Create `registry/my-channel.yml`:

```yaml
services:
  channel-my-channel:
    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-my-channel:${OPENPALM_IMAGE_TAG:-latest}
    restart: unless-stopped
    environment:
      PORT: "8185"
      GUARDIAN_URL: http://guardian:8080
      CHANNEL_MY_CHANNEL_SECRET: ${CHANNEL_MY_CHANNEL_SECRET}
    networks: [channel_lan]
    depends_on:
      guardian:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/8185' || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
```

**That's it for basic setup.** The channel will be accessible on the Docker network to other services and from the host. No Caddy file is needed unless you want HTTP routing.

### 2. (Optional) Create a Caddy route

If you want the channel accessible via Caddy HTTP routing (LAN-restricted by default), create `registry/my-channel.caddy`:

```caddy
handle_path /channels/my-channel/* {
    import lan_only
    reverse_proxy channel-my-channel:8185
}
```

Add `import public_access` if the channel should be publicly accessible.

### 3. Add the secret to your env file (standalone mode)

Add to `secrets.env` (or `.env`):

```
CHANNEL_MY_CHANNEL_SECRET=<generated-secret>
```

Generate with: `openssl rand -hex 16`

In this repository's compose file, guardian reads `CHANNEL_*_SECRET` values via
`env_file` from `STATE_HOME/artifacts/secrets.env`.

### 4. Start with the new channel

```bash
docker compose \
  -f docker-compose.yml \
  -f registry/chat.yml \
  -f registry/my-channel.yml \
  --env-file secrets.env \
  up -d
```

### Installing a channel via the admin API

When running admin-managed, install channels from the registry catalog:

```bash
curl -X POST http://localhost:8100/admin/channels/install \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "my-channel"}'
```

Or add channels manually without rebuilding the container:

1. Place `my-channel.yml` (and optional `my-channel.caddy`) in `$OPENPALM_CONFIG_HOME/channels/`
2. No manual channel secret is required; admin generates and stages it
3. The admin's install/update endpoint will discover the new channel automatically
4. No code changes or container rebuilds required

The admin scans `CONFIG_HOME/channels/` at runtime to discover all `.yml` files and includes them in the docker compose command.

### Network choice

- `channel_lan` — default network for channels (LAN/public exposure is controlled by route file)
- `channel_public` — optional network for channels that need that segment
- No `.caddy` file — Docker-network only (host + other containers, no HTTP route)

The network name in the compose overlay determines which Docker network the channel joins. HTTP routing/access is controlled by the `.caddy` file and staging rules: LAN by default, public only with `import public_access`.

## Customization Reference

| What you want to change | What to edit |
|--------------------------|-------------|
| Add a channel | Drop a `.yml` into `registry/` (optionally add a `.caddy`) |
| Remove a channel | Delete the `.yml` (and `.caddy` if present) from `registry/` |
| Add HTTP routing to a channel | Create a `.caddy` file for it |
| Remove HTTP routing | Delete the `.caddy` file (channel becomes docker-network only) |
| Change channel access (LAN ↔ public) | Edit the `.caddy` file: add/remove `import public_access` |
| Change LAN IP ranges | Edit the `(lan_only)` snippet in `Caddyfile` |
| Restrict to localhost only | Change `(lan_only)` IPs to `127.0.0.1 ::1` |
| Change ingress port | Set `OPENPALM_INGRESS_PORT` in env file (default: 8080) |
| Change bind address | Set `OPENPALM_INGRESS_BIND_ADDRESS` in env file (default: 127.0.0.1) |
| Use different image registry | Set `OPENPALM_IMAGE_NAMESPACE` in env file |
| Change config location | Set `OPENPALM_CONFIG_HOME` in env file (default: ~/.config/openpalm) |
| Change data storage location | Set `OPENPALM_DATA_HOME` in env file (default: ~/.local/share/openpalm) |
