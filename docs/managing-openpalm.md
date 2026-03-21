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

---

## Directory Map

```
~/.openpalm/                          ← YOUR OPENPALM HOME
├── stack/
│   ├── core.compose.yml              # Base compose file used for the runtime stack
│   └── addons/
│       ├── chat/
│       │   └── compose.yml
│       ├── api/
│       │   └── compose.yml
│       └── voice/
│           └── compose.yml
│
├── vault/
│   ├── user/
│   │   └── user.env                  # User-managed secrets: LLM provider keys
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

- **`user/user.env`** -- User-managed secrets: LLM provider API keys and user-supplied integration credentials. Editable directly or via the admin UI/API.
- **`stack/stack.env`** -- System-managed secrets: admin token, HMAC keys, bind addresses, and infrastructure vars. Generated and maintained by the admin.

```env
# ~/.openpalm/vault/user/user.env
# LLM provider keys (assistant uses these — at least one required)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
MISTRAL_API_KEY=...
GOOGLE_API_KEY=...
```

System-managed values (`CHANNEL_*_SECRET`, `OP_*` infrastructure vars,
`OP_ADMIN_TOKEN`, `ASSISTANT_TOKEN`, bind addresses, image tags) are generated
by setup/admin tooling and written into `vault/stack/stack.env` -- you do not
normally edit them manually.

**After editing** -- rerun the same compose command or restart the services that
consume the changed values. The standard wrapper includes both
`vault/stack/stack.env` and `vault/user/user.env` automatically.

LLM provider keys and related connection settings can also be managed via the
Connections API or the Connections settings page in the admin UI -- no manual
file editing required. The API patches `vault/user/user.env` in-place, preserving all
other keys.

```bash
# View current connection settings (keys are masked in the response)
curl http://localhost:3880/admin/connections \
  -H "x-admin-token: $OP_ADMIN_TOKEN"

# Update one or more keys
curl -X POST http://localhost:3880/admin/connections \
  -H "x-admin-token: $OP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"OPENAI_API_KEY": "sk-..."}'

# Check whether stack.yaml has non-empty LLM and embedding assignments
curl http://localhost:3880/admin/connections/status \
  -H "x-admin-token: $OP_ADMIN_TOKEN"
```

---

## Addons (Channels, Services, Integrations)

An addon is a compose overlay under `~/.openpalm/stack/addons/<name>/compose.yml`. Channels, services, and integrations are all addons.

Current shipped network model:

- channel-style addons join `channel_lan` by default
- guardian bridges addon ingress to `assistant_net`
- public exposure only happens when an overlay intentionally joins `channel_public` or changes its host bind policy

### Install an addon from the registry

Available addons can be installed via the admin API:

```bash
curl -X POST http://localhost:3880/admin/registry/install \
  -H "x-admin-token: $OP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"chat","type":"channel"}'
```

This copies the addon files from the registry to `~/.openpalm/stack/addons/`,
generates an HMAC secret, and starts the service.

### Add an addon manually

1. Create `~/.openpalm/stack/addons/<name>/`
2. Add a `compose.yml`
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

OpenPalm ships several ready-to-use examples in `registry/automations/` — install them
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

OpenPalm may ship system-managed automations in `~/.openpalm/data/automations/`.
If you create a user file with the **same name**, your version takes priority.
You don't need to edit system files directly.

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

`stack/start.sh` is a convenience shorthand for the same compose command — raw
`docker compose` is the canonical form.

Lifecycle operations remain non-destructive for existing user files in `config/`.

---

## Backup & Restore

```bash
# Backup: archive the entire openpalm home directory
tar czf openpalm-backup.tar.gz ~/.openpalm

# Restore: extract, then rerun the same compose command you normally use
tar xzf openpalm-backup.tar.gz -C /
docker compose \
  --project-name openpalm \
  --env-file ~/.openpalm/vault/stack/stack.env \
  --env-file ~/.openpalm/vault/user/user.env \
  -f ~/.openpalm/stack/core.compose.yml \
  -f ~/.openpalm/stack/addons/admin/compose.yml \
  -f ~/.openpalm/stack/addons/chat/compose.yml \
  up -d

# Convenience alternative: use start.sh with the same addon set
# cd ~/.openpalm/stack && ./start.sh admin chat
```

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
1. Edit `~/.openpalm/vault/user/user.env`
2. Restart the services that use it, such as `assistant`: `docker compose restart assistant`

**Add a new LLM provider:**
1. Add the API key to `~/.openpalm/vault/user/user.env`
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
