# Memory Service Data Privacy

This document describes what OpenPalm's memory service stores, where it stores it, and which network calls it makes.

## What is stored

The memory service stores extracted facts, not full conversation transcripts, when inference mode is used.
Each memory record includes a UUID, fact text, metadata, timestamps, and a vector embedding used for semantic search.
Mutation history is also retained.

## Where it is stored

OpenPalm's compose-first layout stores memory data under `~/.openpalm/data/memory/`.

- Database: `~/.openpalm/data/memory/memory.db`
- Sidecar files: `~/.openpalm/data/memory/memory.db-wal`, `~/.openpalm/data/memory/memory.db-shm`
- In container: `/data/...`

The shipped runtime persists memory state through `/data` only. In the current
compose file, there is no separate `default_config.json` bind mount; any
generated memory config is expected to live under the durable memory data tree.

The memory API is exposed on `http://localhost:3898` by default and listens on container port `8765`.

## What is not stored

- API keys and service tokens
- Passwords or credentials
- Raw transcripts when inference mode extracts facts instead
- Model weights

Secrets such as `OPENAI_API_KEY` live in `~/.openpalm/vault/user/user.env`.
Service auth such as `MEMORY_AUTH_TOKEN` lives in `~/.openpalm/vault/stack/stack.env`.

## External service calls

Depending on your configuration, the memory service may call:

- an LLM provider for fact extraction
- an embedding provider for vector generation

If both point to a local provider such as Ollama, data stays on your local network.
If they point to remote APIs, submitted fact text and search queries leave your network.

## Viewing stored memories

The memory API requires `Authorization: Bearer $MEMORY_AUTH_TOKEN`.

```bash
curl -X POST http://localhost:3898/api/v1/memories/filter \
  -H "Authorization: Bearer $MEMORY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"default_user","size":50}'

curl -X POST http://localhost:3898/api/v2/memories/search \
  -H "Authorization: Bearer $MEMORY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"default_user","query":"programming preferences"}'

curl http://localhost:3898/api/v1/config/ \
  -H "Authorization: Bearer $MEMORY_AUTH_TOKEN"
```

The assistant can also access memory through its built-in memory tools.

## Wiping memory data

### Option 1: delete the SQLite files

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  --project-name openpalm \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  -f core.compose.yml \
  stop memory

rm -f ~/.openpalm/data/memory/memory.db
rm -f ~/.openpalm/data/memory/memory.db-wal
rm -f ~/.openpalm/data/memory/memory.db-shm

docker compose \
  --project-name openpalm \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  -f core.compose.yml \
  start memory
```

### Option 2: admin reset endpoint

```bash
curl -X POST http://localhost:3880/admin/memory/reset-collection \
  -H "x-admin-token: $OP_ADMIN_TOKEN"
```

Then restart the memory service.

### Option 3: delete records through the memory API

```bash
curl -X DELETE http://localhost:3898/api/v1/memories/ \
  -H "Authorization: Bearer $MEMORY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"default_user"}'
```

## Data retention

- No automatic expiry by default
- User controls creation, update, backup, and deletion
- History is removed when the database is deleted or the collection is reset
