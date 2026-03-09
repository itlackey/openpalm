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

type ResolvedMemoryIdentity = {
  userId: string;
  agentId: string;
  appId: string;
  runId?: string;
};

type ResolvedRetrievalIdentity = {
  userId: string;
  agentId?: string;
  appId?: string;
  runId?: string;
};

export async function pluginMemoryFetch(
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
  const fetchSize = opts?.category ? (opts.size ?? 10) * 2 : (opts?.size ?? 10);
  const identity = resolveRetrievalIdentity(opts);
  const commonSearchBody = {
    user_id: identity.userId,
    ...(identity.agentId ? { agent_id: identity.agentId } : {}),
    ...(identity.appId ? { app_id: identity.appId } : {}),
    ...(identity.runId ? { run_id: identity.runId } : {}),
    search_query: query,
    page: 1,
    size: fetchSize,
  };

  const v2data = await pluginMemoryFetch('/api/v2/memories/search', {
    method: 'POST',
    timeoutMs: opts?.timeoutMs,
    body: JSON.stringify({
      ...commonSearchBody,
      query,
      filters: opts?.category ? { category: opts.category } : {},
    }),
  });
  const v2items = readItems(v2data);
  if (v2items) {
    return postFilterMemories(v2items, opts);
  }

  const v1data = await pluginMemoryFetch('/api/v1/memories/filter', {
    method: 'POST',
    timeoutMs: opts?.timeoutMs,
    body: JSON.stringify(commonSearchBody),
  });
  const v1items = readItems(v1data) ?? [];
  return postFilterMemories(v1items, opts);
}

export async function listMemories(opts?: ListOptions): Promise<MemoryItem[]> {
  const identity = resolveRetrievalIdentity(opts);
  const data = await pluginMemoryFetch('/api/v1/memories/filter', {
    method: 'POST',
    timeoutMs: opts?.timeoutMs,
    body: JSON.stringify({
      user_id: identity.userId,
      ...(identity.agentId ? { agent_id: identity.agentId } : {}),
      ...(identity.appId ? { app_id: identity.appId } : {}),
      ...(identity.runId ? { run_id: identity.runId } : {}),
      page: opts?.page ?? 1,
      size: opts?.size ?? 50,
      search_query: opts?.search_query ?? null,
      sort_column: opts?.sort_column ?? 'created_at',
      sort_direction: opts?.sort_direction ?? 'desc',
    }),
  });
  return readItems(data) ?? [];
}

export async function addMemory(
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
    method: 'POST',
    timeoutMs: 10_000,
    body: JSON.stringify({
      user_id: identity.userId,
      agent_id: identity.agentId,
      app_id: identity.appId,
      ...(identity.runId ? { run_id: identity.runId } : {}),
      text,
      app: APP_NAME,
      metadata,
      infer: true,
    }),
  });

  const dataRecord = asRecord(data);
  const id = dataRecord?.id;
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

export async function deleteMemories(
  memoryIds: string[],
  identityInput?: MemoryIdentity,
): Promise<boolean> {
  if (memoryIds.length === 0) return true;
  const identity = resolveMemoryIdentity(identityInput);
  const response = await pluginMemoryFetch('/api/v1/memories/', {
    method: 'DELETE',
    timeoutMs: 8_000,
    body: JSON.stringify({ memory_ids: memoryIds, user_id: identity.userId }),
  });
  return response !== null;
}

export async function getMemoryStats(timeoutMs = 3_000): Promise<{
  total_memories: number;
  total_apps: number;
} | null> {
  return getMemoryStatsWithIdentity(timeoutMs);
}

export async function isMemoryAvailable(
  timeoutMs?: number,
  identity?: MemoryIdentity,
): Promise<boolean> {
  return (await getMemoryStatsWithIdentity(timeoutMs, identity)) !== null;
}

export async function sendMemoryFeedback(
  memoryId: string,
  positive: boolean,
  reason?: string,
  identityInput?: MemoryIdentity,
): Promise<boolean> {
  const identity = resolveMemoryIdentity(identityInput);
  const feedback = {
    memory_id: memoryId,
    user_id: identity.userId,
    agent_id: identity.agentId,
    app_id: identity.appId,
    ...(identity.runId ? { run_id: identity.runId } : {}),
    value: positive ? 1 : -1,
    reason,
  };

  const endpoints = [
    `/api/v1/memories/${encodeURIComponent(memoryId)}/feedback`,
    '/api/v1/feedback',
    '/api/v2/feedback',
  ];
  for (const endpoint of endpoints) {
    const result = await pluginMemoryFetch(endpoint, {
      method: 'POST',
      timeoutMs: 3_000,
      body: JSON.stringify(feedback),
    });
    if (result) return true;
  }
  return false;
}

