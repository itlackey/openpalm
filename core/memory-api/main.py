"""
OpenPalm Memory API — lightweight FastAPI wrapper around the mem0 Python SDK.

Exposes only the REST endpoints consumed by the assistant tools.
Uses Qdrant file-based storage (embedded) and mem0's built-in LLM fact extraction.
"""

import json
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from mem0 import Memory

app = FastAPI(title="OpenPalm Memory API")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CONFIG_PATH = os.environ.get("OPENMEMORY_CONFIG_PATH", "/app/default_config.json")
DATA_DIR = os.environ.get("HOME", "/data")

_memory: Memory | None = None


def _load_config() -> dict:
    """Read mem0 config from the JSON file mounted into the container."""
    if not os.path.exists(CONFIG_PATH):
        return {}
    with open(CONFIG_PATH) as f:
        raw = json.load(f)
    config = raw.get("mem0", raw)

    # Resolve env:VAR placeholders in API keys
    for section in ("llm", "embedder"):
        cfg = config.get(section, {}).get("config", {})
        api_key = cfg.get("api_key", "")
        if isinstance(api_key, str) and api_key.startswith("env:"):
            var_name = api_key[4:]
            cfg["api_key"] = os.environ.get(var_name, "")

    # Ensure history_db_path is set
    if "history_db_path" not in config:
        config["history_db_path"] = os.path.join(DATA_DIR, "history.db")

    return config


def get_memory() -> Memory:
    """Lazy-init Memory singleton from config file."""
    global _memory
    if _memory is None:
        config = _load_config()
        _memory = Memory.from_config(config) if config else Memory()
    return _memory


def reset_memory() -> None:
    """Discard the current Memory instance so it reinitializes on next call."""
    global _memory
    _memory = None


# ---------------------------------------------------------------------------
# Request/Response models
# ---------------------------------------------------------------------------

class AddRequest(BaseModel):
    text: str
    user_id: str = "default_user"
    agent_id: Optional[str] = None
    run_id: Optional[str] = None
    app_id: Optional[str] = None  # accepted but not forwarded to mem0
    app: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    infer: bool = True


class FilterRequest(BaseModel):
    user_id: str = "default_user"
    agent_id: Optional[str] = None
    run_id: Optional[str] = None
    app_id: Optional[str] = None
    search_query: Optional[str] = None
    page: int = 1
    size: int = 10


class SearchRequest(BaseModel):
    query: str
    user_id: str = "default_user"
    agent_id: Optional[str] = None
    run_id: Optional[str] = None
    app_id: Optional[str] = None
    search_query: Optional[str] = None  # alias used by v1 callers
    filters: Optional[Dict[str, Any]] = None
    page: int = 1
    size: int = 10


class UpdateRequest(BaseModel):
    data: str


class DeleteRequest(BaseModel):
    memory_id: Optional[str] = None
    user_id: Optional[str] = None


class FeedbackRequest(BaseModel):
    memory_id: Optional[str] = None
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    app_id: Optional[str] = None
    run_id: Optional[str] = None
    value: int = 0
    reason: Optional[str] = None


