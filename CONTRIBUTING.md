# Contributing

## Local development

Use the dev override when you want containers rebuilt from local source changes.

```bash
cp assets/system.env .env
docker compose -f assets/docker-compose.yml -f docker-compose.yml up -d --build
```

`assets/system.env` is system-managed and should only be manually edited by experienced users.
Use `assets/user.env` for user-specific overrides.

## Edit and validate

```bash
bun test
bunx tsc -b
```

Workspaces: `gateway`, `admin`, `controller`, `channels/chat`, `channels/discord`, `channels/voice`, `channels/telegram`.
