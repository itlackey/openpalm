# Memory Benchmark Suite

Performance and quality comparison between the TypeScript mem0 port and the original Python mem0 service.

**The default `bun run test:benchmark` builds the Python reference Docker image, starts it, runs all benchmarks (perf + quality) comparing both services, then tears down.** No manual Docker steps needed.

## Quick Start

```bash
# Full comparison — builds Python image, runs all benchmarks, tears down
bun run test:benchmark

# Performance only (still starts Python for comparison)
bun run test:benchmark:perf

# Quality only (fact extraction, decisions, search ranking)
bun run test:benchmark:quality

# TS-only (skip Python, perf tests only — quality tests will skip)
bun run test:benchmark:ts-only
```

## Requirements

- **Ollama** running locally with an LLM and embedding model (default: `qwen2.5-coder:3b` + `nomic-embed-text`)
- **Docker** for the Python reference service
- Or set `BENCHMARK_MODE=openai` with `OPENAI_API_KEY` to use OpenAI instead of Ollama

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `BENCHMARK_MODE` | `ollama` or `openai` | `ollama` |
| `OPENAI_API_KEY` | Required for openai mode | — |
| `BENCHMARK_LLM_MODEL` | Override LLM model | `qwen2.5-coder:3b` / `gpt-4o-mini` |
| `BENCHMARK_EMBED_MODEL` | Override embedder model | `nomic-embed-text` / `text-embedding-3-small` |
| `BENCHMARK_RUNS` | Repetitions per measurement | `5` |
| `OLLAMA_BASE_URL` | Ollama server URL | `http://localhost:11434` |

## Test Files

| File | What it measures |
|------|-----------------|
| `01-perf-add.test.ts` | add() latency: infer=true and infer=false |
| `02-perf-search.test.ts` | search() latency at corpus size 50 |
| `03-perf-crud.test.ts` | get/update/delete/getAll latency |
| `04-perf-concurrent.test.ts` | Concurrent adds and searches |
| `05-quality-fact-extraction.test.ts` | Compare extracted facts across services |
| `06-quality-decisions.test.ts` | Compare ADD/UPDATE/DELETE decisions |
| `07-quality-search-ranking.test.ts` | Compare search result overlap and ranking |

## Output

- ASCII comparison tables printed to stdout
- JSON results written to `packages/memory/benchmark-tests/.benchmark-data/*.json`

## Design

- Both services use REST API for fair comparison (not direct class calls)
- LLM temperature set to 0 for determinism
- Quality tests run 3 iterations with majority vote for operation agreement
- Quality metrics are reported, not hard gates — the goal is visibility
- Avoid thinking models (qwen3, deepseek-r1) — they break JSON output
