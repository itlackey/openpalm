/**
 * Benchmark: add() latency — infer=true and infer=false
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
  RESULTS_PATH,
} from './config.js';

const SKIP = !RUN_BENCHMARKS;
const SKIP_PYTHON = !BENCHMARK_PYTHON_URL;

let tsClient: MemoryServiceClient;
let pyClient: MemoryServiceClient | null = null;
let tsServer: ReturnType<typeof createTestServer>;
let tsMemory: Memory;

describe('01 — add() latency', () => {
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

  test.skipIf(SKIP)('add(infer=false) — TS', async () => {
    const stats = await runN(BENCHMARK_RUNS, async () => {
      await tsClient.add('Benchmark test memory entry for latency measurement', {
        user_id: TS_USER,
        infer: false,
      });
    });
    console.log(`  TS add(infer=false): p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP || SKIP_PYTHON)('add(infer=false) — Python', async () => {
    const stats = await runN(BENCHMARK_RUNS, async () => {
      await pyClient!.add('Benchmark test memory entry for latency measurement', {
        user_id: PY_USER,
        infer: false,
      });
    });
    console.log(`  PY add(infer=false): p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP)('add(infer=true) — TS', async () => {
    const stats = await runN(BENCHMARK_RUNS, async () => {
      await tsClient.add('I enjoy reading science fiction books and watching documentaries about space', {
        user_id: TS_USER,
        infer: true,
      });
    });
    console.log(`  TS add(infer=true): p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP || SKIP_PYTHON)('add(infer=true) — Python', async () => {
    const stats = await runN(BENCHMARK_RUNS, async () => {
      await pyClient!.add('I enjoy reading science fiction books and watching documentaries about space', {
        user_id: PY_USER,
        infer: true,
      });
    });
    console.log(`  PY add(infer=true): p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP)('comparison table: infer=false', async () => {
    // Run fresh measurements for side-by-side
    const tsStats = await runN(BENCHMARK_RUNS, () =>
      tsClient.add('Side-by-side comparison memory entry', { user_id: TS_USER, infer: false }),
    );

    let pyStats: LatencyStats | undefined;
    if (pyClient) {
      pyStats = await runN(BENCHMARK_RUNS, () =>
        pyClient!.add('Side-by-side comparison memory entry', { user_id: PY_USER, infer: false }),
      );
    }

    const results: ComparisonResult[] = [
      { name: 'add(infer=false)', ts: tsStats, python: pyStats, unit: 'ms' },
    ];
    printComparisonTable(results);
    expect(tsStats.p50).toBeGreaterThan(0);
  });

  test.skipIf(SKIP)('comparison table: infer=true', async () => {
    const tsStats = await runN(BENCHMARK_RUNS, () =>
      tsClient.add('I like hiking and mountain biking in Colorado', { user_id: TS_USER, infer: true }),
    );

    let pyStats: LatencyStats | undefined;
    if (pyClient) {
      pyStats = await runN(BENCHMARK_RUNS, () =>
        pyClient!.add('I like hiking and mountain biking in Colorado', { user_id: PY_USER, infer: true }),
      );
    }

    const results: ComparisonResult[] = [
      { name: 'add(infer=true)', ts: tsStats, python: pyStats, unit: 'ms' },
    ];
    printComparisonTable(results);
    writeResultsJson(results, `${BENCHMARK_DIR}/01-perf-add.json`);
    expect(tsStats.p50).toBeGreaterThan(0);
  });
});
