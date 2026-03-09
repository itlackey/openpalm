/**
 * 05 — HTTP API Response Shape Parity Tests
 *
 * Verifies that the Bun.js server produces the same HTTP response shapes
 * as the original Python FastAPI service. Uses a test server helper that
 * mirrors the route handler from core/memory/src/server.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  createTestMemory,
  cleanupDb,
  createTestServer,
  type TestMemoryResult,
} from './helpers.js';
import type { Memory } from '../src/memory.js';

let t: TestMemoryResult;
let mem: Memory;
let server: ReturnType<typeof createTestServer>;

beforeAll(async () => {
  t = createTestMemory();
  mem = t.mem;
  await mem.initialize();
  server = createTestServer(mem);
});

afterAll(() => {
  server.close();
  mem.close();
  cleanupDb(t.dbPath);
});

/** Helper to POST JSON to the test server. */
async function post(path: string, body: Record<string, unknown>) {
  return fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Helper to PUT JSON to the test server. */
async function put(path: string, body: Record<string, unknown>) {
  return fetch(`${server.url}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Helper to DELETE with JSON body. */
async function del(path: string, body: Record<string, unknown>) {
  return fetch(`${server.url}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('05 — Server API Response Shape Parity', () => {
  // ── Test 1: POST /api/v1/memories/ returns mem0 shape ──────────────
  test('POST /api/v1/memories/ returns {results: [...], id} shape', async () => {
    const res = await post('/api/v1/memories/', {
      text: 'Server test fact',
      user_id: 'server-alice',
      infer: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toHaveProperty('event', 'ADD');
    expect(data.results[0]).toHaveProperty('id');
    expect(data.results[0]).toHaveProperty('text', 'Server test fact');

    // Top-level id matches first result
    expect(data).toHaveProperty('id');
    expect(data.id).toBe(data.results[0].id);
  });

  // ── Test 2: POST with infer:false returns event:'ADD' ──────────────
  test('POST /api/v1/memories/ with infer:false returns {results: [{event:"ADD"}], id}', async () => {
    const res = await post('/api/v1/memories/', {
      text: 'No-infer fact',
      user_id: 'server-alice',
      infer: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.results[0].event).toBe('ADD');
    expect(typeof data.results[0].id).toBe('string');
    expect(typeof data.id).toBe('string');
  });

  // ── Test 3: POST /api/v1/memories/filter with search_query ─────────
  test('POST /api/v1/memories/filter with search_query returns {items: [...]}', async () => {
    // Add a memory first
    await post('/api/v1/memories/', {
      text: 'Searchable fact',
      user_id: 'server-alice',
      infer: false,
    });

    const res = await post('/api/v1/memories/filter', {
      search_query: 'Searchable',
      user_id: 'server-alice',
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data).toHaveProperty('items');
    expect(Array.isArray(data.items)).toBe(true);

    if (data.items.length > 0) {
      const item = data.items[0];
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('content');
      expect(item).toHaveProperty('metadata');
      expect(item).toHaveProperty('created_at');
    }
  });

  // ── Test 4: POST /api/v1/memories/filter without query (getAll) ────
  test('POST /api/v1/memories/filter without query returns {items: [...]} (getAll)', async () => {
    const res = await post('/api/v1/memories/filter', {
      user_id: 'server-alice',
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data).toHaveProperty('items');
    expect(Array.isArray(data.items)).toBe(true);
  });

  // ── Test 5: POST /api/v2/memories/search returns {results: [...]} ──
  test('POST /api/v2/memories/search returns {results: [...]}', async () => {
    const res = await post('/api/v2/memories/search', {
      query: 'Searchable',
      user_id: 'server-alice',
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);

    if (data.results.length > 0) {
      const item = data.results[0];
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('content');
      expect(item).toHaveProperty('metadata');
      expect(item).toHaveProperty('created_at');
    }
  });

  // ── Test 6: GET /api/v1/memories/:id returns normalized shape ──────
  test('GET /api/v1/memories/:id returns {id, content, metadata, created_at}', async () => {
    // Add a memory to retrieve
    const addRes = await post('/api/v1/memories/', {
      text: 'Get by ID test',
      user_id: 'server-alice',
      infer: false,
    });
    const { id } = await addRes.json();

    const res = await fetch(`${server.url}/api/v1/memories/${id}`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('id', id);
    expect(data).toHaveProperty('content', 'Get by ID test');
    expect(data).toHaveProperty('metadata');
    expect(data).toHaveProperty('created_at');
  });

  // ── Test 7: GET missing ID returns 404 with {detail: ...} ──────────
  test('GET /api/v1/memories/:id for missing ID returns 404 {detail: ...}', async () => {
    const res = await fetch(`${server.url}/api/v1/memories/nonexistent-id`);
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data).toHaveProperty('detail');
    expect(typeof data.detail).toBe('string');
  });

  // ── Test 8: PUT /api/v1/memories/:id returns update result ─────────
  test('PUT /api/v1/memories/:id returns update result', async () => {
    // Add a memory first
    const addRes = await post('/api/v1/memories/', {
      text: 'Before update',
      user_id: 'server-alice',
      infer: false,
    });
    const { id } = await addRes.json();

    const res = await put(`/api/v1/memories/${id}`, {
      data: 'After update',
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('id', id);
    expect(data).toHaveProperty('content', 'After update');
  });

  // ── Test 9: DELETE with memory_id ──────────────────────────────────
  test('DELETE /api/v1/memories/ with memory_id returns {status:"ok", deleted}', async () => {
    const addRes = await post('/api/v1/memories/', {
      text: 'To delete by ID',
      user_id: 'server-alice',
      infer: false,
    });
    const { id } = await addRes.json();

    const res = await del('/api/v1/memories/', { memory_id: id });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('status', 'ok');
    expect(data).toHaveProperty('deleted', id);
  });

  // ── Test 10: DELETE with user_id ───────────────────────────────────
  test('DELETE /api/v1/memories/ with user_id returns {status:"ok", deleted_all_for}', async () => {
    await post('/api/v1/memories/', {
      text: 'Delete user fact',
      user_id: 'server-delete-user',
      infer: false,
    });

    const res = await del('/api/v1/memories/', {
      user_id: 'server-delete-user',
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('status', 'ok');
    expect(data).toHaveProperty('deleted_all_for', 'server-delete-user');
  });

  // ── Test 11: GET /api/v1/stats/ ────────────────────────────────────
  test('GET /api/v1/stats/ returns {total_memories: N}', async () => {
    // Add some memories for the stats user
    await post('/api/v1/memories/', {
      text: 'Stats fact 1',
      user_id: 'stats-user',
      infer: false,
    });
    await post('/api/v1/memories/', {
      text: 'Stats fact 2',
      user_id: 'stats-user',
      infer: false,
    });

    const res = await fetch(
      `${server.url}/api/v1/stats/?user_id=stats-user`,
    );
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('total_memories');
    expect(typeof data.total_memories).toBe('number');
    expect(data.total_memories).toBeGreaterThanOrEqual(2);
  });

  // ── Test 12: GET /health ───────────────────────────────────────────
  test('GET /health returns {status:"ok"}', async () => {
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ status: 'ok' });
  });
});
