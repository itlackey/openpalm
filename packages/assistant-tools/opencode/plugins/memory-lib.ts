import { basename } from 'node:path';

export const MEMORY_URL = process.env.MEMORY_API_URL || 'http://memory:8765';
export const USER_ID = process.env.MEMORY_USER_ID || 'default_user';
export const STACK_USER_ID = 'openpalm';
export const GLOBAL_USER_ID = 'global';
export const APP_NAME = 'openpalm-assistant';
export const DEFAULT_AGENT_ID = process.env.MEMORY_AGENT_ID || 'openpalm';
export const DEFAULT_APP_ID = deriveDefaultAppId();

export type MemoryCategory = 'semantic' | 'episodic' | 'procedural';
export type MemoryScope = 'personal' | 'stack' | 'global';

export type MemoryIdentity = {
  scope?: MemoryScope;
  userId?: string;
  agentId?: string;
  appId?: string;
  runId?: string;
};

export type MemoryMetadata = {
  category: MemoryCategory;
  source: 'auto-extract' | 'manual' | 'reflexion' | 'consolidation';
  confidence?: number;
  access_count?: number;
  last_accessed?: string;
  session_id?: string;
  project?: string;
  task_type?: string;
  created_by_hook?: string;
  scope?: MemoryScope;
  keywords?: string[];
  expiration_days?: number | null;
  feedback_score?: number;
  positive_feedback_count?: number;
  negative_feedback_count?: number;
  pinned?: boolean;
  immutable?: boolean;
  [key: string]: unknown;
};

export type MemoryItem = {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  app_name?: string;
};

type SearchOptions = {
  size?: number;
  category?: MemoryCategory;
  timeoutMs?: number;
  highSignalOnly?: boolean;
} & MemoryIdentity;

type ListOptions = {
  page?: number;
  size?: number;
  search_query?: string;
  sort_column?: 'created_at' | 'memory' | 'app_name';
  sort_direction?: 'asc' | 'desc';
  timeoutMs?: number;
} & MemoryIdentity;

type ResolvedIdentity = {
  userId: string;
  agentId?: string;
  appId?: string;
  runId?: string;
};

function identityBody(id: ResolvedIdentity): Record<string, string> {
  const body: Record<string, string> = { user_id: id.userId };
  if (id.agentId) body.agent_id = id.agentId;
  if (id.appId) body.app_id = id.appId;
  if (id.runId) body.run_id = id.runId;
  return body;
}

