# Plan: Replace openmemory Python container with mem0-ts in admin app

## Context

The stack runs a Python FastAPI container (`openmemory`) wrapping the mem0 Python SDK + embedded Qdrant + SQLAlchemy/SQLite. This adds ~200MB of memory, a ~2min build step, and a whole Python runtime to the stack.

The mem0 TypeScript SDK (`vendor/mem0/mem0-ts/src/oss/`) provides feature-equivalent core operations (add/search/get/update/delete with LLM fact extraction and embeddings). Critically, it already ships a **`MemoryVectorStore`** that persists vectors in SQLite with brute-force cosine similarity — no Qdrant needed.

This plan embeds the mem0-ts `Memory` class directly in the admin Node.js app, exposes the same REST API the assistant tools already call, and removes the Python container. No data migration needed (still POC).

## Files to create

### 1. `core/admin/src/lib/server/memory-service.ts` (~80 lines)

Singleton that wraps `mem0-ts` OSS `Memory` class:

- Lazy-init `Memory` from config on first request
- Read LLM/embedder settings from existing `openmemory-config.ts` (`readOpenMemoryConfig`, `resolveApiKey`)
- Use `vectorStore: { provider: "memory", config: { dbPath: DATA_HOME/openmemory/vector_store.db } }`
- Use `historyStore: { provider: "sqlite", config: { historyDbPath: DATA_HOME/openmemory/history.db } }`
- Export `getMemory(dataDir, configDir): Memory` and `resetMemory(): void`

### 2. SvelteKit API routes (~250 lines total)

All routes follow existing admin pattern: `requireAdmin` → `getState` → validate → execute → `appendAudit` → `jsonResponse`. Helpers from `core/admin/src/lib/server/helpers.ts`.

| Route file | Methods | Maps to |
|-----------|---------|---------|
| `src/routes/api/v1/memories/+server.ts` | POST, DELETE | `memory.add()`, `memory.delete()` |
| `src/routes/api/v1/memories/[id]/+server.ts` | GET, PUT | `memory.get()`, `memory.update()` |
| `src/routes/api/v1/memories/filter/+server.ts` | POST | `memory.search()` / `memory.getAll()` |
| `src/routes/api/v1/memories/search/+server.ts` | POST | v2 search shape |
| `src/routes/api/v1/stats/+server.ts` | GET | count from `memory.getAll()` |
| `src/routes/api/v1/memories/[id]/feedback/+server.ts` | POST | store in metadata |

## Files to modify

### 3. `core/admin/src/lib/server/openmemory-config.ts`
- Change default vector_store from `"qdrant"` to `"memory"` (SQLite)
- Remove: `pushConfigToOpenMemory`, `fetchConfigFromOpenMemory`, `provisionOpenMemoryUser`, `checkQdrantDimensions`, `resetQdrantCollection`
- Keep: `readOpenMemoryConfig`, `writeOpenMemoryConfig`, `resolveApiKey`, `fetchProviderModels`, `ensureOpenMemoryConfig`

### 4. `core/admin/src/routes/admin/openmemory/config/+server.ts`
- Remove "push to running container" logic
- Config changes call `resetMemory()` to reinitialize in-process Memory instance

### 5. `core/admin/src/routes/admin/openmemory/reset-collection/+server.ts`
- Replace `resetQdrantCollection()` with `memory.reset()` (deletes SQLite vector data)

### 6. `core/admin/src/lib/server/control-plane.ts`
- Remove openmemory-specific exports (push/fetch/provision/qdrant)
- Add `getMemory`, `resetMemory` exports

### 7. `core/admin/package.json`
- Add: `mem0ai`, `sqlite3` (native addon — admin runs Node.js), `openai` (peer dep)

### 8. `core/assets/docker-compose.yml`
- Remove entire `openmemory` service block
- Remove `openmemory` from `assistant`'s `depends_on`

### 9. `core/assets/Caddyfile`
- Add memory API routes: `/api/v1/memories/*` and `/api/v1/stats/*` → `reverse_proxy admin:8100`

### 10. `core/admin/src/lib/server/types.ts`
- Remove `"openmemory"` from `CoreServiceName` and `CORE_SERVICES` (5 → 4)

### 11. `core/admin/src/lib/server/lifecycle.test.ts`
- Update CORE_SERVICES test: 5 → 4, remove `"openmemory"` assertion

### 12. `packages/assistant-tools/opencode/plugins/memory-lib.ts`
- Update `OPENMEMORY_URL` default from `http://openmemory:8765` to `http://admin:8100`

### 13. `packages/assistant-tools/opencode/tools/lib.ts`
- Update `OPENMEMORY_URL` default
- Remove MCP SSE provisioning logic — admin creates users directly via REST
- Simplify `ensureMemoryUserProvisioned()` to a simple POST

### 14. `packages/assistant-tools/dist/index.js`
- Update compiled OPENMEMORY_URL and remove MCP SSE provisioning

## Files to delete

### 15. `core/memory-api/Dockerfile`
Already deleted in previous commit.

### 16. `compose.dev.yaml` — remove openmemory build directive
### 17. `.github/workflows/release.yml` — remove memory-api from matrix
### 18. SKILL.md files + docs — update openmemory references

## Verification

1. `bun run test` — admin unit tests pass (updated CORE_SERVICES count)
2. `docker compose config -q` — validates without openmemory service
3. `npm run check` in core/admin — TypeScript compiles
4. Manual: POST add → POST search → GET by ID → PUT update → DELETE → confirm cycle works
5. Full stack: assistant memory-context plugin auto-extracts and searches through admin routes
