# OpenPalm Stack

Self-contained Docker Compose foundation for running OpenPalm. Copy `stack/`
and `vault/` to a server, fill in the env files, and run `docker compose up -d`
-- no CLI, no Bun, no npm required.

## Quick start

```bash
# 1. Copy stack and vault to your server
cp -r stack/ ~/.openpalm/
mkdir -p ~/.openpalm/vault/stack ~/.openpalm/vault/user
cp vault/stack.env.example ~/.openpalm/vault/stack/stack.env
cp vault/user.env.example  ~/.openpalm/vault/user/user.env

# 2. Edit the env files
$EDITOR ~/.openpalm/vault/stack/stack.env   # Set OP_ADMIN_TOKEN, OP_HOME, etc.
$EDITOR ~/.openpalm/vault/user/user.env     # Set your LLM API keys

# 3. Start the core stack
cd ~/.openpalm
docker compose -f core.compose.yml \
  --env-file vault/stack/stack.env \
  --env-file vault/user/user.env \
  up -d
```

## Adding addons

```bash
# Add the chat widget
docker compose -f core.compose.yml -f addons/chat/compose.yml \
  --env-file vault/stack/stack.env --env-file vault/user/user.env up -d

# Or use start.sh (reads env files automatically)
./start.sh chat discord admin
```

## Structure

```
stack/
  core.compose.yml          # 4 core services (memory, assistant, guardian, scheduler)
  .env.example              # Combined env template (for start.sh)
  .env.schema               # Machine-readable env schema (for tooling)
  start.sh                  # Thin compose wrapper

  automations/              # All automations (core + optional)
    cleanup-data.yml         # Core: SQLite vacuum, temp cleanup
    cleanup-logs.yml         # Core: audit log trimming
    validate-config.yml      # Core: daily config validation
    assistant-daily-briefing.yml  # Optional: daily briefing
    health-check.yml         # Optional: health monitoring
    prompt-assistant.yml     # Optional: daily prompt via chat
    update-containers.yml    # Optional: weekly container updates

  addons/                   # Optional add-on overlays
    index.json               # Addon catalog metadata
    admin/                   # Admin web UI + API
    api/                     # OpenAI/Anthropic API facade
    chat/                    # Browser chat widget
    discord/                 # Discord bot
    ollama/                  # Local LLM server
    openviking/              # Knowledge engine
    slack/                   # Slack bot
    voice/                   # Voice interface

vault/                      # (separate directory — see vault/README.md)
  stack.env.example          # System secrets template
  user.env.example           # User keys template
  system.env.schema          # Varlock validation schema
  user.env.schema            # Varlock validation schema
  redact.env.schema          # Log redaction rules
```

## Multi-instance (extends pattern)

For running multiple instances of the same addon (e.g., two Discord bots):

```yaml
# addons/discord/primary.compose.yml
services:
  discord-primary:
    extends:
      file: ./compose.yml
      service: discord
    env_file:
      - ../../vault/stack/addons/discord/primary.env
```

## Networks

| Network | Purpose |
|---------|---------|
| `channel_lan` | LAN-restricted channel traffic (127.0.0.1) |
| `channel_public` | Public channel traffic (opt-in 0.0.0.0) |
| `assistant_net` | Internal assistant communication |
| `admin_docker_net` | Isolated admin + socket proxy |