async function pluginMemoryFetch(
  path: string,
  options?: RequestInit & { timeoutMs?: number },
): Promise<unknown | null> {
  try {
    const { timeoutMs, ...rest } = options ?? {};
    const res = await fetch(`${MEMORY_URL}${path}`, {
      ...rest,
      headers: { 'content-type': 'application/json', ...rest.headers },
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs ?? 5_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function searchMemories(
  query: string,
  opts?: SearchOptions,
): Promise<MemoryItem[]> {
  const size = opts?.category ? (opts.size ?? 10) * 2 : (opts?.size ?? 10);
  const base = { ...identityBody(resolveRetrievalIdentity(opts)), search_query: query, page: 1, size };

  const v2data = await pluginMemoryFetch('/api/v2/memories/search', {
    method: 'POST', timeoutMs: opts?.timeoutMs,
    body: JSON.stringify({ ...base, query, filters: opts?.category ? { category: opts.category } : {} }),
  });
  const v2items = readItems(v2data);
  if (v2items) return postFilterMemories(v2items, opts);

  const v1items = readItems(await pluginMemoryFetch('/api/v1/memories/filter', {
    method: 'POST', timeoutMs: opts?.timeoutMs, body: JSON.stringify(base),
  })) ?? [];
  return postFilterMemories(v1items, opts);
}

export async function listMemories(opts?: ListOptions): Promise<MemoryItem[]> {
  const data = await pluginMemoryFetch('/api/v1/memories/filter', {
    method: 'POST', timeoutMs: opts?.timeoutMs,
    body: JSON.stringify({
      ...identityBody(resolveRetrievalIdentity(opts)),
      page: opts?.page ?? 1, size: opts?.size ?? 50,
      search_query: opts?.search_query ?? null,
      sort_column: opts?.sort_column ?? 'created_at',
      sort_direction: opts?.sort_direction ?? 'desc',
    }),
  });
  return readItems(data) ?? [];
}

async function addMemory(
  text: string,
  meta?: Partial<MemoryMetadata>,
  identityInput?: MemoryIdentity,
): Promise<string | null> {
  const identity = resolveMemoryIdentity(identityInput);
  const metadata: MemoryMetadata = {
    category: meta?.category ?? 'semantic',
    source: meta?.source ?? 'auto-extract',
    confidence: meta?.confidence ?? 0.7,
    access_count: 0,
    last_accessed: new Date().toISOString(),
    ...meta,
    scope: identityInput?.scope ?? meta?.scope ?? 'personal',
  };

  const data = await pluginMemoryFetch('/api/v1/memories/', {
    method: 'POST', timeoutMs: 10_000,
    body: JSON.stringify({ ...identityBody(identity), text, app: APP_NAME, metadata, infer: true }),
  });
  const id = asRecord(data)?.id;
  return typeof id === 'string' ? id : null;
}

export async function addMemoryIfNovel(
  text: string,
  meta?: Partial<MemoryMetadata>,
  identityInput?: MemoryIdentity,
): Promise<string | null> {
  const normalized = normalizeMemoryText(text);
  if (!normalized) return null;

  const possibleDuplicates = await searchMemories(text, {
    size: 6,
    category: meta?.category,
    timeoutMs: 1_800,
    ...identityInput,
  });
  const hasDuplicate = possibleDuplicates.some((item) => {
    return normalizeMemoryText(item.content) === normalized;
  });
  if (hasDuplicate) return null;

  return addMemory(text, meta, identityInput);
}

export async function deleteMemories(memoryIds: string[], identityInput?: MemoryIdentity): Promise<boolean> {
  if (memoryIds.length === 0) return true;
  return (await pluginMemoryFetch('/api/v1/memories/', {
    method: 'DELETE', timeoutMs: 8_000,
    body: JSON.stringify({ memory_ids: memoryIds, user_id: resolveMemoryIdentity(identityInput).userId }),
  })) !== null;
}

export async function isMemoryAvailable(
  timeoutMs?: number,
  identityInput?: MemoryIdentity,
): Promise<boolean> {
  const identity = resolveMemoryIdentity(identityInput);
  const stats = await pluginMemoryFetch(
    `/api/v1/stats/?user_id=${encodeURIComponent(identity.userId)}`,
    { timeoutMs: timeoutMs ?? 3_000 },
  );
  const s = asRecord(stats);
  return s !== null && typeof s.total_memories === 'number' && typeof s.total_apps === 'number';
}

export async function sendMemoryFeedback(
  memoryId: string,
  positive: boolean,
  reason?: string,
  identityInput?: MemoryIdentity,
): Promise<boolean> {
  const identity = resolveMemoryIdentity(identityInput);
  const body = JSON.stringify({
    memory_id: memoryId, user_id: identity.userId, agent_id: identity.agentId,
    app_id: identity.appId, ...(identity.runId ? { run_id: identity.runId } : {}),
    value: positive ? 1 : -1, reason,
  });
  const opts = { method: 'POST', timeoutMs: 3_000, body } as const;

  return (await pluginMemoryFetch(`/api/v1/memories/${encodeURIComponent(memoryId)}/feedback`, opts)) !== null
    || (await pluginMemoryFetch('/api/v1/feedback', opts)) !== null
    || (await pluginMemoryFetch('/api/v2/feedback', opts)) !== null;
}

export function formatMemoriesForContext(memories: MemoryItem[], heading?: string): string {
  if (memories.length === 0) return '';
  const lines: string[] = [];
  if (heading) lines.push(heading);
  for (const memory of memories) {
    const tag = typeof memory.metadata?.category === 'string'
      ? `[${memory.metadata.category}]`
      : '';
    lines.push(`- ${tag} ${memory.content}`.trim());
  }
  return lines.join('\n');
}

export function normalizeMemoryText(content: string): string {
  return content
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .slice(0, 220);
}

function resolveMemoryIdentity(identityInput?: MemoryIdentity): ResolvedIdentity {
  return {
    userId: identityInput?.userId ?? resolveScopeUserId(identityInput?.scope),
    agentId: identityInput?.agentId ?? DEFAULT_AGENT_ID,
    appId: identityInput?.appId ?? DEFAULT_APP_ID,
    runId: identityInput?.runId,
  };
}

function resolveRetrievalIdentity(identityInput?: MemoryIdentity): ResolvedIdentity {
  return {
    userId: identityInput?.userId ?? resolveScopeUserId(identityInput?.scope),
    agentId: identityInput?.agentId?.trim() || undefined,
    appId: identityInput?.appId?.trim() || undefined,
    runId: identityInput?.runId?.trim() || undefined,
  };
}

function deriveDefaultAppId(): string {
  const envAppId = process.env.MEMORY_APP_ID?.trim();
  if (envAppId) return envAppId;
  const cwd = process.cwd().trim();
  if (!cwd) return 'openpalm';
  const name = basename(cwd);
  if (!name || name === '.' || name === '/') return 'openpalm';
  return name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
}

function resolveScopeUserId(scope: MemoryScope = 'personal'): string {
  if (scope === 'stack') return STACK_USER_ID;
  if (scope === 'global') return GLOBAL_USER_ID;
  return USER_ID;
}

function postFilterMemories(memories: MemoryItem[], opts?: SearchOptions): MemoryItem[] {
  return memories
    .filter((item) => (!opts?.category || item.metadata?.category === opts.category)
      && (!opts?.highSignalOnly || isHighSignal(item.metadata)))
    .slice(0, opts?.size ?? 10);
}

function isHighSignal(m: Record<string, unknown> | undefined): boolean {
  if (!m) return false;
  return !!(m.pinned || m.immutable
    || (typeof m.confidence === 'number' && m.confidence >= 0.85)
    || (typeof m.feedback_score === 'number' && m.feedback_score > 0)
    || (typeof m.positive_feedback_count === 'number' && typeof m.negative_feedback_count === 'number'
      && (m.positive_feedback_count as number) > (m.negative_feedback_count as number)));
}


function readItems(data: unknown): MemoryItem[] | undefined {
  const r = asRecord(data);
  if (!r) return undefined;
  const items = r.items ?? r.results;
  if (!Array.isArray(items)) return undefined;
  return items.reduce<MemoryItem[]>((acc, raw) => {
    const m = raw as Record<string, unknown>;
    const id = m?.id, content = m?.content ?? m?.memory;
    if (typeof id === 'string' && typeof content === 'string') {
      acc.push({ id, content, metadata: asRecord(m.metadata) ?? undefined,
        created_at: typeof m.created_at === 'string' ? m.created_at : undefined,
        app_name: typeof m.app_name === 'string' ? m.app_name : undefined });
    }
    return acc;
  }, []);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return null;
}
