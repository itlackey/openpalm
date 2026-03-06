/**
 * Shared memory library for the OpenMemory plugin layer.
 *
 * Centralizes types, constants, and helpers used by memory-context.ts
 * and memory-hygiene.ts.  The tools in opencode/tools/ continue to use
 * memoryFetch from lib.ts (they return raw JSON strings to the agent);
 * this module returns parsed objects and silently returns null on failure.
 */

import { basename } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OPENMEMORY_URL =
  process.env.OPENMEMORY_API_URL || 'http://openmemory:8765';
export const USER_ID =
  process.env.OPENMEMORY_USER_ID || 'default_user';
export const STACK_USER_ID = 'openpalm';
export const GLOBAL_USER_ID = 'global';
export const APP_NAME = 'openpalm-assistant';
export const DEFAULT_AGENT_ID = process.env.OPENMEMORY_AGENT_ID || 'openpalm';
export const DEFAULT_APP_ID = deriveDefaultAppId();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryCategory = "semantic" | "episodic" | "procedural";
export type MemoryScope = 'personal' | 'stack' | 'global';

export interface MemoryIdentity {
  scope?: MemoryScope;
  userId?: string;
  agentId?: string;
  appId?: string;
  runId?: string;
}

export interface MemoryMetadata {
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
}

export interface MemoryItem {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  app_name?: string;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

/**
 * Fetch from the OpenMemory API.  Returns parsed JSON on success or
 * `null` on any error — hooks must never throw.
 */
export async function pluginMemoryFetch(
  path: string,
  options?: RequestInit & { timeoutMs?: number },
): Promise<unknown | null> {
  try {
    const { timeoutMs, ...rest } = options ?? {};
    const res = await fetch(`${OPENMEMORY_URL}${path}`, {
      ...rest,
      headers: { 'content-type': 'application/json', ...rest?.headers },
      signal: rest?.signal ?? AbortSignal.timeout(timeoutMs ?? 5_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Memory operations
// ---------------------------------------------------------------------------

/** Semantic search with optional client-side category filtering. */
export async function searchMemories(
  query: string,
  opts?: {
    size?: number;
    category?: MemoryCategory;
    timeoutMs?: number;
    highSignalOnly?: boolean;
  } & MemoryIdentity,
): Promise<MemoryItem[]> {
  const fetchSize = opts?.category ? (opts.size ?? 10) * 2 : (opts.size ?? 10);
  const identity = resolveMemoryIdentity(opts);
  const commonSearchBody = {
    user_id: identity.userId,
    agent_id: identity.agentId,
    app_id: identity.appId,
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
      filters: {
        ...(opts?.category ? { category: opts.category } : {}),
      },
    }),
  });
  const v2items = readItems(v2data);
  if (v2items) {
    return postFilterMemories(v2items, opts);
  }

  const data = await pluginMemoryFetch('/api/v1/memories/filter', {
    method: 'POST',
    timeoutMs: opts?.timeoutMs,
    body: JSON.stringify(commonSearchBody),
  });
  const items = readItems(data) ?? [];
  return postFilterMemories(items, opts);
}

/** Store a memory with full metadata.  Mem0 deduplicates via infer:true. */
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

/** Quick stats: total memories and app count. */
export async function getMemoryStats(timeoutMs = 3_000): Promise<{
  total_memories: number;
  total_apps: number;
} | null> {
  return getMemoryStatsWithIdentity(timeoutMs);
}

/** Returns true if the OpenMemory service is reachable. */
export async function isMemoryAvailable(
  timeoutMs?: number,
  identity?: MemoryIdentity,
): Promise<boolean> {
  return (
    (await getMemoryStatsWithIdentity(timeoutMs, identity)) !== null
  );
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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format a list of memories for injection into the agent's context. */
export function formatMemoriesForContext(
  memories: MemoryItem[],
  heading?: string,
): string {
  if (memories.length === 0) return "";
  const lines: string[] = [];
  if (heading) lines.push(heading);
  for (const m of memories) {
    const tag = m.metadata?.category ? `[${m.metadata.category}]` : "";
    lines.push(`- ${tag} ${m.content}`);
  }
  return lines.join("\n");
}

function deriveDefaultAppId(): string {
  const envAppId = process.env.OPENMEMORY_APP_ID?.trim();
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

function resolveMemoryIdentity(
  identityInput?: MemoryIdentity,
): {
  userId: string;
  agentId: string;
  appId: string;
  runId?: string;
} {
  return {
    userId: identityInput?.userId ?? resolveScopeUserId(identityInput?.scope),
    agentId: identityInput?.agentId ?? DEFAULT_AGENT_ID,
    appId: identityInput?.appId ?? DEFAULT_APP_ID,
    runId: identityInput?.runId,
  };
}

function postFilterMemories(
  memories: MemoryItem[],
  opts?: {
    size?: number;
    category?: MemoryCategory;
    highSignalOnly?: boolean;
  },
): MemoryItem[] {
  let items = memories;
  if (opts?.category) {
    items = items.filter((m) => m.metadata?.category === opts.category);
  }
  if (opts?.highSignalOnly) {
    items = items.filter((m) => isHighSignalMemory(m.metadata));
  }
  return items.slice(0, opts?.size ?? 10);
}

function isHighSignalMemory(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  if (metadata.pinned === true || metadata.immutable === true) return true;
  if (typeof metadata.confidence === 'number' && metadata.confidence >= 0.85) {
    return true;
  }
  if (
    typeof metadata.feedback_score === 'number' &&
    metadata.feedback_score > 0
  ) {
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
): Promise<{
  total_memories: number;
  total_apps: number;
} | null> {
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
  return items.filter((item): item is MemoryItem => {
    if (!item || typeof item !== 'object') return false;
    const maybeItem = item as Record<string, unknown>;
    return typeof maybeItem.id === 'string' && typeof maybeItem.content === 'string';
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return null;
}
