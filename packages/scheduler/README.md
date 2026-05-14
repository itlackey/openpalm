# @openpalm/scheduler

Cron-based automation co-process for OpenPalm. Loads enabled automation
YAML from `${OP_HOME}/config/automations/`, schedules jobs with Croner,
and watches for file changes (including manual-trigger sentinels).

Starting with v0.11.0 the scheduler runs **inside the assistant
container** as a sidecar process (no HTTP port). See
`core/assistant/entrypoint.sh` for the supervisor wiring.

## Runtime model

- Definitions: `${OP_HOME}/config/automations/*.yml`
- Manual triggers: drop `${OP_HOME}/data/scheduler/triggers/<fileName>.run`;
  the watcher fires the matching automation and deletes the sentinel.
- Output: structured logs written to `${OP_HOME}/logs/scheduler.log`
  (the entrypoint redirects stdout/stderr there).
- Admin API: `/admin/automations`, `/admin/automations/:name/run`, and
  `/admin/automations/:name/log` are the supported control surface.

## Action types

| Type | Description |
|---|---|
| `http` | Fetch a URL with optional method, headers, and body |
| `shell` | Run a command via `execFile` with argument arrays |
| `assistant` | Send a request to the local OpenCode API (`http://localhost:4096` inside the container) |
| `api` | Call the admin API when one is configured |

## Automation format

Store enabled `.yml` files in `config/automations/`:

```yaml
name: cleanup-logs
description: Remove old container logs
schedule: '@daily'
timezone: UTC
enabled: true
action:
  type: shell
  command:
    - rm
    - /tmp/example.log
```

Use safe argument arrays; do not depend on shell interpolation.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OP_HOME` | - | OpenPalm root; scheduler reads `config/automations/` and watches `data/scheduler/triggers/` from here |
| `OP_ASSISTANT_TOKEN` | - | Token used by `api` actions when calling the admin API |
| `OP_ADMIN_API_URL` | `http://admin:8100` | Admin API URL for `api` actions |
| `OPENCODE_API_URL` | `http://localhost:4096` | Assistant API URL for `assistant` actions (co-resident in the same container) |
| `OPENCODE_SERVER_PASSWORD` | - | Optional password for assistant API auth (compose-mapped from `OP_OPENCODE_PASSWORD`) |

## Development

```bash
cd packages/scheduler
bun test                                  # unit + co-process integration tests
OP_HOME=/tmp/sched-dev bun run start     # run the co-process locally
```
