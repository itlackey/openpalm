/**
 * Benchmark: search() latency at various corpus sizes
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Memory } from '../src/memory.js';
import { createTestServer } from '../parity-tests/helpers.js';
import {
  MemoryServiceClient,
  runN,
  printComparisonTable,
  writeResultsJson,
  type ComparisonResult,
  type LatencyStats,
} from './helpers.js';
import {
  RUN_BENCHMARKS,
  BENCHMARK_PYTHON_URL,
  BENCHMARK_RUNS,
  getTsConfig,
  writeBenchmarkConfigs,
  TS_USER,
  PY_USER,
  BENCHMARK_DIR,
} from './config.js';
import seedData from './fixtures/seed-data.json';

const SKIP = !RUN_BENCHMARKS;
const SKIP_PYTHON = !BENCHMARK_PYTHON_URL;

let tsClient: MemoryServiceClient;
let pyClient: MemoryServiceClient | null = null;
let tsServer: ReturnType<typeof createTestServer>;
let tsMemory: Memory;

describe('02 — search() latency', () => {
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
  });

  afterAll(() => {
    if (SKIP) return;
    tsServer?.close();
    tsMemory?.close();
  });

  test.skipIf(SKIP)('seed corpus (50 memories) — TS', async () => {
    for (const memory of seedData.seedMemories) {
      await tsClient.add(memory, { user_id: TS_USER, infer: false });
    }
    const stats = await tsClient.stats(TS_USER);
    console.log(`  TS corpus size: ${stats.total_memories}`);
    expect(stats.total_memories).toBe(seedData.seedMemories.length);
  }, 120_000);

  test.skipIf(SKIP || SKIP_PYTHON)('seed corpus (50 memories) — Python', async () => {
    for (const memory of seedData.seedMemories) {
      await pyClient!.add(memory, { user_id: PY_USER, infer: false });
    }
    const stats = await pyClient!.stats(PY_USER);
    console.log(`  PY corpus size: ${stats.total_memories}`);
    expect(stats.total_memories).toBe(seedData.seedMemories.length);
  }, 120_000);

  test.skipIf(SKIP)('search at corpus=50 — TS', async () => {
    const queries = seedData.searchQueries.map((q) => q.query);
    const stats = await runN(BENCHMARK_RUNS, async () => {
      const query = queries[Math.floor(Math.random() * queries.length)];
      await tsClient.search(query, { user_id: TS_USER, size: 5 });
    });
    console.log(`  TS search: p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP || SKIP_PYTHON)('search at corpus=50 — Python', async () => {
    const queries = seedData.searchQueries.map((q) => q.query);
    const stats = await runN(BENCHMARK_RUNS, async () => {
      const query = queries[Math.floor(Math.random() * queries.length)];
      await pyClient!.search(query, { user_id: PY_USER, size: 5 });
    });
    console.log(`  PY search: p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP)('search with userId filter — TS', async () => {
    const stats = await runN(BENCHMARK_RUNS, async () => {
      await tsClient.search('What does the user like?', { user_id: TS_USER, size: 5 });
    });
    console.log(`  TS filtered search: p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP)('comparison table', async () => {
    const tsSearchStats = await runN(BENCHMARK_RUNS, () =>
      tsClient.search('programming languages and preferences', { user_id: TS_USER, size: 5 }),
    );

    let pySearchStats: LatencyStats | undefined;
    if (pyClient) {
      pySearchStats = await runN(BENCHMARK_RUNS, () =>
        pyClient!.search('programming languages and preferences', { user_id: PY_USER, size: 5 }),
      );
    }

    const results: ComparisonResult[] = [
      { name: 'search(corpus=50, top=5)', ts: tsSearchStats, python: pySearchStats, unit: 'ms' },
    ];
    printComparisonTable(results);
    writeResultsJson(results, `${BENCHMARK_DIR}/02-perf-search.json`);
    expect(tsSearchStats.p50).toBeGreaterThan(0);
  });
});
