# Managing OpenPalm — TLDR

This document covers day-to-day administration: configuration, channels, secrets,
access control, and extensions. For architecture rationale see
[core-principles.md](./technical/core-principles.md).

---

## One Rule to Remember

**`~/.openpalm/` (`OP_HOME`) is your persistent home directory.**

You can manage config files in whichever way is most convenient:
- Edit files directly
- Use explicit config actions in the admin UI/API
- Ask the assistant to run authenticated, allowlisted admin API config actions on your behalf

All three paths are valid ways to write files in `~/.openpalm/config/`. In
normal operation you do not edit `data/` directly, and stack runtime files live
under `~/.openpalm/stack/`.

Keep this split in mind:
- `~/.openpalm/registry/` is the available catalog
- `~/.openpalm/stack/addons/` contains enabled addons only
- `~/.openpalm/config/automations/` contains enabled automations only
- `~/.openpalm/config/stack.yml` stores capabilities only

---

## Directory Map

```
~/.openpalm/                          ← YOUR OPENPALM HOME
├── registry/
│   ├── addons/                       # Available addon catalog
│   │   ├── chat/
│   │   │   ├── compose.yml
│   │   │   └── .env.schema
│   │   └── api/
│   └── automations/                  # Available automation catalog
│       └── health-check.yml
│
├── stack/
│   ├── core.compose.yml              # Base compose file used for the runtime stack
│   └── addons/
│       └── chat/
│           └── compose.yml           # Enabled addons only
│
├── vault/
│   ├── user/
│   │   └── user.env                  # Optional user extension env
│   └── stack/
│       └── stack.env                 # System-managed secrets: admin token, HMAC keys, ports
│
├── config/
│   ├── automations/                  # Scheduled automations (drop files here)
│   │   └── backup.yml
│   │
│   └── assistant/
│       ├── opencode.json             # OpenCode config (LLM provider, settings)
│       ├── tools/                    # Drop custom tools here
│       ├── plugins/                  # Drop custom plugins here
│       └── skills/                   # Drop custom skills here
│
├── data/                             ← DURABLE CONTAINER DATA
│   ├── admin/
│   ├── assistant/
│   ├── guardian/
│   ├── memory/
│   ├── stash/
│   └── workspace/                    # Shared /work mount for assistant and admin
└── logs/                             ← AUDIT AND DEBUG LOGS
```

---

## Secrets (`vault/`)

Secrets are split into two files under `~/.openpalm/vault/`:

- **`user/user.env`** -- Recommended location for addon/operator overrides and custom values.
- **`stack/stack.env`** -- System-managed runtime env and secrets: admin/assistant/memory auth tokens, provider API keys, capability vars, ports, and other infrastructure values.

```env
# ~/.openpalm/vault/stack/stack.env
# LLM provider keys and capability values
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
MISTRAL_API_KEY=...
GOOGLE_API_KEY=...
```

System-managed values (`CHANNEL_*_SECRET`, `OP_*` infrastructure vars,
`OP_ADMIN_TOKEN`, `OP_ASSISTANT_TOKEN`, bind addresses, image tags) are generated
by setup/admin tooling and written into `vault/stack/stack.env` -- you do not
normally edit them manually.

**After editing** -- rerun the same compose command or restart the services that
consume the changed values. The standard wrapper includes both
`vault/stack/stack.env` and `vault/user/user.env` automatically.

LLM provider keys and related connection settings can also be managed via the
Connections API or the Connections settings page in the admin UI -- no manual
file editing required. The API patches `vault/stack/stack.env` in-place, preserving all
other keys.

```bash
# View current connection settings (keys are masked in the response)
curl http://localhost:3880/admin/connections \
  -H "x-admin-token: $OP_ADMIN_TOKEN"

# Update one or more keys
curl -X POST http://localhost:3880/admin/connections \
  -H "x-admin-token: $OP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai","apiKey":"sk-...","systemModel":"gpt-4o","embeddingModel":"text-embedding-3-small","embeddingDims":1536,"memoryUserId":"default_user"}'

# Check whether stack.yml has non-empty LLM and embedding assignments
curl http://localhost:3880/admin/connections/status \
  -H "x-admin-token: $OP_ADMIN_TOKEN"
```

---

## Addons (Channels, Services, Integrations)

An addon has two states:
- available in the catalog at `~/.openpalm/registry/addons/<name>/`
- enabled at runtime under `~/.openpalm/stack/addons/<name>/compose.yml`

