/**
 * Benchmark configuration — reads env vars and generates matching configs
 * for both TS and Python services.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Env Vars ──────────────────────────────────────────────────────────

export const RUN_BENCHMARKS = process.env.RUN_BENCHMARKS === '1';
export const BENCHMARK_PYTHON_URL = process.env.BENCHMARK_PYTHON_URL || '';
export const BENCHMARK_MODE = (process.env.BENCHMARK_MODE || 'ollama') as 'ollama' | 'openai';
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const BENCHMARK_RUNS = parseInt(process.env.BENCHMARK_RUNS || '5', 10);

export const BENCHMARK_LLM_MODEL =
  process.env.BENCHMARK_LLM_MODEL ||
  (BENCHMARK_MODE === 'openai' ? 'gpt-4o-mini' : 'qwen2.5-coder:3b');

export const BENCHMARK_EMBED_MODEL =
  process.env.BENCHMARK_EMBED_MODEL ||
  (BENCHMARK_MODE === 'openai' ? 'text-embedding-3-small' : 'nomic-embed-text');

export const BENCHMARK_EMBED_DIMS =
  BENCHMARK_EMBED_MODEL === 'nomic-embed-text' ? 768
  : BENCHMARK_EMBED_MODEL === 'text-embedding-3-small' ? 1536
  : 768; // default

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

// Python runs inside Docker — needs host.docker.internal to reach host Ollama.
// Rewrite localhost → host.docker.internal for the Python config.
const OLLAMA_DOCKER_URL = OLLAMA_BASE_URL.replace('://localhost', '://host.docker.internal');

// ── Config Output Path ────────────────────────────────────────────────
// Use $HOME path instead of /tmp — snap-installed Docker cannot bind-mount
// files from /tmp (snap confinement silently creates directories instead).

const SCRIPT_DIR = import.meta.dir;
export const BENCHMARK_DIR = `${SCRIPT_DIR}/.benchmark-data`;
export const RESULTS_PATH = `${BENCHMARK_DIR}/results.json`;

// ── TS Config (MemoryConfig shape) ────────────────────────────────────

export function getTsConfig() {
  const base = {
    llm: {
      provider: BENCHMARK_MODE === 'openai' ? 'openai' : 'ollama',
      config: {
        model: BENCHMARK_LLM_MODEL,
        temperature: 0,
        maxTokens: 2000,
        ...(BENCHMARK_MODE === 'openai'
          ? { apiKey: OPENAI_API_KEY }
          : { baseUrl: OLLAMA_BASE_URL }),
      },
    },
    embedder: {
      provider: BENCHMARK_MODE === 'openai' ? 'openai' : 'ollama',
      config: {
        model: BENCHMARK_EMBED_MODEL,
        dimensions: BENCHMARK_EMBED_DIMS,
        ...(BENCHMARK_MODE === 'openai'
          ? { apiKey: OPENAI_API_KEY }
          : { baseUrl: OLLAMA_BASE_URL }),
      },
    },
    vectorStore: {
      provider: 'sqlite-vec' as const,
      config: {
        dbPath: `${BENCHMARK_DIR}/ts-benchmark.db`,
        collectionName: 'benchmark',
        dimensions: BENCHMARK_EMBED_DIMS,
      },
    },
    disableHistory: true,
  };
  return base;
}

// ── Python Config (mem0 format) ───────────────────────────────────────

export function getPythonConfig() {
  const config: Record<string, unknown> = {
    llm: {
      provider: BENCHMARK_MODE === 'openai' ? 'openai' : 'ollama',
      config: {
        model: BENCHMARK_LLM_MODEL,
        temperature: 0,
        max_tokens: 2000,
        ...(BENCHMARK_MODE === 'openai'
          ? { api_key: 'env:OPENAI_API_KEY' }
          : { ollama_base_url: OLLAMA_DOCKER_URL }),
      },
    },
    embedder: {
      provider: BENCHMARK_MODE === 'openai' ? 'openai' : 'ollama',
      config: {
        model: BENCHMARK_EMBED_MODEL,
        embedding_dims: BENCHMARK_EMBED_DIMS,
        ...(BENCHMARK_MODE === 'openai'
          ? { api_key: 'env:OPENAI_API_KEY' }
          : { ollama_base_url: OLLAMA_DOCKER_URL }),
      },
    },
    vector_store: {
      provider: 'qdrant',
      config: {
        collection_name: 'benchmark',
        embedding_model_dims: BENCHMARK_EMBED_DIMS,
        path: '/data/qdrant',
      },
    },
    version: 'v1.1',
  };
  return { mem0: config };
}

// ── Write Configs to Disk ─────────────────────────────────────────────

export function writeBenchmarkConfigs(): void {
  mkdirSync(BENCHMARK_DIR, { recursive: true });

  const pythonConfigPath = `${BENCHMARK_DIR}/python-config.json`;
  mkdirSync(dirname(pythonConfigPath), { recursive: true });
  writeFileSync(pythonConfigPath, JSON.stringify(getPythonConfig(), null, 2) + '\n');
}

// ── Test User IDs ─────────────────────────────────────────────────────

export const TS_USER = 'bench-ts';
export const PY_USER = 'bench-py';
