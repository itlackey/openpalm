# @openpalm/scheduler

Lightweight Bun service that loads automation YAML from `config/automations/`, schedules jobs with Croner, and watches for file changes.
In the full stack it runs as a core service on host port `3897` and container port `8090`.

## Runtime model

- In-stack path: `~/.openpalm/config/automations/*.yml`
- In-stack auth: scheduler endpoints accept `x-admin-token`, configured via `OP_ASSISTANT_TOKEN` in `stack.env`
- Standalone/dev: set `OP_HOME`

## Action types

| Type | Description |
|---|---|
| `http` | Fetch a URL with optional method, headers, and body |
| `shell` | Run a command via `execFile` with argument arrays |
| `assistant` | Send a request to the OpenCode API |
| `api` | Call the admin API when one is configured |

## HTTP API

All endpoints except `/health` require the configured auth token.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/automations` | List loaded automations, next run times, and recent logs |
| `GET` | `/automations/:fileName/log` | Read execution history for one automation |
| `POST` | `/automations/:fileName/run` | Trigger one automation immediately |

## Automation format

Store `.yml` files in `config/automations/`:

```yaml
name: cleanup-logs
description: Remove old container logs
schedule: '@daily'
timezone: UTC
enabled: true
action:
  type: shell
  command: rm
  args: ['/tmp/example.log']
```

Use safe argument arrays; do not depend on shell interpolation.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8090` | HTTP listen port |
| `OP_HOME` | - | OpenPalm root; scheduler reads `config/automations/` from here |
| `OP_ADMIN_TOKEN` | - | Token accepted by authenticated endpoints (from `OP_ASSISTANT_TOKEN` in stack.env) |
| `OP_ADMIN_API_URL` | - | Admin API URL for `api` actions |
| `OPENCODE_API_URL` | `http://assistant:4096` | Assistant API URL for `assistant` actions |
| `OPENCODE_SERVER_PASSWORD` | - | Optional password for assistant API auth (compose-mapped from `OP_OPENCODE_PASSWORD`) |
| `MEMORY_API_URL` | `http://memory:8765` | Memory service URL |

## Development

```bash
cd packages/scheduler
bun run start
bun test
```