Channels, services, and integrations are all addons.

Current shipped network model:

- channel-style addons join `channel_lan` by default
- guardian bridges addon ingress to `assistant_net`
- public exposure only happens when an overlay intentionally joins `channel_public` or changes its host bind policy

### Enable/disable an addon

Addons are managed via `/admin/addons` routes. Example:

```bash
curl -X POST http://localhost:3880/admin/addons/chat \
  -H "x-admin-token: $OP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}'
```

This copies the addon from the catalog into the active runtime overlays. `config/stack.yml` does not store addon state.

### Configure an addon

- Read the addon's schema at `~/.openpalm/registry/addons/<name>/.env.schema`
- Put values in `~/.openpalm/vault/user/user.env`
- Rerun your compose command or restart affected services

Addon config is schema-driven and file-based. There is no addon config block in `stack.yml`.

### Add an addon manually

1. Copy `~/.openpalm/registry/addons/<name>/` into `~/.openpalm/stack/addons/<name>/`
2. Or author `~/.openpalm/stack/addons/<name>/` manually if you want a custom or multi-instance layout
3. Run preflight to confirm the merge is clean, then rerun `docker compose` with that addon included

### Uninstall an addon

Remove the addon directory from `~/.openpalm/stack/addons/`, then rerun `docker compose` without it.

---

## Automations

You can schedule recurring tasks — like backups, cleanup scripts, or health checks —
by dropping a `.yml` file into `~/.openpalm/config/automations/`.

Automations are executed by the dedicated `scheduler` service using Croner (no
system cron required).

### How to add an automation

1. Create a `.yml` file in `~/.openpalm/config/automations/`
2. Define a schedule and action (see format below)
3. Restart the scheduler to activate: `docker compose restart scheduler`

**Example** — pull the latest container images every Sunday at 3 AM:

```yaml
# ~/.openpalm/config/automations/update-containers.yml
name: Update Containers
description: Pull latest images and recreate containers weekly
schedule: weekly-sunday-3am
enabled: true

action:
  type: api
  method: POST
  path: /admin/containers/pull
  timeout: 300000
```

OpenPalm ships several ready-to-use examples in `~/.openpalm/registry/automations/` — install them
from the Registry tab in the admin console, or copy any of them into `~/.openpalm/config/automations/` to activate:

| File | What it does |
|---|---|
| `health-check.yml` | Check admin health every 5 minutes |
| `prompt-assistant.yml` | Send a daily prompt to the assistant via the chat channel |
| `cleanup-logs.yml` | Weekly trim audit logs to prevent unbounded disk growth |
| `update-containers.yml` | Weekly pull latest images and recreate containers |

### Automation YAML format

```yaml
name: My Automation          # optional display name
description: What it does    # optional
schedule: every-5-minutes    # cron expression or preset name
timezone: UTC                # optional, default UTC
enabled: true                # optional, default true

action:
  type: api                  # "api" | "http" | "shell"
  method: GET
  path: /health
  timeout: 30000             # optional, ms

on_failure: log              # "log" (default) | "audit"
```

### Action types

| Type | Purpose | Key fields |
|---|---|---|
| `api` | Admin API call — auto-injects admin token and `x-requested-by: automation` | `method`, `path`, `body?`, `headers?` |
| `http` | Any HTTP endpoint — no auto-auth | `method`, `url`, `body?`, `headers?` |
| `shell` | Run a command via `execFile` (argument array, no shell interpolation) | `command` (string array) |

### Schedule presets

You can use a human-readable preset name instead of a cron expression:

| Preset | Cron |
|---|---|
| `every-minute` | `* * * * *` |
| `every-5-minutes` | `*/5 * * * *` |
| `every-15-minutes` | `*/15 * * * *` |
| `every-hour` | `0 * * * *` |
| `daily` | `0 0 * * *` |
| `daily-8am` | `0 8 * * *` |
| `weekly` | `0 0 * * 0` |
| `weekly-sunday-3am` | `0 3 * * 0` |
| `weekly-sunday-4am` | `0 4 * * 0` |

Or use standard cron syntax directly (e.g., `"0 2 * * *"` for daily at 2 AM).

### Rules

