/**
 * OpenPalm Memory API — lightweight Bun.js wrapper around @openpalm/memory.
 *
 * Exposes the same REST endpoints as the previous Python FastAPI service.
 * Uses Bun.serve() on port 8765.
 */
import { Memory } from '@openpalm/memory';
import type { MemoryConfig } from '@openpalm/memory';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ── Config ────────────────────────────────────────────────────────────

const CONFIG_PATH = process.env.MEMORY_CONFIG_PATH ?? '/app/default_config.json';
const DATA_DIR = process.env.MEMORY_DATA_DIR ?? '/data';
const PORT = parseInt(process.env.MEMORY_PORT ?? '8765', 10);

let _memory: Memory | null = null;

function loadConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function resolveEnvKeys(config: Record<string, unknown>): Record<string, unknown> {
  const resolved = structuredClone(config);
  for (const section of ['llm', 'embedder']) {
    const sectionObj = (resolved as any)?.mem0?.[section]?.config ?? (resolved as any)?.[section]?.config;
    if (sectionObj && typeof sectionObj.api_key === 'string' && sectionObj.api_key.startsWith('env:')) {
      const varName = sectionObj.api_key.slice(4);
      sectionObj.api_key = process.env[varName] ?? '';
    }
    // Also handle apiKey (camelCase variant)
    if (sectionObj && typeof sectionObj.apiKey === 'string' && sectionObj.apiKey.startsWith('env:')) {
      const varName = sectionObj.apiKey.slice(4);
      sectionObj.apiKey = process.env[varName] ?? '';
    }
  }
  return resolved;
}

function configToMemoryConfig(raw: Record<string, unknown>): MemoryConfig {
  const mem0 = (raw.mem0 ?? raw) as Record<string, unknown>;

  const llm = mem0.llm as { provider?: string; config?: Record<string, unknown> } | undefined;
  const embedder = mem0.embedder as { provider?: string; config?: Record<string, unknown> } | undefined;
  const vectorStore = mem0.vector_store as { provider?: string; config?: Record<string, unknown> } | undefined;

  const dbPath = (vectorStore?.config?.db_path as string) ??
    (vectorStore?.config?.path ? join(String(vectorStore.config.path), 'memory.db') : undefined) ??
    join(DATA_DIR, 'memory.db');

  const dimensions = (vectorStore?.config?.embedding_model_dims as number) ??
    (vectorStore?.config?.dimensions as number) ??
    1536;

  return {
    llm: llm ? {
      provider: llm.provider ?? 'openai',
      config: {
        model: llm.config?.model as string,
        apiKey: (llm.config?.api_key ?? llm.config?.apiKey) as string,
        baseUrl: (llm.config?.base_url ?? llm.config?.baseUrl) as string,
        temperature: llm.config?.temperature as number,
        maxTokens: (llm.config?.max_tokens ?? llm.config?.maxTokens) as number,
      },
    } : undefined,
    embedder: embedder ? {
      provider: embedder.provider ?? 'openai',
      config: {
        model: embedder.config?.model as string,
        apiKey: (embedder.config?.api_key ?? embedder.config?.apiKey) as string,
        baseUrl: (embedder.config?.base_url ?? embedder.config?.baseUrl) as string,
        dimensions,
      },
    } : undefined,
    vectorStore: {
      provider: 'sqlite-vec',
      config: {
        dbPath,
        collectionName: (vectorStore?.config?.collection_name as string) ?? 'memory',
        dimensions,
      },
    },
    historyDbPath: (mem0.history_db_path as string) ?? null,
    customPrompt: ((raw.memory as Record<string, unknown>)?.custom_instructions as string) || undefined,
  };
}

async function getMemory(): Promise<Memory> {
  if (_memory) return _memory;
  const rawConfig = resolveEnvKeys(loadConfig());
  const memConfig = configToMemoryConfig(rawConfig);
  _memory = new Memory(memConfig);
  await _memory.initialize();
  return _memory;
}

async function resetMemory(): Promise<void> {
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

  // Strip unknown top-level keys
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

  return config.mem0 ? { mem0: mem0Cfg } : mem0Cfg;
}

function redactApiKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redactApiKeys);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === 'api_key' && typeof value === 'string' && !value.startsWith('env:')) {
        result[key] = '***REDACTED***';
      } else {
        result[key] = redactApiKeys(value);
      }
    }
    return result;
  }
  return obj;
}

// ── Route handler ─────────────────────────────────────────────────────

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    // Health
    if (path === '/health' && method === 'GET') {
      return json({ status: 'ok' });
    }

    // POST /api/v1/memories/
    if (path === '/api/v1/memories/' && method === 'POST') {
      const body = await readBody(req);
      const m = await getMemory();
      const result = await m.add(body.text as string, {
        userId: (body.user_id as string) ?? 'default_user',
        agentId: body.agent_id as string,
        runId: body.run_id as string,
        metadata: body.metadata as Record<string, unknown>,
        infer: body.infer !== false,
      });
      return json(result);
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

    // GET /api/v1/config/
    if (path === '/api/v1/config/' && method === 'GET') {
      if (existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
        return json(redactApiKeys(raw));
      }
      return json({});
    }

    // PUT /api/v1/config/
    if (path === '/api/v1/config/' && method === 'PUT') {
      const body = await readBody(req);
      const validated = validateConfigStructure(body);
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(validated, null, 2) + '\n');
      await resetMemory();
      return json({ status: 'ok' });
    }

    // POST /api/v1/users
    if (path === '/api/v1/users' && method === 'POST') {
      const body = await readBody(req);
      return json({ status: 'ok', user_id: (body.user_id as string) ?? 'default_user' });
    }

    return errorResponse(404, 'Not found');
  } catch (err) {
    console.error('Request error:', err);
    return errorResponse(500, String(err));
  }
}

// ── Start server ──────────────────────────────────────────────────────

console.log(`OpenPalm Memory API starting on port ${PORT}...`);

Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`OpenPalm Memory API running on http://0.0.0.0:${PORT}`);
