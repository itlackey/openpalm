/**
 * Quality benchmark: compare ADD/UPDATE/DELETE decisions between services.
 *
 * Pre-populates both services with identical memories, then sends new text
 * with infer=true and compares operation type agreement.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Memory } from '../src/memory.js';
import { createTestServer } from '../parity-tests/helpers.js';
import { MemoryServiceClient } from './helpers.js';
import {
  RUN_BENCHMARKS,
  BENCHMARK_PYTHON_URL,
  getTsConfig,
  writeBenchmarkConfigs,
  TS_USER,
  PY_USER,
  BENCHMARK_DIR,
} from './config.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const SKIP = !RUN_BENCHMARKS;
const SKIP_PYTHON = !BENCHMARK_PYTHON_URL;
const ITERATIONS = 3;

let tsClient: MemoryServiceClient;
let pyClient: MemoryServiceClient | null = null;
let tsServer: ReturnType<typeof createTestServer>;
let tsMemory: Memory;

// Pre-existing memories to populate both services
const existingMemories = [
  'User lives in New York City',
  'User works at Microsoft as a software engineer',
  'User prefers Python over JavaScript',
  'User has a dog named Buddy',
];

// New texts that should trigger ADD, UPDATE, or DELETE
const testCases = [
  {
    id: 'update-location',
    text: 'I just moved to San Francisco last week. No longer in New York.',
    expectedOp: 'UPDATE',
  },
  {
    id: 'add-new',
    text: 'I started learning piano and take lessons every Thursday.',
    expectedOp: 'ADD',
  },
  {
    id: 'contradiction',
    text: 'Actually I prefer JavaScript and TypeScript over Python now.',
    expectedOp: 'UPDATE',
  },
  {
    id: 'reinforcement',
    text: 'My dog Buddy is a golden retriever and loves playing fetch.',
    expectedOp: 'UPDATE',
  },
];

type DecisionResult = {
  testCase: string;
  tsOps: string[];
  pyOps: string[];
  agreed: boolean;
};

const decisionResults: DecisionResult[] = [];

describe('06 — decision quality', () => {
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

    if (decisionResults.length > 0) {
      mkdirSync(BENCHMARK_DIR, { recursive: true });
      writeFileSync(
        `${BENCHMARK_DIR}/06-quality-decisions.json`,
        JSON.stringify(decisionResults, null, 2) + '\n',
      );

      console.log('\n--- Decision Quality Summary ---');
      const agreed = decisionResults.filter((r) => r.agreed).length;
      console.log(`  Agreement: ${agreed}/${decisionResults.length} cases`);
      for (const r of decisionResults) {
        console.log(
          `  ${r.testCase}: TS=[${r.tsOps.join(',')}] PY=[${r.pyOps.join(',')}] ${r.agreed ? 'AGREE' : 'DIFFER'}`,
        );
      }
      console.log('');
    }
  });

  for (const tc of testCases) {
    test.skipIf(SKIP || SKIP_PYTHON)(`decisions: ${tc.id}`, async () => {
      // Collect operation types across iterations (majority vote)
      const tsOpCounts: Record<string, number> = {};
      const pyOpCounts: Record<string, number> = {};

      for (let iter = 0; iter < ITERATIONS; iter++) {
        const tsUser = `${TS_USER}-${tc.id}-${iter}`;
        const pyUser = `${PY_USER}-${tc.id}-${iter}`;

        // Clean + seed
        try { await tsClient.deleteAll(tsUser); } catch {}
        try { await pyClient!.deleteAll(pyUser); } catch {}

        for (const mem of existingMemories) {
          await tsClient.add(mem, { user_id: tsUser, infer: false });
          await pyClient!.add(mem, { user_id: pyUser, infer: false });
        }

        // Send new text with infer=true
        const tsResult = await tsClient.add(tc.text, { user_id: tsUser, infer: true });
        const pyResult = await pyClient!.add(tc.text, { user_id: pyUser, infer: true });

        // Extract operation types
        const tsOps = (tsResult.results ?? []).map((r) => r.event ?? 'NONE');
        const pyOps = (pyResult.results ?? []).map((r) => r.event ?? 'NONE');

        for (const op of tsOps) tsOpCounts[op] = (tsOpCounts[op] ?? 0) + 1;
        for (const op of pyOps) pyOpCounts[op] = (pyOpCounts[op] ?? 0) + 1;
      }

      // Majority vote: most common operation type
      const tsMajority = Object.entries(tsOpCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'NONE';
      const pyMajority = Object.entries(pyOpCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'NONE';

      const agreed = tsMajority === pyMajority;
      decisionResults.push({
        testCase: tc.id,
        tsOps: Object.keys(tsOpCounts),
        pyOps: Object.keys(pyOpCounts),
        agreed,
      });

      console.log(
        `  ${tc.id}: TS majority=${tsMajority} PY majority=${pyMajority} ${agreed ? 'AGREE' : 'DIFFER'}`,
      );

      // We report, not gate — but TS should at least produce operations
      expect(Object.keys(tsOpCounts).length).toBeGreaterThan(0);
    }, 120_000);
  }
});