- **Filenames** must use `.yml` extension (e.g., `backup.yml`, `weekly-cleanup.yml`)
- Filenames must be lowercase letters, numbers, and hyphens only (before the `.yml` extension)
- Automations run on the dedicated `scheduler` service, which reads files from `~/.openpalm/config/automations/`
- Shell actions use `execFile` with an argument array — no shell interpolation for security

### When do changes take effect?

Automation files are picked up when the scheduler service starts. After adding
or editing a file, restart the scheduler to activate:

```bash
docker compose restart scheduler
```

### Overriding system automations

Shipped examples live in `~/.openpalm/registry/automations/`. They are inactive until copied into `~/.openpalm/config/automations/`.

---

## OpenCode / Assistant Extensions

The assistant runs OpenCode. Core extensions are baked into the container
(`/etc/opencode`). User extensions mount from
`~/.openpalm/config/assistant/` into `/home/opencode/.config/opencode` — no
rebuild needed.

**To add a tool/plugin/skill:**

```bash
# Drop files into the matching subdirectory:
~/.openpalm/config/assistant/tools/my-tool.ts
~/.openpalm/config/assistant/plugins/my-plugin.ts
~/.openpalm/config/assistant/skills/my-skill/SKILL.md
```

OpenCode picks them up on next restart of the assistant container.

**To configure OpenCode (LLM provider, models, etc.):**

Edit `~/.openpalm/config/assistant/opencode.json` directly. If you use explicit
admin UI/API config actions (including assistant-triggered admin actions), they
write to the same config files.

---

## Compose-driven updates

The running stack is whatever compose file set you launch. To change it:

1. Edit files under `~/.openpalm/config/`, `~/.openpalm/vault/`, or `~/.openpalm/stack/`
2. Rerun `docker compose` with the desired `-f` list

For the full compose command reference, see the [Manual Compose Runbook](operations/manual-compose-runbook.md).

Lifecycle operations remain non-destructive for existing user files in `config/`.

---

## Backup & Restore

```bash
# Backup: archive the entire openpalm home directory
tar czf openpalm-backup.tar.gz ~/.openpalm

# Restore: extract, then rerun the same compose command you normally use
tar xzf openpalm-backup.tar.gz -C /
```

After restoring, start the stack using the compose commands in the [Manual Compose Runbook](operations/manual-compose-runbook.md).

---

## Admin UI & Ports

| URL | Service |
|---|---|
| `http://localhost:3880/` | Admin UI and API |
| `http://localhost:3800/` | OpenCode assistant UI |
| `http://localhost:3820/` | Chat addon |
| `http://localhost:3821/` | API addon |
| `http://localhost:3810/` | Voice addon |
| `http://localhost:3898/` | Memory API |
| `http://localhost:3898/docs` | Memory API docs (Swagger UI) |

All ports are `127.0.0.1`-bound by default.

---

## Common Tasks

**Change an LLM API key:**
1. Edit `~/.openpalm/vault/stack/stack.env`
2. Restart the services that use it, such as `assistant`: `docker compose restart assistant`

**Add a new LLM provider:**
1. Add the API key to `~/.openpalm/vault/stack/stack.env`
2. Edit `~/.openpalm/config/assistant/opencode.json` to configure the provider
3. Restart assistant: `docker compose restart assistant`

**Rotate the admin token:**
1. Update `OP_ADMIN_TOKEN` in `~/.openpalm/vault/stack/stack.env`
2. Restart all services: `docker compose restart`

**Add an automation:**
1. Create `~/.openpalm/config/automations/my-job.yml` with your schedule
2. Restart the scheduler: `docker compose restart scheduler`

**View audit logs:**
```bash
tail -f ~/.openpalm/logs/admin-audit.jsonl
tail -f ~/.openpalm/logs/guardian-audit.log
```

**Check container status:**
```bash
docker compose ps
# Or via API:
curl http://localhost:3880/admin/containers/list \
  -H "x-admin-token: $OP_ADMIN_TOKEN"
```

**Pull latest images and recreate containers:**
```bash
curl -X POST http://localhost:3880/admin/containers/pull \
  -H "x-admin-token: $OP_ADMIN_TOKEN"
```

This runs `docker compose pull` followed by `docker compose up` to recreate
containers with the updated images. Equivalent to a manual
`docker compose pull && docker compose up -d`.

**Docker socket GID** is auto-detected from `/var/run/docker.sock` by the admin at startup
and written to `vault/stack/stack.env`. You do not need to set it manually.
If the admin fails to reach Docker, check that the socket exists and is readable.