class UserRequest(BaseModel):
    user_id: str = "default_user"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_memory(item: dict) -> dict:
    """Normalize a mem0 result dict to the shape callers expect."""
    return {
        "id": item.get("id", ""),
        "content": item.get("memory", item.get("content", "")),
        "metadata": item.get("metadata", {}),
        "created_at": item.get("created_at", ""),
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/v1/memories/")
async def add_memories(body: AddRequest):
    m = get_memory()
    result = m.add(
        body.text,
        user_id=body.user_id,
        agent_id=body.agent_id,
        run_id=body.run_id,
        metadata=body.metadata,
        infer=body.infer,
    )
    # mem0 returns a dict with "results" key containing list of actions
    return result


@app.post("/api/v1/memories/filter")
async def filter_memories(body: FilterRequest):
    m = get_memory()
    if body.search_query:
        results = m.search(
            body.search_query,
            user_id=body.user_id,
            agent_id=body.agent_id,
            run_id=body.run_id,
            limit=body.size,
        )
        items = [_normalize_memory(r) for r in results.get("results", results) if isinstance(r, dict)]
        return {"items": items}

    results = m.get_all(
        user_id=body.user_id,
        agent_id=body.agent_id,
        run_id=body.run_id,
        limit=body.size,
    )
    items = [_normalize_memory(r) for r in results.get("results", results) if isinstance(r, dict)]
    return {"items": items}


@app.post("/api/v2/memories/search")
async def search_memories_v2(body: SearchRequest):
    m = get_memory()
    query = body.query or body.search_query or ""
    if not query:
        raise HTTPException(status_code=400, detail="query is required")

    results = m.search(
        query,
        user_id=body.user_id,
        agent_id=body.agent_id,
        run_id=body.run_id,
        limit=body.size,
    )
    raw = results.get("results", results) if isinstance(results, dict) else results
    items = [_normalize_memory(r) for r in raw if isinstance(r, dict)]
    return {"results": items}


@app.get("/api/v1/memories/{memory_id}")
async def get_memory_by_id(memory_id: str):
    m = get_memory()
    try:
        result = m.get(memory_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Memory not found")
    if not result:
        raise HTTPException(status_code=404, detail="Memory not found")
    return _normalize_memory(result)


@app.put("/api/v1/memories/{memory_id}")
async def update_memory_by_id(memory_id: str, body: UpdateRequest):
    m = get_memory()
    try:
        result = m.update(memory_id, body.data)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))
    return result


@app.delete("/api/v1/memories/")
async def delete_memories(body: DeleteRequest):
    m = get_memory()
    if body.memory_id:
        m.delete(body.memory_id)
        return {"status": "ok", "deleted": body.memory_id}
    if body.user_id:
        m.delete_all(user_id=body.user_id)
        return {"status": "ok", "deleted_all_for": body.user_id}
    raise HTTPException(status_code=400, detail="memory_id or user_id required")


@app.get("/api/v1/stats/")
async def get_stats(user_id: str = "default_user"):
    m = get_memory()
    all_memories = m.get_all(user_id=user_id)
    items = all_memories.get("results", all_memories) if isinstance(all_memories, dict) else all_memories
    count = len(items) if isinstance(items, list) else 0
    return {"total_memories": count, "total_apps": 1}


@app.post("/api/v1/memories/{memory_id}/feedback")
async def memory_feedback(memory_id: str, body: FeedbackRequest):
    m = get_memory()
    try:
        existing = m.get(memory_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Memory not found")
    if not existing:
        raise HTTPException(status_code=404, detail="Memory not found")

    metadata = existing.get("metadata", {}) or {}
    pos = metadata.get("positive_feedback_count", 0) or 0
    neg = metadata.get("negative_feedback_count", 0) or 0
    if body.value > 0:
        pos += 1
    elif body.value < 0:
        neg += 1
    metadata["positive_feedback_count"] = pos
    metadata["negative_feedback_count"] = neg
    metadata["feedback_score"] = pos - neg
    if body.reason:
        metadata["last_feedback_reason"] = body.reason

    # mem0 update expects the memory text; we keep it unchanged
    content = existing.get("memory", existing.get("content", ""))
    m.update(memory_id, content, metadata=metadata)
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Config management (called by admin)
# ---------------------------------------------------------------------------

@app.get("/api/v1/config/")
async def get_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {}


@app.put("/api/v1/config/")
async def put_config(config: dict):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)
        f.write("\n")
    reset_memory()
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# User provisioning (replaces MCP SSE handshake)
# ---------------------------------------------------------------------------

@app.post("/api/v1/users")
async def provision_user(body: UserRequest):
    """No-op user creation — mem0 SDK doesn't need explicit user provisioning."""
    return {"status": "ok", "user_id": body.user_id}


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok"}
