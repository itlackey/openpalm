/**
 * OpenMemory HTTP API client for memory recall and write-back.
 *
 * Disabled by setting OPENPALM_MEMORY_MODE to anything other than "api".
 */

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
}

export interface AddMemoryParams {
  text: string;
  user_id?: string;
  session_id?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export function loadConfig() {
  return {
    baseUrl: process.env.OPENMEMORY_BASE_URL ?? "http://openmemory:8765",
    apiKey: process.env.OPENMEMORY_API_KEY ?? "",
    mode: process.env.OPENPALM_MEMORY_MODE ?? "api",
    recallLimit: clampInt(process.env.RECALL_LIMIT, 5, 1, 50),
    recallMaxChars: clampInt(process.env.RECALL_MAX_CHARS, 2000, 100, 20000),
    writebackEnabled: envBool(process.env.WRITEBACK_ENABLED, true),
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

const SAVE_KEYWORDS = [
  "remember", "preference", "todo", "important",
  "always ", "never ", "decision", "project state",
];

export function isSaveWorthy(text: string, categories?: string[]): boolean {
  if (categories?.some((c) => ["preference", "fact", "decision", "todo", "project_state"].includes(c))) return true;
  const lower = text.toLowerCase();
  return SAVE_KEYWORDS.some((kw) => lower.includes(kw));
}

export function formatRecallBlock(hits: MemoryHit[], maxChars: number): string {
  if (hits.length === 0) return "";
  let block = "<recalled_memories>\n";
  let chars = block.length;
  for (const hit of hits) {
    const line = `- [${hit.id}] ${hit.text}\n`;
    if (chars + line.length > maxChars) {
      block += "- (additional memories truncated)\n";
      break;
    }
    block += line;
    chars += line.length;
  }
  block += "</recalled_memories>";
  return block;
}

export class OpenMemoryClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.headers = {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
  }

  async queryMemory(params: QueryMemoryParams): Promise<MemoryHit[]> {
    const res = await fetch(`${this.baseUrl}/api/memory/query`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`OpenMemory query failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { results?: MemoryHit[] };
    return Array.isArray(data.results) ? data.results : [];
  }

  async addMemory(params: AddMemoryParams): Promise<{ id?: string }> {
    const res = await fetch(`${this.baseUrl}/api/memory/add`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`OpenMemory add failed: ${res.status} ${res.statusText}`);
    return (await res.json()) as { id?: string };
  }
}
