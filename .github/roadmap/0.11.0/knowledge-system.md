# OpenPalm 0.11.0 — Knowledge System (Deferred from 0.10.0)

> Deferred 2026-03-18 by agent review consensus (3/5 agents). These priorities were originally part of `knowledge-system-roadmap.md` for 0.10.0 but were split out because the component system rewrite (#301) consumes most of the 0.10.0 development window.

## Prerequisites (from 0.10.0)

These must ship in 0.10.0 before this work can begin:

- [x] Unified Component System (#301) — stable component lifecycle
- [x] OpenViking as component (#298 Phase 1A) — compose overlay + .env.schema
- [x] Viking assistant tools (#298 Phase 1B) — vikingFetch() + 6 tool wrappers
- [x] Secret backend abstraction (#300 Phase 2) — for MCP_API_KEY management
- [x] Shell automation action type — for eval/maintenance scripts

---

## Priority 2: MCP Server as Component

> Originally knowledge-system-roadmap.md Priority 2. Tracked separately from #298.

### Goal

Expose OpenPalm's tools + OpenViking knowledge to any MCP client. Delivered as a component via the component registry.

### Implementation

Create `packages/mcp/` with:
- `src/server.ts` — tool + resource registration
- `src/http-server.ts` — port from Hyphn (verbatim)
- `src/tools/admin.ts` — wrap admin API
- `src/tools/memory.ts` — wrap memory API
- `src/tools/viking.ts` — wrap OpenViking API (when installed)
- `src/tools/channels.ts` — wrap channel/component ops
- `Dockerfile` — Bun runtime, follows Docker dependency resolution pattern

Component registry entry at `registry/components/mcp/`:
- `compose.yml` — MCP server container on `assistant_net`
- `.env.schema` — `MCP_API_KEY`, `OP_ADMIN_TOKEN`
- `mcp.caddy` — LAN-only reverse proxy route

Client config generation: `GET /admin/mcp/config` returns pre-filled config for Claude Desktop/Cursor.

### Estimated Effort: 3 days

---

## Priority 3: Eval Framework

> Originally knowledge-system-roadmap.md Priority 3.

### Goal

Measure assistant quality over time. Eval suites are shell-executable scripts that work standalone via scheduled automations. When the admin OpenCode instance (#304) is available, it can invoke these scripts and provide LLM-augmented analysis.

### Implementation

Create `packages/eval/`:
- `src/types.ts` — port EvalResult schema from Hyphn
- `src/graders/base.ts` — port Grader + GraderRegistry
- `src/graders/llm-judge.ts` — adapted: calls admin LLM proxy, not direct SDK
- `src/graders/tool-usage.ts` — grade tool selection accuracy
- `src/runner.ts` — shell-executable runner
- `src/regress.ts` — regression clustering
- `src/cli.ts` — CLI entrypoint for shell automation

Eval suites in `packages/eval/suites/`:
- `assistant-tools.yaml` — prompt → correct tool selection
- `memory-retrieval.yaml` — add memories → query → recall
- `viking-retrieval.yaml` — seed resources → search → verify (skipped if Viking absent)
- `channel-pipeline.yaml` — full E2E message flow
- `security.yaml` — malicious inputs → guardian blocks

Shell automation:
```yaml
name: Nightly Eval
schedule: "0 2 * * *"
action:
  type: shell
  command: "bun run packages/eval/src/cli.ts run --suite all --output STATE_HOME/eval/"
  timeout: 300000
```

Admin API: `GET /admin/eval/results` + `GET /admin/eval/regressions`

### Estimated Effort: 6 days

---

## Priority 4: MemRL-Inspired Feedback Loop

> Originally knowledge-system-roadmap.md Priority 4.

### Goal

Close the loop with learned utility scores (Q-values) that update based on actual outcomes, not just time decay.

### Key Design

Q-value update formula: `Q_new = Q_old + alpha * (R - Q_old)` where `alpha = 0.1`.

Reward signals:
- `R = 1.0` — task succeeded and this memory was used
- `R = 0.5` — task succeeded but memory wasn't directly relevant
- `R = 0.0` — task failed and this memory was used
- `R = 0.3` — task failed but memory contributed partial insight

### Implementation

- Phase 4A: Q-value tracking in `@openpalm/memory` metadata (2 days)
- Phase 4B: Two-phase retrieval with graceful degradation (1 day)
- Phase 4C: Automated maintenance shell scripts (2 days)
- Phase 4D: Admin visibility — `GET /admin/knowledge/stats`, `KnowledgeTab.svelte` (1 day)

### Estimated Effort: 6 days

---

## Revised 0.11.0 Execution Order

```
MCP component (Priority 2)              3 days
Eval types + runner (Priority 3A)        2 days
Eval suites (Priority 3B)               2 days
Eval scheduling (Priority 3C)           2 days
Q-value tracking (Priority 4A)          2 days
Two-phase retrieval (Priority 4B)       1 day
Maintenance scripts (Priority 4C)       2 days
Admin visibility (Priority 4D)          1 day
                                  Total: 15 days
```
