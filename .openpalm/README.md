# ~/.openpalm

This is the OpenPalm home directory bundle. Users can copy it directly to
`~/.openpalm/` (or another location via `OP_HOME`) and run the stack from the
files here.

## Directory layout

```
~/.openpalm/
  config/             User-editable configuration (non-secret)
    stack.yaml          Optional tooling metadata (connections, assignments, preferred addons)
    host.yaml           Host environment info (written at install time)
    assistant/          OpenCode user config, plugins, skills, tools
    automations/        Scheduler automation definitions (core + optional)
    guardian/           Guardian configuration
  vault/              Secrets boundary
    stack/              System-managed secrets (stack.env, HMAC tokens)
    user/               User-managed secrets (API keys, owner info)
    redact.env.schema   Log redaction rules for varlock

  data/               Service-managed persistent data
    admin/              Admin UI state
    assistant/          OpenCode project data (.opencode)
    guardian/           Guardian runtime data
    memory/             Memory database and config
    stash/              AgentiKit stash directory

  stack/              Docker Compose runtime assets
    core.compose.yml    Core services
    start.sh            Canonical transparent compose wrapper
    addons/             Optional service overlays

  backups/            Snapshot backups (created during upgrades)
  workspace/          Shared workspace (mounted as /work in the assistant)
```

## Quick start

The recommended way to install is via the CLI:

```bash
openpalm install
```

For manual setup, copy this directory to your server and fill in the env files:

```bash
cp -r .openpalm/ ~/.openpalm/
$EDITOR ~/.openpalm/vault/stack/stack.env   # Set OP_HOME, OP_ADMIN_TOKEN, etc.
$EDITOR ~/.openpalm/vault/user/user.env     # Set your LLM API keys
$EDITOR ~/.openpalm/config/stack.yaml       # Optional tooling metadata for wrappers/tools
cd ~/.openpalm/stack && ./start.sh chat admin
```

You can also run Docker Compose directly:

```bash
cd ~/.openpalm/stack
docker compose \
  --project-name openpalm \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  -f core.compose.yml \
  -f addons/chat/compose.yml \
  -f addons/admin/compose.yml \
  up -d
```

The live stack is defined by `stack/core.compose.yml` plus the addon compose
files you include. `config/stack.yaml` is optional helper metadata used by
wrappers and tools to pick addons; it does not define the runtime by itself.

The bundled `stack.env` and `user.env` files are already present. Use the
matching `.schema` files as reference; do not overwrite the shipped files with
the schemas.

When you use `start.sh` for `stop`, `down`, or `status`, pass the same addon set
you used for `up` or use `--from-stack-yaml`.

## Ownership rules

| Directory | Owner | Who writes |
|-----------|-------|------------|
| `config/` | User | User edits, CLI/admin seeds defaults, assistant via admin API |
| `vault/stack/` | System | CLI and admin only |
| `vault/user/` | User | User edits directly |
| `data/` | Services | Containers at runtime |
| `stack/` | System | Shipped compose assets used directly at runtime |
| `backups/` | System | Created during upgrades |
| `workspace/` | User + Assistant | Shared read-write workspace |
