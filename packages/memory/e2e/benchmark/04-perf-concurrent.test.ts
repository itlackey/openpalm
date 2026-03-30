/**
 * Benchmark: concurrent add + search operations
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Memory } from '../../src/memory.js';
import { createTestServer } from '../parity/helpers.js';
import {
  MemoryServiceClient,
  timedCall,
  printComparisonTable,
  writeResultsJson,
  type ComparisonResult,
  type LatencyStats,
} from './helpers.js';
import {
  RUN_BENCHMARKS,
  BENCHMARK_PYTHON_URL,
  getTsConfig,
  writeBenchmarkConfigs,
  TS_USER,
  PY_USER,
  BENCHMARK_DIR,
} from './config.js';
import seedData from './fixtures/seed-data.json';

const SKIP = !RUN_BENCHMARKS;
const SKIP_PYTHON = !BENCHMARK_PYTHON_URL;
const CONCURRENCY = 5;

let tsClient: MemoryServiceClient;
let pyClient: MemoryServiceClient | null = null;
let tsServer: ReturnType<typeof createTestServer>;
let tsMemory: Memory;

function statsFromSamples(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const p = (pct: number) => sorted[Math.max(0, Math.ceil(pct * n) - 1)];
  return { min: sorted[0], max: sorted[n - 1], mean, p50: p(0.5), p95: p(0.95), p99: p(0.99), stddev: Math.sqrt(variance), samples };
}

describe('04 — concurrent operations', () => {
  beforeAll(async () => {
    if (SKIP) return;

    writeBenchmarkConfigs();

    const config = getTsConfig();
    tsMemory = new Memory(config);
    tsServer = createTestServer(tsMemory);
    tsClient = new MemoryServiceClient(tsServer.url);

    if (!SKIP_PYTHON) {
      pyClient = new MemoryServiceClient(BENCHMARK_PYTHON_URL);
    }

    // Clean slate
    try { await tsClient.deleteAll(TS_USER); } catch {}
    if (pyClient) {
      try { await pyClient.deleteAll(PY_USER); } catch {}
    }

    // Seed some memories for search tests
    for (let i = 0; i < 20; i++) {
      const mem = seedData.seedMemories[i % seedData.seedMemories.length];
      await tsClient.add(mem, { user_id: TS_USER, infer: false });
      if (pyClient) {
        await pyClient.add(mem, { user_id: PY_USER, infer: false });
      }
    }
  }, 120_000);

  afterAll(() => {
    if (SKIP) return;
    tsServer?.close();
    tsMemory?.close();
  });

  test.skipIf(SKIP)('5 concurrent add(infer=false) — TS', async () => {
    const promises = Array.from({ length: CONCURRENCY }, (_, i) =>
      timedCall(() =>
        tsClient.add(`Concurrent memory #${i}`, { user_id: TS_USER, infer: false }),
      ),
    );
    const results = await Promise.all(promises);
    const samples = results.map((r) => r.ms);
    const stats = statsFromSamples(samples);
    console.log(`  TS concurrent add: p50=${stats.p50.toFixed(1)}ms max=${stats.max.toFixed(1)}ms`);
    expect(samples.length).toBe(CONCURRENCY);
  });

  test.skipIf(SKIP || SKIP_PYTHON)('5 concurrent add(infer=false) — Python', async () => {
    const promises = Array.from({ length: CONCURRENCY }, (_, i) =>
      timedCall(() =>
        pyClient!.add(`Concurrent memory #${i}`, { user_id: PY_USER, infer: false }),
      ),
    );
    const results = await Promise.all(promises);
    const samples = results.map((r) => r.ms);
    const stats = statsFromSamples(samples);
    console.log(`  PY concurrent add: p50=${stats.p50.toFixed(1)}ms max=${stats.max.toFixed(1)}ms`);
    expect(samples.length).toBe(CONCURRENCY);
  });

  test.skipIf(SKIP)('5 concurrent search — TS', async () => {
    const queries = seedData.searchQueries.map((q) => q.query);
    const promises = queries.map((query) =>
      timedCall(() => tsClient.search(query, { user_id: TS_USER, size: 5 })),
    );
    const results = await Promise.all(promises);
    const samples = results.map((r) => r.ms);
    const stats = statsFromSamples(samples);
    console.log(`  TS concurrent search: p50=${stats.p50.toFixed(1)}ms max=${stats.max.toFixed(1)}ms`);
    expect(samples.length).toBe(queries.length);
  });

  test.skipIf(SKIP || SKIP_PYTHON)('5 concurrent search — Python', async () => {
    const queries = seedData.searchQueries.map((q) => q.query);
    const promises = queries.map((query) =>
      timedCall(() => pyClient!.search(query, { user_id: PY_USER, size: 5 })),
    );
    const results = await Promise.all(promises);
    const samples = results.map((r) => r.ms);
    const stats = statsFromSamples(samples);
    console.log(`  PY concurrent search: p50=${stats.p50.toFixed(1)}ms max=${stats.max.toFixed(1)}ms`);
    expect(samples.length).toBe(queries.length);
  });

  test.skipIf(SKIP)('comparison table', async () => {
    // Run a final comparison
    const tsAddSamples: number[] = [];
    const tsSearchSamples: number[] = [];

    const addPromises = Array.from({ length: CONCURRENCY }, (_, i) =>
      timedCall(() => tsClient.add(`Final concurrent #${i}`, { user_id: TS_USER, infer: false })),
    );
    const addResults = await Promise.all(addPromises);
    tsAddSamples.push(...addResults.map((r) => r.ms));

    const queries = seedData.searchQueries.map((q) => q.query);
    const searchPromises = queries.map((q) =>
      timedCall(() => tsClient.search(q, { user_id: TS_USER, size: 5 })),
    );
    const searchResults = await Promise.all(searchPromises);
    tsSearchSamples.push(...searchResults.map((r) => r.ms));

    let pyAddStats: LatencyStats | undefined;
    let pySearchStats: LatencyStats | undefined;

    if (pyClient) {
      const pyAddPromises = Array.from({ length: CONCURRENCY }, (_, i) =>
        timedCall(() => pyClient!.add(`Final concurrent #${i}`, { user_id: PY_USER, infer: false })),
      );
      const pyAddResults = await Promise.all(pyAddPromises);
      pyAddStats = statsFromSamples(pyAddResults.map((r) => r.ms));

      const pySearchPromises = queries.map((q) =>
        timedCall(() => pyClient!.search(q, { user_id: PY_USER, size: 5 })),
      );
      const pySearchResults = await Promise.all(pySearchPromises);
      pySearchStats = statsFromSamples(pySearchResults.map((r) => r.ms));
    }

    const results: ComparisonResult[] = [
      { name: `concurrent add (n=${CONCURRENCY})`, ts: statsFromSamples(tsAddSamples), python: pyAddStats, unit: 'ms' },
      { name: `concurrent search (n=${queries.length})`, ts: statsFromSamples(tsSearchSamples), python: pySearchStats, unit: 'ms' },
    ];
    printComparisonTable(results);
    writeResultsJson(results, `${BENCHMARK_DIR}/04-perf-concurrent.json`);
    expect(tsAddSamples.length).toBe(CONCURRENCY);
  });
});
