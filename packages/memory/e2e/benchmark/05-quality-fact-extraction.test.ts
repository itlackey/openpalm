/**
 * Quality benchmark: compare extracted facts between TS and Python services.
 *
 * For each conversation scenario, sends the same text to both services with
 * infer=true, then compares the extracted facts using fuzzy overlap.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Memory } from '../../src/memory.js';
import { createTestServer } from '../parity/helpers.js';
import { MemoryServiceClient, fuzzyOverlap } from './helpers.js';
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

let tsClient: MemoryServiceClient;
let pyClient: MemoryServiceClient | null = null;
let tsServer: ReturnType<typeof createTestServer>;
let tsMemory: Memory;

type FactResult = {
  scenario: string;
  tsFacts: string[];
  pyFacts: string[];
  overlap: number;
};

const factResults: FactResult[] = [];

describe('05 — fact extraction quality', () => {
  beforeAll(async () => {
    if (SKIP || SKIP_PYTHON) return;

    writeBenchmarkConfigs();

    const config = getTsConfig();
    tsMemory = new Memory(config);
    tsServer = createTestServer(tsMemory);
    tsClient = new MemoryServiceClient(tsServer.url);
    pyClient = new MemoryServiceClient(BENCHMARK_PYTHON_URL);
  });

  afterAll(() => {
    if (SKIP || SKIP_PYTHON) return;
    tsServer?.close();
    tsMemory?.close();

    if (factResults.length > 0) {
      mkdirSync(BENCHMARK_DIR, { recursive: true });
      writeFileSync(
        `${BENCHMARK_DIR}/05-quality-facts.json`,
        JSON.stringify(factResults, null, 2) + '\n',
      );

      console.log('\n--- Fact Extraction Quality Summary ---');
      for (const r of factResults) {
        console.log(
          `  ${r.scenario}: TS=${r.tsFacts.length} facts, PY=${r.pyFacts.length} facts, overlap=${(r.overlap * 100).toFixed(0)}%`,
        );
      }
      const avgOverlap =
        factResults.reduce((s, r) => s + r.overlap, 0) / factResults.length;
      console.log(`  Average overlap: ${(avgOverlap * 100).toFixed(0)}%\n`);
    }
  });

  for (const conv of seedData.conversations) {
    test.skipIf(SKIP || SKIP_PYTHON)(`fact extraction: ${conv.id}`, async () => {
      // Use unique user IDs per scenario to avoid cross-contamination
      const tsUser = `${TS_USER}-${conv.id}`;
      const pyUser = `${PY_USER}-${conv.id}`;

      // Clean
      try { await tsClient.deleteAll(tsUser); } catch {}
      try { await pyClient!.deleteAll(pyUser); } catch {}

      // Add with infer=true to both
      await tsClient.add(conv.text, { user_id: tsUser, infer: true });
      await pyClient!.add(conv.text, { user_id: pyUser, infer: true });

      // Retrieve all memories
      const tsAll = await tsClient.getAll(tsUser);
      const pyAll = await pyClient!.getAll(pyUser);

      const tsFacts = (tsAll.items ?? []).map((m) => m.content);
      const pyFacts = (pyAll.items ?? []).map((m) => m.content);

      const overlap = fuzzyOverlap(tsFacts, pyFacts);

      factResults.push({
        scenario: conv.id,
        tsFacts,
        pyFacts,
        overlap,
      });

      // Report, not gate — we expect some variance
      console.log(
        `  ${conv.id}: TS extracted ${tsFacts.length} facts, PY extracted ${pyFacts.length} facts, overlap=${(overlap * 100).toFixed(0)}%`,
      );

      // Sanity: both should extract at least 1 fact (relaxed — small LLMs
      // may consolidate facts differently than the fixture expects)
      expect(tsFacts.length).toBeGreaterThanOrEqual(1);
    }, 60_000);
  }
});
