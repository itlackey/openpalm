# packages/admin — Admin UI & Control Plane

SvelteKit application that provides a web UI and API for managing the OpenPalm stack. Admin is optional — the CLI handles all lifecycle operations directly. When present, admin provides a web dashboard and API for remote/assistant-driven operations via docker-socket-proxy.

## Responsibilities

- **Admin dashboard** — manage stack, channels, connections, view audit log
- **REST API** (`/admin/*`) — authenticated API consumed by the UI, assistant tools, and CLI
- **Artifact staging** — assembles `docker-compose.yml`, `Caddyfile`, `secrets.env`, and channel overlays from CONFIG/DATA → STATE (delegates to `@openpalm/lib`)
- **Automations listing** — read-only view of automation configs (execution handled by the scheduler sidecar)
- **Registry catalog** — bundles channel and automation definitions from `registry/` at build time

## Structure

```
src/
├── lib/
│   ├── server/               # Business logic
│   │   ├── control-plane.ts  # Barrel re-export of all modules below
│   │   ├── types.ts          # Shared types and constants
│   │   ├── paths.ts          # XDG path resolution
│   │   ├── state.ts          # Runtime state factory
│   │   ├── env.ts            # Environment/env-file utilities
│   │   ├── channels.ts       # Channel discovery and install/uninstall
│   │   ├── staging.ts        # Artifact staging pipeline (CONFIG/DATA → STATE)
│   │   ├── core-assets.ts    # Bundled compose/Caddyfile management
│   │   ├── lifecycle.ts      # Compose builders and lifecycle helpers
│   │   ├── secrets.ts        # Secrets/connections CRUD
│   │   ├── docker.ts         # Docker Compose shell-out wrapper
│   │   ├── helpers.ts        # Request/response utilities
│   │   ├── audit.ts          # Audit logging
│   │   ├── registry.ts       # Channel/automation registry catalog
│   │   ├── registry-sync.ts  # Remote registry sync
│   │   ├── scheduler.ts      # Automations parsing (re-exports from @openpalm/lib)
│   │   ├── memory-config.ts  # Memory provider/model config
│   │   └── logger.ts         # Structured logger
│   ├── components/           # Svelte UI components
│   ├── auth.ts               # Auth utilities
│   ├── api.ts                # Client-side API helpers
│   └── types.ts              # Shared TypeScript types
└── routes/
    └── admin/                # Admin API endpoints (+server.ts files)
```

## Development

```bash
npm install
npm run dev      # dev server on http://localhost:8100
npm run check    # svelte-check + TypeScript
```

Or from the repo root:

```bash
bun run admin:dev
bun run admin:check
```

## API

All endpoints require `x-admin-token: <ADMIN_TOKEN>` (except `/health`). Full spec: [`docs/api-spec.md`](../../docs/technical/api-spec.md).

## Key environment variables

| Variable | Purpose |
|---|---|
| `OPENPALM_CONFIG_HOME` | User config directory |
| `OPENPALM_DATA_HOME` | Service data directory |
| `OPENPALM_STATE_HOME` | Assembled runtime directory |
| `OPENPALM_ADMIN_TOKEN` | Admin API authentication token |
| `DOCKER_SOCKET_PROXY_URL` | Docker socket proxy URL |
