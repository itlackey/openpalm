# Memory Service Data Privacy

This document describes what the OpenPalm memory service stores, where it stores it, what external calls it makes, and how to manage or delete memory data.

## What is stored

The memory service stores **extracted facts**, not raw conversation transcripts. When the assistant sends conversation text to the memory service with `infer: true`, an LLM extracts discrete factual statements (for example, "User prefers TypeScript over JavaScript") and stores each one individually. When `infer: false`, the submitted text is stored directly as a single memory.

Each memory record in the SQLite database contains:

| Column | Description |
|---|---|
| `id` | UUID v4 identifier |
| `data` | The extracted fact text (a plain-language statement) |
| `hash` | MD5 hash of the fact text (used for change detection) |
| `user_id` | User identifier (e.g., `default_user`) |
| `agent_id` | Agent identifier (if provided) |
| `run_id` | Run/session identifier (if provided) |
| `metadata` | JSON object with optional fields: `category`, `source`, `confidence`, `access_count`, `last_accessed`, feedback scores |
| `created_at` | Timestamp of creation |
| `updated_at` | Timestamp of last modification |

In addition to the metadata table, a **vector embedding** of each fact is stored in a `sqlite-vec` virtual table. This is a float array (dimensions depend on the configured embedding model) used for semantic similarity search.

A **history table** tracks all mutations (ADD, UPDATE, DELETE) to memory records, storing the previous and new values along with timestamps. This provides an audit trail of how memories change over time.

## Where it is stored

All memory data lives in a single SQLite database file on the local filesystem:

- **Default path (production):** `~/.local/share/openpalm/memory/memory.db`
- **Dev mode path:** `.dev/data/memory/memory.db`
- **Inside the container:** `/data/memory.db` (volume-mounted from the host path above)

Associated WAL and SHM files (`memory.db-wal`, `memory.db-shm`) may also exist alongside the database.

The memory configuration file is stored at:
- `~/.local/share/openpalm/memory/default_config.json` (or `.dev/data/memory/default_config.json` in dev mode)

The config file still uses a mem0-shaped JSON structure for compatibility, but the running service is OpenPalm's Bun-based memory API backed by SQLite and `sqlite-vec`.

**No data is synced to any cloud service by OpenPalm itself.** The SQLite database and all memory data remain entirely on the host machine.

## What is NOT stored

- **API keys or tokens.** API keys for LLM/embedding providers are stored in `vault/user.env`, not in the memory database. The memory service resolves `env:VAR_NAME` references at runtime.
- **Passwords or credentials.**
- **Raw conversation transcripts.** The memory service receives conversation text only to extract facts from it. The raw conversation text is not persisted; only the LLM-extracted facts are stored.
- **Embedding model weights or binaries.** Only the computed vector embeddings are stored.

## External service calls

The memory service makes outbound HTTP calls to two types of external providers. **The specific provider depends entirely on operator configuration:**

### LLM provider (fact extraction)

When a memory is added with `infer: true` (the default), the conversation text is sent to the configured LLM provider for fact extraction. The LLM also receives existing related memories to decide whether to add, update, or delete.

- **Ollama (local):** Calls `POST /api/chat` on the configured Ollama instance. If Ollama runs on the same host, this stays on the local network.
- **OpenAI-compatible (remote):** Calls `POST /chat/completions` on the configured base URL (e.g., `https://api.openai.com/v1`). The conversation text leaves your network.

### Embedding provider (vector generation)

Every time a fact is stored or a search query is executed, the text is sent to the configured embedding provider to generate a vector representation.

- **Ollama (local):** Calls `POST /api/embed` on the configured Ollama instance.
- **OpenAI-compatible (remote):** Calls `POST /embeddings` on the configured base URL.

**To keep all data on your local network**, configure both the LLM and embedding providers to use a local Ollama instance. When using remote providers (OpenAI, Anthropic, etc.), the fact text and search queries are sent to those external APIs.

