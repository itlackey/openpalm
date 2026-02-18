# Contributing

## Local development

Use the dev override when you want containers rebuilt from local source changes.

```bash
cp assets/.env.example .env
docker compose -f assets/docker-compose.yml -f docker-compose.yml up -d --build
```

## Edit and validate

```bash
bun test
bunx tsc -b
```

Workspaces: `gateway`, `admin`, `controller`, `channels/chat`, `channels/discord`, `channels/voice`, `channels/telegram`.
