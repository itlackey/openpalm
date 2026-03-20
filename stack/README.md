# OpenPalm Stack

Self-contained Docker Compose foundation for running OpenPalm. Copy this
directory to a server, fill in `.env`, and run `docker compose up -d` -- no
CLI, no Bun, no npm required.

## Quick start

```bash
cp -r stack/ ~/.openpalm/
cd ~/.openpalm
cp .env.example .env
# Edit .env — set OP_ADMIN_TOKEN, LLM keys, etc.
docker compose -f core.compose.yml up -d
```

## Adding addons

```bash
# Add the chat widget
docker compose -f core.compose.yml -f addons/chat/compose.yml up -d

# Or use start.sh
./start.sh chat discord admin
```

## Structure

```
stack/
  core.compose.yml          # 4 core services (memory, assistant, guardian, scheduler)
  .env.example              # Copy-and-fill environment template
  .env.schema               # Machine-readable env schema (for tooling)
  start.sh                  # Thin compose wrapper

  core/                     # Non-compose core artifacts
    opencode.jsonc           # OpenCode project configuration
    AGENTS.md                # Assistant persona guidelines
    setup-config.schema.json # Setup wizard JSON schema
    user.env.schema          # User env variable documentation
    system.env.schema        # System env variable documentation
    redact.env.schema        # Log redaction schema

  automations/              # Core automations (always seeded)
    cleanup-data.yml
    cleanup-logs.yml
    validate-config.yml

  catalog/                  # Optional automations (installable)
    assistant-daily-briefing.yml
    health-check.yml
    prompt-assistant.yml
    update-containers.yml

  addons/                   # Optional add-on overlays
    index.json              # Addon catalog metadata
    admin/                  # Admin web UI + API
    api/                    # OpenAI/Anthropic API facade
    chat/                   # Browser chat widget
    discord/                # Discord bot
    ollama/                 # Local LLM server
    openviking/             # Knowledge engine
    slack/                  # Slack bot
    voice/                  # Voice interface
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
