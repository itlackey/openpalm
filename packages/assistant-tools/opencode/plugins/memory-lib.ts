/**
 * Shared memory library for the OpenMemory plugin layer.
 *
 * Centralizes types, constants, and helpers used by memory-context.ts
 * and memory-hygiene.ts.  The tools in opencode/tools/ continue to use
 * memoryFetch from lib.ts (they return raw JSON strings to the agent);
 * this module returns parsed objects and silently returns null on failure.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OPENMEMORY_URL =
  process.env.OPENMEMORY_API_URL || "http://openmemory:8765";
export const USER_ID =
  process.env.OPENMEMORY_USER_ID || "default_user";
export const APP_NAME = "openpalm-assistant";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryCategory = "semantic" | "episodic" | "procedural";

export interface MemoryMetadata {
  category: MemoryCategory;
  source: "auto-extract" | "manual" | "reflexion" | "consolidation";
  confidence?: number;
  access_count?: number;
  last_accessed?: string;
  session_id?: string;
  project?: string;
  task_type?: string;
  created_by_hook?: string;
}

export interface MemoryItem {
  id: string;
  content: string;
  metadata?: Record<string, any>;
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
): Promise<any | null> {
  try {
    const { timeoutMs, ...rest } = options ?? {};
    const res = await fetch(`${OPENMEMORY_URL}${path}`, {
      ...rest,
      headers: { "content-type": "application/json", ...rest?.headers },
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
  opts?: { size?: number; category?: MemoryCategory; timeoutMs?: number },
): Promise<MemoryItem[]> {
  const fetchSize = opts?.category ? (opts.size ?? 10) * 2 : (opts.size ?? 10);
  const data = await pluginMemoryFetch("/api/v1/memories/filter", {
    method: "POST",
    timeoutMs: opts?.timeoutMs,
    body: JSON.stringify({
      user_id: USER_ID,
      search_query: query,
      page: 1,
      size: fetchSize,
    }),
  });
  let items: MemoryItem[] = data?.items ?? [];
  if (opts?.category) {
    items = items.filter(
      (m) => m.metadata?.category === opts.category,
    );
  }
  return items.slice(0, opts?.size ?? 10);
}

/** Store a memory with full metadata.  Mem0 deduplicates via infer:true. */
export async function addMemory(
  text: string,
  meta?: Partial<MemoryMetadata>,
): Promise<string | null> {
  const metadata: MemoryMetadata = {
    category: meta?.category ?? "semantic",
    source: meta?.source ?? "auto-extract",
    confidence: meta?.confidence ?? 0.7,
    access_count: 0,
    last_accessed: new Date().toISOString(),
    ...meta,
  };
  const data = await pluginMemoryFetch("/api/v1/memories/", {
    method: "POST",
    timeoutMs: 10_000,
    body: JSON.stringify({
      user_id: USER_ID,
      text,
      app: APP_NAME,
      metadata,
      infer: true,
    }),
  });
  return data?.id ?? null;
}

/** Quick stats: total memories and app count. */
export async function getMemoryStats(timeoutMs = 3_000): Promise<{
  total_memories: number;
  total_apps: number;
} | null> {
  return pluginMemoryFetch(
    `/api/v1/stats/?user_id=${encodeURIComponent(USER_ID)}`,
    { timeoutMs },
  );
}

/** Returns true if the OpenMemory service is reachable. */
export async function isMemoryAvailable(timeoutMs?: number): Promise<boolean> {
  return (await getMemoryStats(timeoutMs)) !== null;
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
