# OpenPalm MVP PRD (Current-State)

## Product goal

OpenPalm delivers a local-first AI platform with a strict control plane:

- Admin is the only Docker orchestrator.
- Guardian is the only channel ingress.
- Assistant has no Docker socket and uses Admin API only.

## Non-negotiable constraints

1. File assembly, not template rendering.
2. XDG tier boundaries (`CONFIG_HOME`, `DATA_HOME`, `STATE_HOME`).
3. Guardian verification on all channel ingress (HMAC + replay + rate + payload).
4. LAN-first default exposure.

## Runtime architecture

Core services:

- `caddy`
- `postgres`
- `qdrant`
- `openmemory`
- `openmemory-ui`
- `assistant`
- `guardian`
- `admin`

Channel services are added via compose overlays and staged into
`STATE_HOME/channels/*.yml`.

## Filesystem model

- `CONFIG_HOME`: user-editable sources (`secrets.env`, `channels/`, `opencode/`).
- `DATA_HOME`: persistent service data only.
- `STATE_HOME`: assembled runtime (`artifacts/`, staged channels, audit, system secrets).

Admin startup runs an idempotent auto-apply that stages artifacts from CONFIG +
bundled assets into STATE.

## Secrets model

- User-managed: `CONFIG_HOME/secrets.env` (`ADMIN_TOKEN`, LLM provider keys).
- System-managed: `STATE_HOME/secrets/system-secrets.env` (`POSTGRES_PASSWORD`),
  `STATE_HOME/secrets/channel-secrets.env` (`CHANNEL_<NAME>_SECRET`).
- System-managed Caddy policy source: `DATA_HOME/caddy/Caddyfile`.
- Runtime env source: `STATE_HOME/artifacts/secrets.env` assembled by admin.

## API scope (implemented)

- Lifecycle: `/admin/install`, `/admin/update`, `/admin/uninstall`
- Containers: `/admin/containers/list|up|down|restart|pull`
- Channels: `/admin/channels`, `/admin/channels/install`, `/admin/channels/uninstall`
- Access scope: `/admin/access-scope`
- Artifacts: `/admin/artifacts`, `/admin/artifacts/:name`, `/admin/artifacts/manifest`
- Audit: `/admin/audit`
- Connections: `/admin/connections`, `/admin/connections/status`
- Installed: `/admin/installed`
- Gallery: `/admin/gallery/search`, `/admin/gallery/categories`, `/admin/gallery/item/:id`,
  `/admin/gallery/community`, `/admin/gallery/community/refresh`,
  `/admin/gallery/install`, `/admin/gallery/uninstall`
- Guardian proxy: `/admin/guardian/health`

For full endpoint details, see [api-spec.md](./api-spec.md).

Not implemented in current code: setup wizard endpoints, automations endpoints.

## MVP acceptance criteria

1. `install` brings up core stack via admin API orchestration.
2. Channel ingress flows channel → guardian → assistant with security checks.
3. Assistant can perform allowlisted admin actions without Docker socket access.
4. Operators can inspect staged runtime artifacts under `STATE_HOME/artifacts`.
5. Admin actions are authenticated and audit-logged.
6. Connections API manages LLM provider keys without manual file editing.
7. Gallery API enables browsing and installing extensions.
8. `containers/pull` enables image updates and container recreation.
9. Community channels can be built using the BaseChannel SDK (`packages/lib`)
   and the `channels/base` Docker image.
