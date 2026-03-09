/**
 * Benchmark helpers — HTTP client, timing, stats, comparison utilities.
 */

// ── Types ─────────────────────────────────────────────────────────────

export type AddResponse = {
  results?: Array<{ id?: string; event?: string; memory?: string; text?: string }>;
  id?: string | null;
};

export type SearchResponse = {
  items?: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>;
  results?: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>;
};

export type GetResponse = {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

export type UpdateResponse = Record<string, unknown>;
export type DeleteResponse = Record<string, unknown>;

export type StatsResponse = {
  total_memories: number;
  total_apps: number;
  approximate?: boolean;
};

export type LatencyStats = {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  stddev: number;
  samples: number[];
};

export type ComparisonResult = {
  name: string;
  ts?: LatencyStats;
  python?: LatencyStats;
  unit: string;
};

// ── Memory Service Client ─────────────────────────────────────────────

export class MemoryServiceClient {
  constructor(private baseUrl: string) {}

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async add(
    text: string,
    opts: { user_id?: string; infer?: boolean; metadata?: Record<string, unknown> } = {},
  ): Promise<AddResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/memories/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        user_id: opts.user_id ?? 'default_user',
        infer: opts.infer ?? true,
        metadata: opts.metadata,
      }),
    });
    if (!res.ok) throw new Error(`add failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async search(
    query: string,
    opts: { user_id?: string; size?: number } = {},
  ): Promise<SearchResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/memories/filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        search_query: query,
        user_id: opts.user_id ?? 'default_user',
        size: opts.size ?? 10,
      }),
    });
    if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async get(id: string): Promise<GetResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/memories/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`get failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async update(id: string, data: string): Promise<UpdateResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/memories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    if (!res.ok) throw new Error(`update failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async delete(opts: { memory_id?: string; user_id?: string }): Promise<DeleteResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/memories/`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw new Error(`delete failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async deleteAll(userId: string): Promise<void> {
    await this.delete({ user_id: userId });
  }

  async getAll(
    userId: string,
    opts: { size?: number } = {},
  ): Promise<SearchResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/memories/filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        size: opts.size ?? 100,
      }),
    });
    if (!res.ok) throw new Error(`getAll failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async stats(userId: string): Promise<StatsResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/stats/?user_id=${encodeURIComponent(userId)}`,
    );
    if (!res.ok) throw new Error(`stats failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
}

// ── Timing Utilities ──────────────────────────────────────────────────

export async function timedCall<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { result, ms };
}

export async function runN(
  n: number,
  fn: () => Promise<unknown>,
): Promise<LatencyStats> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return computeStats(samples);
}

function computeStats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    stddev: Math.sqrt(variance),
    samples,
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Comparison Reporting ──────────────────────────────────────────────

export function printComparisonTable(results: ComparisonResult[]): void {
  const header = `| ${'Benchmark'.padEnd(35)} | ${'TS p50'.padStart(10)} | ${'TS p95'.padStart(10)} | ${'PY p50'.padStart(10)} | ${'PY p95'.padStart(10)} | ${'Ratio'.padStart(8)} |`;
  const separator = `|${'-'.repeat(37)}|${'-'.repeat(12)}|${'-'.repeat(12)}|${'-'.repeat(12)}|${'-'.repeat(12)}|${'-'.repeat(10)}|`;

  console.log('\n' + separator);
  console.log(header);
  console.log(separator);

  for (const r of results) {
    const tsP50 = r.ts ? `${r.ts.p50.toFixed(1)}${r.unit}` : 'N/A';
    const tsP95 = r.ts ? `${r.ts.p95.toFixed(1)}${r.unit}` : 'N/A';
    const pyP50 = r.python ? `${r.python.p50.toFixed(1)}${r.unit}` : 'N/A';
    const pyP95 = r.python ? `${r.python.p95.toFixed(1)}${r.unit}` : 'N/A';
    const ratio =
      r.ts && r.python ? `${(r.ts.p50 / r.python.p50).toFixed(2)}x` : 'N/A';

    console.log(
      `| ${r.name.padEnd(35)} | ${tsP50.padStart(10)} | ${tsP95.padStart(10)} | ${pyP50.padStart(10)} | ${pyP95.padStart(10)} | ${ratio.padStart(8)} |`,
    );
  }
  console.log(separator + '\n');
}

export function writeResultsJson(results: ComparisonResult[], path: string): void {
  const { mkdirSync, writeFileSync } = require('node:fs');
  const { dirname } = require('node:path');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(results, null, 2) + '\n');
}

// ── Similarity Metrics ────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export function jaccard(setA: string[], setB: string[]): number {
  const a = new Set(setA.map((s) => s.toLowerCase().trim()));
  const b = new Set(setB.map((s) => s.toLowerCase().trim()));
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 1 : intersection.size / union.size;
}

/**
 * Fuzzy set overlap — for each item in setA, check if any item in setB
 * contains it as a substring (or vice versa). Returns fraction of matches.
 */
export function fuzzyOverlap(setA: string[], setB: string[]): number {
  if (setA.length === 0 && setB.length === 0) return 1;
  if (setA.length === 0 || setB.length === 0) return 0;

  let matches = 0;
  const bLower = setB.map((s) => s.toLowerCase().trim());

  for (const a of setA) {
    const aLower = a.toLowerCase().trim();
    const found = bLower.some(
      (b) => b.includes(aLower) || aLower.includes(b),
    );
    if (found) matches++;
  }
  return matches / Math.max(setA.length, setB.length);
}

/**
 * Spearman rank correlation coefficient for two ranked lists.
 * Items are matched by ID; unmatched items are assigned worst rank.
 */
export function spearmanRank(
  listA: { id: string }[],
  listB: { id: string }[],
): number {
  const allIds = new Set([...listA.map((x) => x.id), ...listB.map((x) => x.id)]);
  const n = allIds.size;
  if (n <= 1) return 1;

  const rankA = new Map(listA.map((x, i) => [x.id, i + 1]));
  const rankB = new Map(listB.map((x, i) => [x.id, i + 1]));

  let sumD2 = 0;
  for (const id of allIds) {
    const ra = rankA.get(id) ?? n;
    const rb = rankB.get(id) ?? n;
    sumD2 += (ra - rb) ** 2;
  }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

// ── Service Readiness ─────────────────────────────────────────────────

export async function waitForService(
  url: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Service at ${url} not ready after ${timeoutMs}ms`);
}
