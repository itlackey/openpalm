# Memory API — Local Development Guide

The memory API is a lightweight FastAPI application that wraps the
[mem0 Python SDK](https://github.com/mem0ai/mem0) with embedded Qdrant
(file-based) vector storage. It lives in `core/memory-api/` and runs as the
`openmemory` service in the Docker Compose stack.

---

## Prerequisites

- Python 3.12+
- An OpenAI-compatible API key (or a local model runner)
- `pip` (or `uv` / `pipx` if preferred)

---

## Quick Start (outside Docker)

```bash
cd core/memory-api

# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### Provide a config file

The app reads `default_config.json` on startup. Create one locally:

```bash
cat > default_config.json <<'EOF'
{
  "mem0": {
    "llm": {
      "provider": "openai",
      "config": {
        "model": "gpt-4o-mini",
        "temperature": 0.1,
        "max_tokens": 2000,
        "api_key": "env:OPENAI_API_KEY"
      }
    },
    "embedder": {
      "provider": "openai",
      "config": {
        "model": "text-embedding-3-small",
        "api_key": "env:OPENAI_API_KEY"
      }
    }
  }
}
EOF
```

The `"env:OPENAI_API_KEY"` syntax tells the app to read the actual key from the
`OPENAI_API_KEY` environment variable at runtime.

### Start the server

```bash
export OPENAI_API_KEY="sk-..."           # or your compatible key
export OPENMEMORY_CONFIG_PATH="./default_config.json"
export OPENMEMORY_DATA_DIR="./data"      # Qdrant + history DB land here

uvicorn main:app --host 0.0.0.0 --port 8765 --reload
```

The API is now running at `http://localhost:8765`.
Swagger UI is at `http://localhost:8765/docs`.

---

## Quick Start (with Docker Compose)

From the repo root, build and run just the memory API:

```bash
docker compose -f core/assets/docker-compose.yml -f compose.dev.yaml \
  up --build openmemory
```

This builds the image from `core/memory-api/Dockerfile` and starts the service
on port 8765. Data is persisted in `$OPENPALM_DATA_HOME/openmemory/`.

---

## Project Structure

```
core/memory-api/
├── main.py              # Single-file FastAPI app (~310 lines)
├── requirements.txt     # Python dependencies
└── Dockerfile           # Production image (python:3.12-slim)
```

### Dependencies

| Package | Purpose |
|---------|---------|
| `fastapi` | Web framework |
| `uvicorn[standard]` | ASGI server |
| `mem0ai` | Memory SDK (pulls in qdrant-client, openai, pydantic) |
| `python-dotenv` | `.env` file loading |

---

## API Endpoints

All endpoints are unauthenticated (network isolation provides security in the
Docker stack). Full request/response shapes are visible in the Swagger UI at
`/docs`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/memories/` | Add a memory (LLM fact extraction) |
| `POST` | `/api/v1/memories/filter` | List or search memories |
| `POST` | `/api/v2/memories/search` | Vector similarity search |
| `GET` | `/api/v1/memories/{id}` | Get a single memory by ID |
| `PUT` | `/api/v1/memories/{id}` | Update memory content |
| `DELETE` | `/api/v1/memories/` | Delete by memory_id or user_id |
| `GET` | `/api/v1/stats/` | Memory count for a user |
| `POST` | `/api/v1/memories/{id}/feedback` | Submit positive/negative feedback |
| `GET` | `/api/v1/config/` | Read current config |
| `PUT` | `/api/v1/config/` | Write config (validated) and reinitialize Memory |
| `POST` | `/api/v1/users` | No-op user provisioning |
| `GET` | `/health` | Health check |

---

## Testing the API

### Smoke test

```bash
# Health check
curl http://localhost:8765/health
# → {"status":"ok"}
```

### Full CRUD cycle

```bash
BASE=http://localhost:8765

# 1. Add a memory
curl -s -X POST "$BASE/api/v1/memories/" \
  -H "content-type: application/json" \
  -d '{"text": "The project uses FastAPI with mem0 SDK", "user_id": "dev"}' \
  | python3 -m json.tool

# 2. Search memories
curl -s -X POST "$BASE/api/v2/memories/search" \
  -H "content-type: application/json" \
  -d '{"query": "what framework", "user_id": "dev"}' \
  | python3 -m json.tool

# 3. List all memories for a user
curl -s -X POST "$BASE/api/v1/memories/filter" \
  -H "content-type: application/json" \
  -d '{"user_id": "dev"}' \
  | python3 -m json.tool

# 4. Get a specific memory (replace MEMORY_ID)
curl -s "$BASE/api/v1/memories/MEMORY_ID" | python3 -m json.tool

# 5. Update a memory
curl -s -X PUT "$BASE/api/v1/memories/MEMORY_ID" \
  -H "content-type: application/json" \
  -d '{"data": "The project uses FastAPI with the mem0 Python SDK"}' \
  | python3 -m json.tool

# 6. Delete a memory
curl -s -X DELETE "$BASE/api/v1/memories/" \
  -H "content-type: application/json" \
  -d '{"memory_id": "MEMORY_ID"}' \
  | python3 -m json.tool

# 7. Stats
curl -s "$BASE/api/v1/stats/?user_id=dev" | python3 -m json.tool
```

### Config hot-reload

Push a new config without restarting the server:

```bash
curl -s -X PUT "$BASE/api/v1/config/" \
  -H "content-type: application/json" \
  -d '{
    "mem0": {
      "llm": {
        "provider": "openai",
        "config": {
          "model": "gpt-4o-mini",
          "api_key": "env:OPENAI_API_KEY"
        }
      },
      "embedder": {
        "provider": "openai",
        "config": {
          "model": "text-embedding-3-small",
          "api_key": "env:OPENAI_API_KEY"
        }
      }
    }
  }'
