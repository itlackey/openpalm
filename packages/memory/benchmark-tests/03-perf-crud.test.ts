/**
 * Benchmark: get/update/delete/getAll latency
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

const SKIP = !RUN_BENCHMARKS;
const SKIP_PYTHON = !BENCHMARK_PYTHON_URL;

let tsClient: MemoryServiceClient;
let pyClient: MemoryServiceClient | null = null;
let tsServer: ReturnType<typeof createTestServer>;
let tsMemory: Memory;

// Store IDs from seeded memories
let tsIds: string[] = [];
let pyIds: string[] = [];

describe('03 — CRUD latency', () => {
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

    // Seed 10 memories each
    for (let i = 0; i < 10; i++) {
      const result = await tsClient.add(`CRUD benchmark memory #${i}`, {
        user_id: TS_USER,
        infer: false,
      });
      const id = result.id ?? result.results?.[0]?.id;
      if (id) tsIds.push(id);
    }

    if (pyClient) {
      for (let i = 0; i < 10; i++) {
        const result = await pyClient.add(`CRUD benchmark memory #${i}`, {
          user_id: PY_USER,
          infer: false,
        });
        const id = result.id ?? result.results?.[0]?.id;
        if (id) pyIds.push(id);
      }
    }
  }, 60_000);

  afterAll(() => {
    if (SKIP) return;
    tsServer?.close();
    tsMemory?.close();
  });

  test.skipIf(SKIP)('get(id) — TS', async () => {
    let idx = 0;
    const stats = await runN(BENCHMARK_RUNS, async () => {
      const id = tsIds[idx % tsIds.length];
      idx++;
      await tsClient.get(id);
    });
    console.log(`  TS get: p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP || SKIP_PYTHON)('get(id) — Python', async () => {
    let idx = 0;
    const stats = await runN(BENCHMARK_RUNS, async () => {
      const id = pyIds[idx % pyIds.length];
      idx++;
      await pyClient!.get(id);
    });
    console.log(`  PY get: p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP)('update(id, data) — TS', async () => {
    let idx = 0;
    const stats = await runN(BENCHMARK_RUNS, async () => {
      const id = tsIds[idx % tsIds.length];
      idx++;
      await tsClient.update(id, `Updated memory content iteration ${idx}`);
    });
    console.log(`  TS update: p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP || SKIP_PYTHON)('update(id, data) — Python', async () => {
    let idx = 0;
    const stats = await runN(BENCHMARK_RUNS, async () => {
      const id = pyIds[idx % pyIds.length];
      idx++;
      await pyClient!.update(id, `Updated memory content iteration ${idx}`);
    });
    console.log(`  PY update: p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP)('getAll(userId) — TS', async () => {
    const stats = await runN(BENCHMARK_RUNS, async () => {
      await tsClient.getAll(TS_USER);
    });
    console.log(`  TS getAll: p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP || SKIP_PYTHON)('getAll(userId) — Python', async () => {
    const stats = await runN(BENCHMARK_RUNS, async () => {
      await pyClient!.getAll(PY_USER);
    });
    console.log(`  PY getAll: p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms`);
    expect(stats.samples.length).toBe(BENCHMARK_RUNS);
  });

  test.skipIf(SKIP)('comparison table', async () => {
    const tsGet = await runN(BENCHMARK_RUNS, () => tsClient.get(tsIds[0]));
    const tsUpdate = await runN(BENCHMARK_RUNS, () => tsClient.update(tsIds[0], 'final content'));
    const tsGetAll = await runN(BENCHMARK_RUNS, () => tsClient.getAll(TS_USER));

    let pyGet: LatencyStats | undefined;
    let pyUpdate: LatencyStats | undefined;
    let pyGetAll: LatencyStats | undefined;

    if (pyClient && pyIds.length > 0) {
      pyGet = await runN(BENCHMARK_RUNS, () => pyClient!.get(pyIds[0]));
      pyUpdate = await runN(BENCHMARK_RUNS, () => pyClient!.update(pyIds[0], 'final content'));
      pyGetAll = await runN(BENCHMARK_RUNS, () => pyClient!.getAll(PY_USER));
    }

    const results: ComparisonResult[] = [
      { name: 'get(id)', ts: tsGet, python: pyGet, unit: 'ms' },
      { name: 'update(id, data)', ts: tsUpdate, python: pyUpdate, unit: 'ms' },
      { name: 'getAll(userId)', ts: tsGetAll, python: pyGetAll, unit: 'ms' },
    ];
    printComparisonTable(results);
    writeResultsJson(results, `${BENCHMARK_DIR}/03-perf-crud.json`);
    expect(tsGet.p50).toBeGreaterThan(0);
  });
});
