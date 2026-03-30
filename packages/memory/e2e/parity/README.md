# mem0 Parity Test Suite

Development-only test suite that verifies 1:1 behavioral parity between `@openpalm/memory` (TypeScript port) and the original mem0 Python SDK.

## Running

```bash
# From repo root
bun run test:parity

# Or directly
bun test packages/memory/parity-tests/
```

## Isolation

These tests live outside `src/__tests__/` so they are **not** picked up by:
- `bun test --cwd packages/memory` (standard package tests)
- `bun run test` (root test script)

Only `bun run test:parity` runs them.

## Test Files

| File | Tests | What it verifies |
|------|-------|-----------------|
| `01-memory-crud.test.ts` | 14 | CRUD operations: add, get, getAll, update, delete, deleteAll |
| `02-infer-pipeline.test.ts` | 12 | 2-phase LLM pipeline: fact extraction + memory update decisions |
| `03-search-ranking.test.ts` | 8 | Vector search, scoring, filtering, deterministic embeddings |
| `04-history-tracking.test.ts` | 8 | Audit trail: ADD/UPDATE/DELETE history entries |
| `05-server-api.test.ts` | 12 | HTTP REST API response shapes (mirrors Python FastAPI service) |
| `06-edge-cases.test.ts` | 10 | Boundary conditions: empty input, large text, concurrent init, post-close |

**Total: 64 tests**

## Design

- All tests use **stub LLM and embedder** (no real API calls)
- Stub embedder uses deterministic hash-based vectors
- Stub LLM returns pre-configured JSON responses by call index
- Each test uses a unique temp SQLite database (auto-cleaned)
- Server API tests use a lightweight Bun.serve() that mirrors `core/memory/src/server.ts` routes