```

The endpoint validates the config structure before persisting — it checks that
`mem0`, `llm`, `embedder`, their inner `config` objects, and `history_db_path`
are the expected types. Invalid payloads return `400`. On success it writes the
config to disk and reinitializes the Memory instance.

### Feedback

```bash
# Submit positive feedback on a memory
curl -s -X POST "$BASE/api/v1/memories/MEMORY_ID/feedback" \
  -H "content-type: application/json" \
  -d '{"value": 1, "reason": "accurate", "user_id": "dev"}' \
  | python3 -m json.tool
# → {"status":"ok"}

# Feedback updates metadata counters (positive_feedback_count,
# negative_feedback_count, feedback_score) persisted via mem0 update.
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENMEMORY_CONFIG_PATH` | `/app/default_config.json` | Path to the mem0 config JSON |
| `OPENMEMORY_DATA_DIR` | `/data` | Base directory for Qdrant data and history DB |
| `OPENAI_API_KEY` | — | API key (resolved from `env:OPENAI_API_KEY` in config) |
| `OPENAI_BASE_URL` | — | Custom base URL for OpenAI-compatible providers |
| `OPENMEMORY_OPENAI_API_KEY` | — | Override API key (takes precedence if set in config) |

---

## Architecture Notes

- **Single-file app** — all logic is in `main.py`. No ORM, no migrations, no
  multi-tenant ACL.
- **mem0 SDK** — handles LLM fact extraction, embedding generation, and Qdrant
  vector operations. The API is a thin HTTP adapter.
- **Qdrant embedded** — stores vectors in files under `$OPENMEMORY_DATA_DIR/`. No separate
  Qdrant server needed.
- **Lazy init** — the `Memory` instance is created on first request, not at
  import time. This allows the config file to be mounted after the process
  starts.
- **Config reload** — `PUT /api/v1/config/` validates the payload structure,
  writes the file, and calls `reset_memory()`, which discards the singleton so
  it reinitializes on the next request.
- **Feedback persistence** — the feedback endpoint updates metadata counters
  (`positive_feedback_count`, `negative_feedback_count`, `feedback_score`) and
  persists them via `m.update()` with the `metadata` parameter.

---

## Troubleshooting

**"No config found"** — The app returns empty results if
`default_config.json` doesn't exist. Make sure `OPENMEMORY_CONFIG_PATH` points
to a valid file or mount it at `/app/default_config.json`.

**Embedding dimension mismatch** — If you switch embedding models after data
already exists, Qdrant will reject new vectors. Delete the data directory
(`$OPENMEMORY_DATA_DIR/`) or use the admin's "Reset Collection" feature.

**Slow first request** — The first request initializes the mem0 `Memory`
instance, which loads the Qdrant collection. Subsequent requests are fast.
