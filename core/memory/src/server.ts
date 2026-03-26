/**
 * OpenPalm Memory API — lightweight Bun.js wrapper around @openpalm/memory.
 *
 * Exposes the same REST endpoints as the previous Python FastAPI service.
 * Uses Bun.serve() on port 8765.
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import { Memory } from '@openpalm/memory';
import type { MemoryConfig } from '@openpalm/memory';
import { buildConfigFromEnv } from './config';

// ── Config ────────────────────────────────────────────────────────────

const DATA_DIR = process.env.MEMORY_DATA_DIR ?? '/data';
const CONFIG_PATH = process.env.MEMORY_CONFIG_PATH ?? '';
const PORT = parseInt(process.env.MEMORY_PORT ?? '8765', 10);

let _memory: Memory | null = null;
let _memoryInit: Promise<Memory> | null = null;
// Serialize memory operations so a config-driven reset cannot close the
// sqlite-backed Memory instance while another request is still using it.
let _memoryQueue: Promise<void> = Promise.resolve();

function withMemoryLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = _memoryQueue.then(operation, operation);
  _memoryQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function getMemory(): Promise<Memory> {
  if (_memory) return _memory;
  if (_memoryInit) return _memoryInit;
  _memoryInit = (async () => {
    try {
      const memConfig = buildConfigFromEnv(process.env as Record<string, string | undefined>, DATA_DIR, CONFIG_PATH || undefined);
      if (!memConfig) {
        throw new Error('SYSTEM_LLM_PROVIDER not set — memory service requires capability configuration');
      }
      const m = new Memory(memConfig);
      await m.initialize();
      _memory = m;
      _memoryInit = null;
      return m;
    } catch (err) {
      _memoryInit = null;
      throw err;
    }
  })();
  return _memoryInit;
}

async function resetMemory(): Promise<void> {
  _memoryInit = null;
  if (_memory) {
    _memory.close();
    _memory = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function normalizeMemory(item: { id: string; content: string; metadata?: Record<string, unknown>; createdAt?: string }) {
  return {
    id: item.id,
    content: item.content,
    metadata: item.metadata ?? {},
    created_at: item.createdAt ?? '',
  };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, detail: string): Response {
  return json({ detail }, status);
}

// ── Config validation (mirrors Python version) ───────────────────────

const ALLOWED_MEM0_KEYS = new Set(['llm', 'embedder', 'vector_store', 'history_db_path', 'version']);
const ALLOWED_SECTION_KEYS = new Set(['provider', 'config']);

function validateConfigStructure(config: Record<string, unknown>): Record<string, unknown> {
  let mem0Cfg = (config.mem0 ?? config) as Record<string, unknown>;
  if (config.mem0 && typeof config.mem0 !== 'object') {
    throw new Error("The 'mem0' field must be an object.");
  }

  // Strip unknown top-level keys from mem0 section
  for (const key of Object.keys(mem0Cfg)) {
    if (!ALLOWED_MEM0_KEYS.has(key)) delete mem0Cfg[key];
  }

  for (const section of ['llm', 'embedder']) {
    const sectionCfg = mem0Cfg[section] as Record<string, unknown> | undefined;
    if (sectionCfg && typeof sectionCfg === 'object') {
      for (const key of Object.keys(sectionCfg)) {
        if (!ALLOWED_SECTION_KEYS.has(key)) delete sectionCfg[key];
      }
    }
  }

  // Preserve the top-level 'memory' section (contains custom_instructions, etc.)
  const result: Record<string, unknown> = config.mem0 ? { mem0: mem0Cfg } : { ...mem0Cfg };
  if (config.memory && typeof config.memory === 'object') {
    result.memory = config.memory;
  }
  return result;
}

function redactApiKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redactApiKeys);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if ((key === 'api_key' || key === 'apiKey') && typeof value === 'string' && !value.startsWith('env:')) {
        result[key] = '***REDACTED***';
      } else {
        result[key] = redactApiKeys(value);
      }
    }
    return result;
  }
  return obj;
}

// ── Timing-safe token comparison ──────────────────────────────────────

function safeTokenCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!a || !b) return false;
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

// ── Auth middleware ────────────────────────────────────────────────────

const MEMORY_AUTH_TOKEN = process.env.MEMORY_AUTH_TOKEN ?? '';

function checkAuth(req: Request): Response | null {
  // Skip auth if no token configured (backward compat)
  if (!MEMORY_AUTH_TOKEN) return null;

  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : '';

  if (!safeTokenCompare(token, MEMORY_AUTH_TOKEN)) {
    return errorResponse(401, 'Unauthorized');
  }
  return null;
}

// ── Route handler ─────────────────────────────────────────────────────

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    // Health — no auth required
    if (path === '/health' && method === 'GET') {
      return json({ status: 'ok' });
    }

    // Auth check on all other endpoints
    const authError = checkAuth(req);
    if (authError) return authError;

    return await withMemoryLock(async () => {
      // POST /api/v1/memories/
      if (path === '/api/v1/memories/' && method === 'POST') {
        const body = await readBody(req);
        if (!body.text || typeof body.text !== 'string' || body.text.trim() === '') {
          return errorResponse(400, 'text is required and must be a non-empty string');
        }
        const m = await getMemory();
        const result = await m.add(body.text as string, {
          userId: (body.user_id as string) ?? 'default_user',
          agentId: body.agent_id as string,
          runId: body.run_id as string,
          metadata: body.metadata as Record<string, unknown>,
          infer: body.infer !== false,
        });
        const firstId = (result.results as { id?: string }[])?.find(r => r.id)?.id ?? null;
        return json({ ...result, id: firstId });
      }

      // POST /api/v1/memories/filter
      if (path === '/api/v1/memories/filter' && method === 'POST') {
        const body = await readBody(req);
        const m = await getMemory();

        if (body.search_query) {
          const results = await m.search(body.search_query as string, {
            userId: (body.user_id as string) ?? 'default_user',
            agentId: body.agent_id as string,
            runId: body.run_id as string,
            limit: (body.size as number) ?? 10,
          });
          return json({ items: results.map(normalizeMemory) });
        }

        const results = await m.getAll({
          userId: (body.user_id as string) ?? 'default_user',
          agentId: body.agent_id as string,
          runId: body.run_id as string,
          limit: (body.size as number) ?? 10,
        });
        return json({ items: results.map(normalizeMemory) });
      }

      // POST /api/v2/memories/search
      if (path === '/api/v2/memories/search' && method === 'POST') {
        const body = await readBody(req);
        const query = (body.query ?? body.search_query) as string;
        if (!query) return errorResponse(400, 'query is required');

        const m = await getMemory();
        const results = await m.search(query, {
          userId: (body.user_id as string) ?? 'default_user',
          agentId: body.agent_id as string,
          runId: body.run_id as string,
          limit: (body.size as number) ?? 10,
        });
        return json({ results: results.map(normalizeMemory) });
      }

      // GET /api/v1/memories/:id
      const getMatch = path.match(/^\/api\/v1\/memories\/([^/]+)$/);
      if (getMatch && method === 'GET') {
        const memoryId = decodeURIComponent(getMatch[1]);
        const m = await getMemory();
        const result = await m.get(memoryId);
        if (!result) return errorResponse(404, 'Memory not found');
        return json(normalizeMemory(result));
      }

      // PUT /api/v1/memories/:id
      if (getMatch && method === 'PUT') {
        const memoryId = decodeURIComponent(getMatch[1]);
        const body = await readBody(req);
        if (!body.data || typeof body.data !== 'string' || body.data.trim() === '') {
          return errorResponse(400, 'data is required and must be a non-empty string');
        }
        const m = await getMemory();
        const result = await m.update(memoryId, body.data as string);
        return json(result);
      }

    // POST /api/v1/memories/:id/feedback
    const feedbackMatch = path.match(/^\/api\/v1\/memories\/([^/]+)\/feedback$/);
    if (feedbackMatch && method === 'POST') {
      const memoryId = decodeURIComponent(feedbackMatch[1]);
      const body = await readBody(req);
      const m = await getMemory();
      const existing = await m.get(memoryId);
      if (!existing) return errorResponse(404, 'Memory not found');

      const metadata = (existing.metadata ?? {}) as Record<string, unknown>;
      let pos = (metadata.positive_feedback_count as number) ?? 0;
      let neg = (metadata.negative_feedback_count as number) ?? 0;
      const value = (body.value as number) ?? 0;
      if (value > 0) pos++;
      else if (value < 0) neg++;
      metadata.positive_feedback_count = pos;
      metadata.negative_feedback_count = neg;
      metadata.feedback_score = pos - neg;
      if (body.reason) metadata.last_feedback_reason = body.reason;

      await m.update(memoryId, existing.content, metadata);
      return json({ status: 'ok' });
    }

      // DELETE /api/v1/memories/
      if (path === '/api/v1/memories/' && method === 'DELETE') {
        const body = await readBody(req);
        const m = await getMemory();
        if (body.memory_id) {
          await m.delete(body.memory_id as string);
          return json({ status: 'ok', deleted: body.memory_id });
        }
        if (body.memory_ids && Array.isArray(body.memory_ids)) {
          for (const id of body.memory_ids) {
            await m.delete(id as string);
          }
          return json({ status: 'ok', deleted: body.memory_ids });
        }
        if (body.user_id) {
          await m.deleteAll({ userId: body.user_id as string });
          return json({ status: 'ok', deleted_all_for: body.user_id });
        }
        return errorResponse(400, 'memory_id or user_id required');
      }

      // GET /api/v1/stats/
      if (path === '/api/v1/stats/' && method === 'GET') {
        const userId = url.searchParams.get('user_id') ?? 'default_user';
        const m = await getMemory();
        const limit = 10000;
        const items = await m.getAll({ userId, limit });
        const count = items.length;
        return json({
          total_memories: count,
          total_apps: 1,
          approximate: true,
          max_sampled: limit,
          capped: count >= limit,
        });
      }

      // POST /api/v1/users
      if (path === '/api/v1/users' && method === 'POST') {
        const body = await readBody(req);
        return json({ status: 'ok', user_id: (body.user_id as string) ?? 'default_user' });
      }

      return errorResponse(404, 'Not found');
    });
  } catch (err) {
    console.error('Request error:', err);
    return errorResponse(500, 'Internal server error');
  }
}

// ── Start server ──────────────────────────────────────────────────────

console.log(`OpenPalm Memory API starting on port ${PORT}...`);

Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`OpenPalm Memory API running on http://0.0.0.0:${PORT}`);
