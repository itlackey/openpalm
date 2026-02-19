# Contributing

## Local development

### Quick start

```bash
bun run dev:setup       # creates .env with absolute paths & seeds .dev/ directories
bun run dev:build       # build images and start the stack
```

### Scripts

All `dev:*` scripts wrap the multi-file compose command so you don't have to type it out. Service names can be appended where it makes sense.

| Script | Description |
|---|---|
| `bun run dev:setup` | Create `.env` and seed `.dev/` directories (no-clobber) |
| `bun run dev:setup:clean` | Wipe `.dev/` and `.env`, then re-seed from scratch |
| `bun run dev:build` | Build images and start the stack (`-- opencode-core` for one service) |
| `bun run dev:up` | Start the stack without rebuilding images |
| `bun run dev:down` | Stop and remove all containers |
| `bun run dev:restart` | Restart containers (`-- gateway` for one service) |
| `bun run dev:logs` | Tail logs (`-- gateway opencode-core` to filter) |
| `bun run dev:ps` | Show container status |
| `bun run dev:config` | Validate and print the resolved compose config |
| `bun run dev:fresh` | Full fresh-install test: clean, re-seed, build, and start |
| `bun test` | Run tests across all workspaces |
| `bun run typecheck` | Type-check all workspaces |

### Fresh install (end-to-end testing)

To mimic a fresh install on a new system — wipes all local state, re-seeds config, and rebuilds every image:

```bash
bun run dev:fresh
```

### Directory layout

`dev-setup.sh` creates the same XDG-style directory tree that the production installer creates:

```
.dev/
├── config/          ← OPENPALM_CONFIG_HOME
│   ├── caddy/Caddyfile
│   ├── opencode-core/opencode.jsonc
│   ├── channels/{chat,discord,voice,telegram}.env
│   ├── cron/
│   ├── ssh/authorized_keys
│   ├── secrets.env
│   └── user.env
├── data/            ← OPENPALM_DATA_HOME
│   ├── caddy/
│   ├── postgres/
│   ├── qdrant/
│   ├── openmemory/
│   ├── shared/
│   └── admin/
└── state/           ← OPENPALM_STATE_HOME
    ├── caddy/
    ├── opencode-core/
    ├── workspace/
    └── gateway/
```

### Environment files

- `assets/config/system.env` — system-managed template; do not edit unless you know what you're doing.
- `assets/config/user.env` — user-specific overrides (API keys, model preferences, etc.).
- `.env.example` — local dev template. `dev-setup.sh` creates `.env` from this automatically.

### Compose architecture

The dev stack layers two compose files:

1. `assets/state/docker-compose.yml` — production base (images, volumes, networking)
2. `docker-compose.yml` — dev override (local builds from source)

`--project-directory .` is required so build contexts and volume paths resolve from the repo root rather than the compose file's directory. The `dev:*` scripts handle this automatically.

## Edit and validate

```bash
bun test
bun run typecheck
```

Workspaces: `gateway`, `admin`, `controller`, `channels/chat`, `channels/discord`, `channels/voice`, `channels/telegram`.

### OpenMemory Dashboard

The `openmemory-ui` service (`mem0/openmemory-ui:latest`) provides a Next.js dashboard for browsing memories, stats, and search. It is exposed on port 3000 and embedded in the admin UI via iframe. The dashboard is stateless — no volumes are required.