export async function createMemoryExport(
  identityInput?: MemoryIdentity,
): Promise<Record<string, unknown> | null> {
  const identity = resolveMemoryIdentity(identityInput);
  const payload = {
    user_id: identity.userId,
    agent_id: identity.agentId,
    app_id: identity.appId,
    ...(identity.runId ? { run_id: identity.runId } : {}),
  };
  const endpoints = ['/api/v1/exports', '/api/v2/exports'];
  for (const endpoint of endpoints) {
    const result = await pluginMemoryFetch(endpoint, {
      method: 'POST',
      timeoutMs: 10_000,
      body: JSON.stringify(payload),
    });
    const resultRecord = asRecord(result);
    if (resultRecord) return resultRecord;
  }
  return null;
}

export async function getMemoryExport(
  exportId: string,
  identityInput?: MemoryIdentity,
): Promise<Record<string, unknown> | null> {
  const identity = resolveMemoryIdentity(identityInput);
  const endpoints = ['/api/v1/exports', '/api/v2/exports'];
  for (const endpoint of endpoints) {
    const result = await pluginMemoryFetch(
      `${endpoint}/${encodeURIComponent(exportId)}?user_id=${encodeURIComponent(identity.userId)}`,
      { timeoutMs: 5_000 },
    );
    const resultRecord = asRecord(result);
    if (resultRecord) return resultRecord;
  }
  return null;
}

export async function getMemoryEvent(
  eventId: string,
): Promise<Record<string, unknown> | null> {
  const endpoints = ['/api/v1/events', '/api/v2/events'];
  for (const endpoint of endpoints) {
    const result = await pluginMemoryFetch(
      `${endpoint}/${encodeURIComponent(eventId)}`,
      { timeoutMs: 5_000 },
    );
    const resultRecord = asRecord(result);
    if (resultRecord) return resultRecord;
  }
  return null;
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

export function resolveMemoryIdentity(identityInput?: MemoryIdentity): ResolvedMemoryIdentity {
  return {
    userId: identityInput?.userId ?? resolveScopeUserId(identityInput?.scope),
    agentId: identityInput?.agentId ?? DEFAULT_AGENT_ID,
    appId: identityInput?.appId ?? DEFAULT_APP_ID,
    runId: identityInput?.runId,
  };
}

function resolveRetrievalIdentity(identityInput?: MemoryIdentity): ResolvedRetrievalIdentity {
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
  let items = memories;
  if (opts?.category) {
    items = items.filter((memory) => memory.metadata?.category === opts.category);
  }
  if (opts?.highSignalOnly) {
    items = items.filter((memory) => isHighSignalMemory(memory.metadata));
  }
  return items.slice(0, opts?.size ?? 10);
}

function isHighSignalMemory(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  if (metadata.pinned === true || metadata.immutable === true) return true;
  if (typeof metadata.confidence === 'number' && metadata.confidence >= 0.85) {
    return true;
  }
  if (typeof metadata.feedback_score === 'number' && metadata.feedback_score > 0) {
    return true;
  }
  if (
    typeof metadata.positive_feedback_count === 'number' &&
    typeof metadata.negative_feedback_count === 'number'
  ) {
    return metadata.positive_feedback_count > metadata.negative_feedback_count;
  }
  return false;
}

async function getMemoryStatsWithIdentity(
  timeoutMs = 3_000,
  identityInput?: MemoryIdentity,
): Promise<{ total_memories: number; total_apps: number } | null> {
  const identity = resolveMemoryIdentity(identityInput);
  const stats = await pluginMemoryFetch(
    `/api/v1/stats/?user_id=${encodeURIComponent(identity.userId)}`,
    { timeoutMs },
  );
  const statsRecord = asRecord(stats);
  if (
    statsRecord &&
    typeof statsRecord.total_memories === 'number' &&
    typeof statsRecord.total_apps === 'number'
  ) {
    return {
      total_memories: statsRecord.total_memories,
      total_apps: statsRecord.total_apps,
    };
  }
  return null;
}

function readItems(data: unknown): MemoryItem[] | undefined {
  const record = asRecord(data);
  if (!record) return undefined;
  const items = record.items ?? record.results;
  if (!Array.isArray(items)) return undefined;
  return items.flatMap((item) => toMemoryItem(item));
}

function toMemoryItem(item: unknown): MemoryItem[] {
  if (!item || typeof item !== 'object') return [];
  const maybeItem = item as Record<string, unknown>;
  const id = maybeItem.id;
  const content = maybeItem.content ?? maybeItem.memory;
  if (typeof id !== 'string' || typeof content !== 'string') return [];
  const metadata = asRecord(maybeItem.metadata) ?? undefined;
  const createdAt = typeof maybeItem.created_at === 'string' ? maybeItem.created_at : undefined;
  const appName = typeof maybeItem.app_name === 'string' ? maybeItem.app_name : undefined;
  return [{ id, content, metadata, created_at: createdAt, app_name: appName }];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return null;
}
