# @openpalm/scheduler

Lightweight Bun HTTP server that runs cron-based automations for the OpenPalm stack. Reads automation definitions from `STATE_HOME/automations/*.yml`, schedules them with [Croner](https://github.com/hexagon/croner), and watches the filesystem for changes (no restart required).

This is a core service with no Docker socket access.

## Action Types

| Type | Description |
|---|---|
| `http` | Fetch a URL (any method, optional body/headers) |
| `shell` | Run a command via `execFile` with argument arrays (no shell interpolation) |
| `assistant` | Send a message to the OpenCode API to trigger an assistant session |
| `api` | Call the admin API (gracefully skipped when admin is absent) |

## HTTP API

All endpoints except `/health` require authentication via `x-admin-token` header.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | No | Health check (returns `{ status, service, jobCount, uptime }`) |
| `GET` | `/automations` | Yes | List all automations from disk with next run times (if scheduled) and execution logs |
| `GET` | `/automations/:fileName/log` | Yes | Execution history for a specific automation by filename (last 50 runs) |
| `POST` | `/automations/:fileName/run` | Yes | Manually trigger an automation by filename (e.g., `cleanup-logs.yml`) |

## Automation Format

Place `.yml` files in `STATE_HOME/automations/`:

```yaml
name: cleanup-logs
description: Remove old container logs
schedule: "@daily"          # Cron expression or preset (@hourly, @daily, @weekly)
timezone: UTC
enabled: true
action:
  type: shell
  command: find
  args: ["/data/logs", "-mtime", "+7", "-delete"]
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8090` | HTTP server port |
| `OP_STATE_HOME` | (required) | Path to state directory containing `automations/` |
| `OP_ADMIN_TOKEN` | (recommended) | Token for authenticated endpoints and `api` actions |
| `OP_ADMIN_API_URL` | `http://admin:8100` | Admin API URL for `api` actions (optional) |
| `OPENCODE_API_URL` | `http://assistant:4096` | OpenCode API URL for `assistant` actions |

## Docker

Runs as the `scheduler` service in docker-compose. Port 8090, user `bun`, healthcheck on `/health`. Depends on the assistant service being healthy. Volumes are read-only mounts of `automations/` and `artifacts/`.

## Development

```bash
cd packages/scheduler
bun run start       # Start the server
bun test            # Run tests
```
