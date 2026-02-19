/**
 * OpenMemory HTTP API client.
 *
 * Provides deterministic access to OpenMemory's REST endpoints for
 * memory recall, write-back and (optional) temporal knowledge-graph
 * operations — without requiring MCP in the runtime path.
 *
 * Configuration is driven entirely by environment variables so the
 * plugin works out of the box inside the Docker Compose stack and can
 * be disabled by setting OPENPALM_MEMORY_MODE to anything other than "api".
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryHit {
  id: string;
  text: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface QueryMemoryParams {
  query: string;
  user_id?: string;
  session_id?: string;
  tags?: string[];
  limit?: number;
  start_time?: string;
  end_time?: string;
}

export interface AddMemoryParams {
  text: string;
  user_id?: string;
  session_id?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface TemporalFactParams {
  fact: string;
  valid_from?: string;
  valid_to?: string;
  user_id?: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function loadConfig() {
  return {
    baseUrl: process.env.OPENMEMORY_BASE_URL ?? "http://openmemory:8765",
    apiKey: process.env.OPENMEMORY_API_KEY ?? "",
    mode: process.env.OPENPALM_MEMORY_MODE ?? "api",
    recallLimit: clampInt(process.env.RECALL_LIMIT, 5, 1, 50),
    recallMaxChars: clampInt(process.env.RECALL_MAX_CHARS, 2000, 100, 20000),
    writebackEnabled: envBool(process.env.WRITEBACK_ENABLED, true),
    temporalEnabled: envBool(process.env.TEMPORAL_ENABLED, false),
  };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

// ---------------------------------------------------------------------------
// Secret detection (reuses the same heuristics as policy-and-telemetry)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /password/i,
  /private[_-]?key/i,
  /secret/i,
  /-----BEGIN\s/i,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i,
  /ghp_[A-Za-z0-9]{36}/i,
  /sk-[A-Za-z0-9]{20,}/i,
];

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Write-back classifier — decides what is "save-worthy"
// ---------------------------------------------------------------------------

const SAVE_CATEGORIES = new Set([
  "preference",
  "fact",
  "decision",
  "todo",
  "project_state",
]);

/**
 * Returns true when the text looks like it should be persisted to long-term
 * memory (preference, fact, decision, TODO, project state).
 *
 * The classifier is intentionally simple and deterministic — it checks for
 * explicit keyword signals rather than running an LLM.
 */
export function isSaveWorthy(text: string, categories?: string[]): boolean {
  if (categories?.some((c) => SAVE_CATEGORIES.has(c))) return true;

  const lower = text.toLowerCase();
  if (lower.includes("remember")) return true;
  if (lower.includes("preference")) return true;
  if (lower.includes("todo")) return true;
  if (lower.includes("important")) return true;
  if (lower.includes("always ")) return true;
  if (lower.includes("never ")) return true;
  if (lower.includes("decision")) return true;
  if (lower.includes("project state")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export class OpenMemoryClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(baseUrl: string, apiKey?: string) {
    // Strip trailing slash for consistency
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.headers = {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
  }

  async queryMemory(params: QueryMemoryParams): Promise<MemoryHit[]> {
    const url = `${this.baseUrl}/api/memory/query`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      throw new Error(`OpenMemory query failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { results?: MemoryHit[] };
    return Array.isArray(data.results) ? data.results : [];
  }

  async addMemory(params: AddMemoryParams): Promise<{ id?: string }> {
    const url = `${this.baseUrl}/api/memory/add`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      throw new Error(`OpenMemory add failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as { id?: string };
  }

  async addTemporalFact(params: TemporalFactParams): Promise<{ id?: string }> {
    const url = `${this.baseUrl}/api/temporal/fact`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      throw new Error(`OpenMemory temporal fact failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as { id?: string };
  }
}
