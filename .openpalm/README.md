# ~/.openpalm

This is the OpenPalm home directory. On a user's machine it lives at
`~/.openpalm/` (override with `OP_HOME`). In the repository it serves as
the canonical template that the CLI copies during install.

## Directory layout

```
~/.openpalm/
  config/             User-editable configuration (non-secret)
    stack.yaml          Single configuration file (connections, assignments, addons)
    host.yaml           Host environment info (written at install time)
    assistant/          OpenCode user config, plugins, skills, tools
    automations/        Scheduler automation definitions (core + optional)
    guardian/           Guardian configuration
    components/         Compose overlays installed at runtime

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

  stack/              Docker Compose foundation
    core.compose.yml    4 core services (memory, assistant, guardian, scheduler)
    start.sh            Thin compose wrapper script
    addons/             Optional service overlays (admin, chat, discord, etc.)

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
cp ~/.openpalm/vault/stack/stack.env.schema ~/.openpalm/vault/stack/stack.env
cp ~/.openpalm/vault/user/user.env.schema  ~/.openpalm/vault/user/user.env
$EDITOR ~/.openpalm/vault/stack/stack.env   # Set OP_HOME, OP_ADMIN_TOKEN, etc.
$EDITOR ~/.openpalm/vault/user/user.env     # Set your LLM API keys
$EDITOR ~/.openpalm/config/stack.yaml       # Configure connections and addons
cd ~/.openpalm/stack && ./start.sh admin chat
```

## Ownership rules

| Directory | Owner | Who writes |
|-----------|-------|------------|
| `config/` | User | User edits, CLI/admin seeds defaults, assistant via admin API |
| `vault/stack/` | System | CLI and admin only |
| `vault/user/` | User | User edits directly |
| `data/` | Services | Containers at runtime |
| `stack/` | System | CLI downloads, admin upgrades |
| `backups/` | System | Created during upgrades |
| `workspace/` | User + Assistant | Shared read-write workspace |