### Assistant model (chat completions)

The assistant service (OpenCode) sends conversation messages to the configured chat model for inference. Which model is used depends entirely on operator configuration during setup:

- **Local provider (Ollama):** All inference stays on the local network. No data leaves the host.
- **Remote provider (OpenAI, Anthropic, Groq, etc.):** Conversation content is sent to that provider's API. Each provider has its own data retention and usage policies. Consult the provider's terms of service and privacy policy for details.

OpenPalm does not default to any specific model. The setup wizard requires the operator to choose a provider and model before the stack starts. This ensures the operator makes a conscious decision about where their data is processed.

## How to view stored memories

### Memory service API (direct)

The memory service exposes a REST API on port 8765 (accessible from within the Docker network, and optionally bound to the host):

```bash
# List memories via filter endpoint
curl -X POST http://localhost:8765/api/v1/memories/filter \
  -H "Content-Type: application/json" \
  -d '{"user_id": "default_user", "size": 50}'

# Search memories semantically
curl -X POST http://localhost:8765/api/v2/memories/search \
  -H "Content-Type: application/json" \
  -d '{"user_id": "default_user", "query": "programming preferences"}'

# Get a specific memory by ID
curl http://localhost:8765/api/v1/memories/MEMORY_UUID

# Get memory stats
curl "http://localhost:8765/api/v1/stats/?user_id=default_user"

# View current config (API keys are redacted)
curl http://localhost:8765/api/v1/config/
```

### Assistant tools

The assistant can list and search memories through its built-in tools: `memory-list`, `memory-search`, `memory-get`, and `memory-stats`.

## How to wipe all memory data

### Option 1: Delete the SQLite database file

Stop the memory container, then delete the database file and its WAL/SHM companions:

```bash
# Stop the memory service
docker compose stop memory

# Remove the database (adjust path for your DATA_HOME)
rm -f ~/.local/share/openpalm/memory/memory.db
rm -f ~/.local/share/openpalm/memory/memory.db-wal
rm -f ~/.local/share/openpalm/memory/memory.db-shm

# Restart — a fresh empty database will be created automatically
docker compose start memory
```

### Option 2: Admin API reset endpoint

The admin API provides a reset endpoint that deletes the configured SQLite-backed vector store files and any legacy Qdrant data. The memory container must be restarted afterwards:

```bash
curl -X POST http://localhost:8100/admin/memory/reset-collection \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"

# Then restart the memory container to recreate empty tables
docker compose restart memory
```

### Option 3: Delete individual memories or all memories for a user

```bash
# Delete a single memory
curl -X DELETE http://localhost:8765/api/v1/memories/ \
  -H "Content-Type: application/json" \
  -d '{"memory_id": "MEMORY_UUID"}'

# Delete multiple memories by ID
curl -X DELETE http://localhost:8765/api/v1/memories/ \
  -H "Content-Type: application/json" \
  -d '{"memory_ids": ["UUID1", "UUID2"]}'

# Delete all memories for a user
curl -X DELETE http://localhost:8765/api/v1/memories/ \
  -H "Content-Type: application/json" \
  -d '{"user_id": "default_user"}'
```

### Option 4: Assistant tools

The assistant has a `memory-delete` tool that can remove individual memories by ID.

## Data retention

- **No automatic expiry.** Memories persist indefinitely until explicitly deleted.
- **No automatic cleanup inside the memory service.** The storage API does not prune old or low-confidence memories on its own.
- **Assistant-side hygiene may curate assistant-created memories.** When memory automation is enabled in the assistant plugin, duplicate and stale memories can be reviewed and pruned conservatively.
- **User controls all data.** The operator has full control over when memories are created, updated, and deleted. The SQLite database is a regular file on disk that can be backed up, inspected, or removed at any time.
- **History is retained alongside memories.** The mutation history table records all ADD, UPDATE, and DELETE operations. Resetting the collection (Option 2 above) or deleting the database file (Option 1) also removes all history records.
