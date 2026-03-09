/**
 * Quality benchmark: compare search result overlap and ranking between services.
 *
 * Seeds both with identical memories, runs the same queries, and compares
 * top-5 result set overlap and rank correlation.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Memory } from '../src/memory.js';
import { createTestServer } from '../parity-tests/helpers.js';
import { MemoryServiceClient, spearmanRank } from './helpers.js';
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
import { mkdirSync, writeFileSync } from 'node:fs';

const SKIP = !RUN_BENCHMARKS;
const SKIP_PYTHON = !BENCHMARK_PYTHON_URL;
const TOP_K = 5;

let tsClient: MemoryServiceClient;
let pyClient: MemoryServiceClient | null = null;
let tsServer: ReturnType<typeof createTestServer>;
let tsMemory: Memory;

type RankingResult = {
  query: string;
  tsResults: string[];
  pyResults: string[];
  overlapCount: number;
  overlapPct: number;
  spearman: number;
};

const rankingResults: RankingResult[] = [];

describe('07 — search ranking quality', () => {
  beforeAll(async () => {
    if (SKIP || SKIP_PYTHON) return;

    writeBenchmarkConfigs();

    const config = getTsConfig();
    tsMemory = new Memory(config);
    tsServer = createTestServer(tsMemory);
    tsClient = new MemoryServiceClient(tsServer.url);
    pyClient = new MemoryServiceClient(BENCHMARK_PYTHON_URL);

    // Clean
    try { await tsClient.deleteAll(TS_USER); } catch {}
    try { await pyClient.deleteAll(PY_USER); } catch {}

    // Seed both with identical memories
    for (const mem of seedData.seedMemories) {
      await tsClient.add(mem, { user_id: TS_USER, infer: false });
      await pyClient.add(mem, { user_id: PY_USER, infer: false });
    }
  }, 120_000);

  afterAll(() => {
    if (SKIP || SKIP_PYTHON) return;
    tsServer?.close();
    tsMemory?.close();

    if (rankingResults.length > 0) {
      mkdirSync(BENCHMARK_DIR, { recursive: true });
      writeFileSync(
        `${BENCHMARK_DIR}/07-quality-ranking.json`,
        JSON.stringify(rankingResults, null, 2) + '\n',
      );

      console.log('\n--- Search Ranking Quality Summary ---');
      for (const r of rankingResults) {
        console.log(
          `  "${r.query}": overlap=${r.overlapCount}/${TOP_K} (${(r.overlapPct * 100).toFixed(0)}%), spearman=${r.spearman.toFixed(2)}`,
        );
      }
      const avgOverlap =
        rankingResults.reduce((s, r) => s + r.overlapPct, 0) / rankingResults.length;
      const avgSpearman =
        rankingResults.reduce((s, r) => s + r.spearman, 0) / rankingResults.length;
      console.log(
        `  Average: overlap=${(avgOverlap * 100).toFixed(0)}%, spearman=${avgSpearman.toFixed(2)}\n`,
      );
    }
  });

  for (const sq of seedData.searchQueries) {
    test.skipIf(SKIP || SKIP_PYTHON)(`ranking: ${sq.id}`, async () => {
      const tsRes = await tsClient.search(sq.query, { user_id: TS_USER, size: TOP_K });
      const pyRes = await pyClient!.search(sq.query, { user_id: PY_USER, size: TOP_K });

      const tsItems = tsRes.items ?? [];
      const pyItems = pyRes.items ?? [];

      const tsContents = tsItems.map((m) => m.content);
      const pyContents = pyItems.map((m) => m.content);

      // Overlap: count how many TS results appear in PY results (by content)
      const pyContentSet = new Set(pyContents);
      const overlapCount = tsContents.filter((c) => pyContentSet.has(c)).length;
      const overlapPct = TOP_K > 0 ? overlapCount / TOP_K : 0;

      // Rank correlation: use content as ID for matching
      const tsRanked = tsContents.map((c) => ({ id: c }));
      const pyRanked = pyContents.map((c) => ({ id: c }));
      const spearman = spearmanRank(tsRanked, pyRanked);

      rankingResults.push({
        query: sq.query,
        tsResults: tsContents,
        pyResults: pyContents,
        overlapCount,
        overlapPct,
        spearman,
      });

      console.log(
        `  ${sq.id}: overlap=${overlapCount}/${TOP_K}, spearman=${spearman.toFixed(2)}`,
      );

      // Both should return results
      expect(tsItems.length).toBeGreaterThan(0);
    }, 60_000);
  }

  test.skipIf(SKIP || SKIP_PYTHON)('overall quality report', () => {
    if (rankingResults.length === 0) return;

    const avgOverlap =
      rankingResults.reduce((s, r) => s + r.overlapPct, 0) / rankingResults.length;
    const avgSpearman =
      rankingResults.reduce((s, r) => s + r.spearman, 0) / rankingResults.length;

    console.log(`\n  Overall: avg overlap=${(avgOverlap * 100).toFixed(0)}%, avg spearman=${avgSpearman.toFixed(2)}`);

    // We report metrics, not hard gates. But sanity check TS returns results.
    expect(rankingResults.length).toBe(seedData.searchQueries.length);
  });
});
