# OpenPalm 0.10.0 — Knowledge System Roadmap (Revised)

> **Scope Update (2026-03-18):** Agent review consensus (3/5 agents) narrowed the 0.10.0 scope to **Priority 1 only** (Phases 1A-1D: OpenViking as addon + assistant tools). Priorities 2-4 (MCP server, eval framework, MemRL feedback loop) are deferred to 0.11.0 and are included below only as "deferred" context. See `../0.11.0/knowledge-system.md` for the deferred work.
>
> **Filesystem context:** This plan uses the `~/.openpalm/` single-root layout defined in [fs-mounts-refactor.md](fs-mounts-refactor.md). The old three-tier XDG references (`DATA_HOME`, `CONFIG_HOME`, `STATE_HOME`) are replaced by subdirectories under `~/.openpalm/`.

## Alignment with Milestone 0.10.0

This plan covers Priority 1: OpenViking as an optional knowledge addon with
assistant tool integration. Priorities 2-4 were moved to 0.11.0 because the
addon-system rewrite (#301) consumes most of the 0.10.0 development window.

### Milestone 0.10.0 Issues

| # | Feature | How Knowledge Work Connects |
|---|---------|----------------------------|
| **304** | Admin OpenCode instance | **Admin-level agent with full ADMIN_TOKEN access** — runs learning maintenance, curation, and eval jobs. Accessed directly via web UI at `localhost:3881`. When available, invokes shell-based eval/maintenance scripts; but those scripts work standalone via scheduled automations as a fallback |
| **298** | OpenViking integration | **Optional structured knowledge addon** — enhances search and context retrieval when installed, but the core learning lifecycle (Q-values, feedback, memory injection) works without it |
| **301** | Configurable services | **Addon model** that Viking uses for installation — compose overlay, `.env.schema`, cross-addon env injection. MCP server addon deferred to 0.11.0 |
| **300** | Password manager (Varlock) | API keys for embedding providers and LLM judge stored securely via improved Varlock |
| **302** | TTS/STT voice interface | Voice-driven learning capture and context retrieval (future, not in this plan) |
| **13** | Advanced channel config | Per-channel OpenCode config enables per-channel learning scopes (future) |

### Research-Informed Architecture Decisions

The research converges on **composable memory** — different knowledge types need
different storage, retrieval, and evolution strategies. Our architecture uses
three complementary stores, each playing a distinct role:

| Store | Role | Maps To (Research) |
|-------|------|-------------------|
| **OpenViking** (optional addon) | Hierarchical knowledge — resources, agent skills, structured memories with L0/L1/L2 tiered loading. Enhances search when installed but is not required for the core learning lifecycle | Hindsight's four-network model (facts, experiences, observations, beliefs) via viking:// filesystem hierarchy |
| **@openpalm/memory** | Episodic/preference persistence — LLM-extracted facts, user preferences, session summaries. Also the primary store for Q-value utility scores | Mem0 pattern (already implemented) |
| **MemRL Q-values** | Utility scoring layer — tracks which memories/learnings actually help via reinforcement | MemRL's Monte Carlo Q-value updates: `Q_new = Q_old + alpha(R - Q_old)` |

**Key insight from MemRL**: Confidence should not be a static score or simple
decay function. It should be a **learned utility estimate** updated by actual
outcomes. Some failures are still valuable (they encode near-correct reasoning).
The scoring formula changes from the original plan's `0.7 * confidence + 0.3 *
recency` to a Q-value that converges toward empirical expected return.

**Key architectural constraint**: OpenViking is an **optional addon** that
enhances search when installed. The core learning lifecycle (Q-values, feedback
signals, memory injection via `assembleContext()`) works entirely through
`@openpalm/memory` without Viking. When Viking is not installed,
`assembleContext()` uses memory service search instead of Viking search, and
two-phase retrieval degrades gracefully to memory-only retrieval ranked by
Q-value.

---

## Priority 1: OpenViking as Knowledge Addon (#298)

### Goal

Wire OpenViking as an optional structured knowledge addon, using its native
capabilities to enhance search and context retrieval when installed.

### Why OpenViking Instead of Custom Learnings Files

The original plan proposed porting Hyphn's inscribe reader/writer to store
YAML-frontmatter Markdown files in `~/.openpalm/data/assistant/learnings/`. But
OpenViking already provides:

- **Hierarchical storage** (`viking://agent/memories/patterns/`, `viking://agent/memories/cases/`) — directly maps to learning types
- **Session-based memory extraction** — 8 categories (PROFILE, PREFERENCES, ENTITIES, EVENTS, CASES, PATTERNS, TOOLS, SKILLS) automatically extracted at session commit
- **L0/L1/L2 tiered loading** — context assembly with token budget awareness built-in
- **Semantic + text search** — `/api/v1/search/find` (vector) + `/api/v1/search/grep` (text)
- **Deduplication** — built into the extraction pipeline
- **Existing TypeScript client** — agentikit's `openviking.ts` provider is production-tested

Building a custom file store duplicates what OpenViking already does. Instead,
we layer MemRL's Q-value scoring on top of OpenViking's native storage when
it is installed, and fall back to memory-only retrieval when it is not.

### What We Map from Research

| Research Concept | OpenViking Implementation |
|-----------------|--------------------------|
| Hindsight world facts | `viking://resources/` — ingested docs, repos, reference material |
| Hindsight agent experiences | `viking://agent/memories/cases/` — learned scenarios (immutable) |
| Hindsight entity observations | `viking://agent/memories/patterns/` — behavioral patterns |
| Hindsight evolving beliefs | `viking://user/memories/preferences/` — appendable, updatable |
| MemRL Q-values | Metadata layer in @openpalm/memory — Q-value per viking:// URI (or per memory ID when Viking is absent) |
| Mem0 fact extraction | `POST /api/v1/sessions/{id}/commit` — native session extraction |

### Implementation Plan

#### Phase 1A: Create Viking Addon Definition (1 day)

OpenViking is an **addon**, not a core service. It is installed on demand
through the addon registry, like Ollama or SearXNG.

1. **Create `registry/components/openviking/`** with `compose.yml` + `.env.schema`:

   `registry/components/openviking/compose.yml`:
   ```yaml
   services:
     openpalm-${INSTANCE_ID}:
       image: ghcr.io/itlackey/openviking:0.4.2
       restart: unless-stopped
       networks:
         - assistant_net
       volumes:
         - ${INSTANCE_DIR}/data/workspace:/workspace
         - ${OP_HOME}/vault/ov.conf:/app/ov.conf:ro
       healthcheck:
         test: ["CMD", "curl", "-sf", "http://localhost:1933/health"]
         interval: 30s
         timeout: 5s
         retries: 3
         start_period: 10s

     # Extension of the existing assistant service (adds env vars only)
     assistant:
       environment:
         OPENVIKING_URL: http://openpalm-${INSTANCE_ID}:1933
         OPENVIKING_API_KEY: ${OPENVIKING_API_KEY}
   ```

   `registry/components/openviking/.env.schema`:
   ```env
   # @sensitive
   OPENVIKING_API_KEY=          # Root API key for Viking access
   EMBEDDING_PROVIDER=openai    # Embedding provider (openai, ollama, etc.)
   EMBEDDING_MODEL=             # Embedding model name
   # @sensitive
   EMBEDDING_API_KEY=           # Embedding provider API key
   EMBEDDING_BASE_URL=          # Embedding provider base URL
   EMBEDDING_DIMS=768           # Embedding dimension
   ```

   Note: Uses `openpalm-${INSTANCE_ID}` service naming (per component plan
   conventions). No `container_name:` (non-standard per D1). Image version is
   pinned (not `:latest`, per D2). Healthcheck is included. Network wiring
   comes from the component compose overlay, not from core
   `assets/docker-compose.yml`. The `assistant` service extension block uses
   the cross-component environment injection pattern from the components plan.

2. **Assemble `ov.conf` programmatically** — file assembly, not template
   rendering. Build a JSON object in TypeScript and write the whole file (same
   pattern as `generateFallbackStackEnv()` in staging.ts):

   ```typescript
   interface VikingConfigOpts {
     embeddingProvider: string;
     embeddingModel: string;
     embeddingApiKey: string;
     embeddingBaseUrl: string;
     embeddingDims: number;
     vikingApiKey: string;
   }

   function assembleVikingConfig(opts: VikingConfigOpts): string {
     return JSON.stringify({
       storage: { workspace: "/workspace" },
       embedding: {
         dense: {
           provider: opts.embeddingProvider,
           model: opts.embeddingModel,
           api_key: opts.embeddingApiKey,
           api_base: opts.embeddingBaseUrl,
           dimension: opts.embeddingDims,
         }
       },
       server: {
         host: "0.0.0.0",
         port: 1933,
         root_api_key: opts.vikingApiKey,
       }
     }, null, 2);
   }
   ```

   The setup wizard already collects embedding provider config — reuse it to
   populate `ov.conf` during component installation.

   **`ov.conf` placement:** `ov.conf` contains the `root_api_key` (a secret),
   so it belongs in the vault. It is stored at `~/.openpalm/vault/ov.conf`
   (consistent with the fs-mounts-refactor vault layout). The admin mounts the
   full vault read-write and can write this file. The Viking component's
   compose overlay mounts `${OP_HOME}/vault/ov.conf` read-only into the
   container at `/app/ov.conf`. This was reconciled from review-decisions Q9
   (which said DATA_HOME before the fs refactor introduced the vault boundary).

3. **Add `OPENVIKING_API_KEY`** to the unified secret manager (Varlock — ties
   into #300). The key is stored as a `@sensitive` field in the `.env.schema`
   and managed through the secret backend, not as plaintext in the instance
   `.env` file.

4. **Admin API** — Viking-specific config and status endpoints are handled
   through the standard component instance API (`GET /api/instances/:id`,
   `PUT /api/instances/:id/config`, `GET /api/instances/:id/health`). No
   Viking-specific admin routes are needed.

#### Phase 1B: Assistant Tools — Viking Client (2 days)

Port the agentikit OpenViking client into `packages/assistant-tools/opencode/tools/`:

| Tool | Viking API | Purpose |
|------|-----------|---------|
| `viking-search` | `POST /search/find` | Semantic search across all knowledge |
| `viking-grep` | `POST /search/grep` | Text search within a URI scope |
| `viking-browse` | `GET /fs/ls` + `GET /context/abstract` | List + L0 summaries |
| `viking-read` | `GET /content/read` | Read full content (L2) |
| `viking-add-resource` | `POST /resources` | Ingest a URL, file, or repo |
| `viking-overview` | `GET /context/overview` | L1 summary (~2k tokens) |

Helper: `vikingFetch(path, opts)` following the existing `adminFetch()`/
`memoryFetch()` pattern, pointing at `http://openviking:1933/api/v1`.

**Note:** `OPENVIKING_URL` and `OPENVIKING_API_KEY` are injected into the
assistant's environment via the Viking component's compose overlay (since Viking
is a component, these are not in the core compose environment block). The
assistant tools must check for these env vars and gracefully degrade when Viking
is not installed.

#### Phase 1C: Session Memory Extraction (2 days)

Wire OpenViking's SessionService into `MemoryContextPlugin` (when Viking is
installed):

1. **`session.created`** hook:
   - If Viking is available: create Viking session (`POST /sessions/create`),
     fetch L0 abstracts for `viking://agent/memories/` and
     `viking://resources/` (cheap, ~100 tokens each), inject alongside
     existing memory retrieval (parallel)
   - If Viking is not available: memory-only retrieval (existing behavior)

2. **`tool.execute.after`** hook:
   - If Viking is available: log tool usage to Viking session
     (`POST /sessions/{id}/message`), records what the assistant did,
     enabling pattern/case extraction
   - Always: log tool usage to memory service (existing behavior)

3. **`session.idle` / `session.deleted`** hook:
   - If Viking is available: commit session (`POST /sessions/{id}/commit`),
     Viking extracts 8 memory categories automatically, deduplicates against
     existing memories, stores at `viking://user/memories/` and
     `viking://agent/memories/` — **this replaces the custom learning
     capture** when Viking is installed
   - Always: existing memory service extraction continues regardless

4. **`experimental.session.compacting`** hook:
   - If Viking is available: inject L1 overviews (not full L2) for active
     agent patterns

#### Phase 1D: Context Assembly with Token Budgets (1 day)

Port Hyphn's token budget utilities (these are still valuable — OpenViking
handles tiered loading but not explicit budget allocation):

- Copy `token-budget.ts` — `estimateTokenCount()`, `fitItemsInBudget()`
- Copy `budget.ts` — `calculateRecommendedBudgets()`, `parseBudgetString()`

Build `assembleContext()` that:
1. If Viking is available: calls `viking-search` with the session query
2. If Viking is not available: calls memory service search with the session query
3. For each result, fetches L0 (abstract) first (Viking) or full content (memory)
4. Ranks by Q-value utility score (from memory metadata — see Priority 4)
5. Promotes top results to L1 (overview) until token budget reached (Viking only)
6. Returns formatted Markdown bundle for session injection

**Existing OpenPalm memory stays as-is** — it continues handling episodic
summaries and user preferences. Viking enhances structured knowledge retrieval
when installed.

### What We Still Port from Hyphn

| Source | Target | Why |
|--------|--------|-----|
| `lib/tokens/token-budget.ts` | `assistant-tools/src/context/tokens.ts` | Token estimation + bin-packing |
| `disclose/src/lib/budget.ts` | `assistant-tools/src/context/budget.ts` | Budget calculation helpers |
| agentikit `openviking.ts` | `assistant-tools/src/lib/viking.ts` | TypeScript HTTP client for Viking |

**What we DON'T port** (replaced by OpenViking when installed):
- ~~`inscribe/src/types/learning.ts`~~ — Viking has its own type system
- ~~`inscribe/src/lib/learning-reader.ts`~~ — Viking reads via HTTP API
- ~~`inscribe/src/lib/learning-writer.ts`~~ — Viking writes via session commit
- ~~`inscribe/src/lib/learning-enrich.ts`~~ — Viking auto-generates abstracts/overviews
- ~~`lib/schemas/learning.ts`~~ — Viking's 8 categories replace our custom taxonomy

### Estimated Effort: 6 days (was 10)

---

## Priority 2: MCP Server as Component (#298 + #301) — DEFERRED TO 0.11.0

> **Deferred:** This priority is out of scope for 0.10.0. It is included here as context only. See `../0.11.0/knowledge-system.md` for the implementation plan.

### Goal

Expose OpenPalm's tools + OpenViking knowledge to any MCP client. Deliver
as a **component** via the component registry, not hardcoded in compose.

### Changes from Original Plan

1. **Delivered via component registry** — MCP is an optional component the user
   installs, not a core container. This means:
   - Defined in `registry/components/mcp/` with `compose.yml` + `.env.schema`
   - Installed via `POST /admin/registry/install` with `type: component`
   - Gets its own compose overlay merged at staging time
   - Caddy snippet is a separate `.caddy` file in the component directory
   - Admin UI shows it in the Components tab

2. **Includes Viking tools** — When OpenViking is installed, the MCP server
   exposes Viking search/browse alongside admin and memory tools.

3. **Admin-side OpenCode can use it** — The admin instance (#304) gets MCP
   access to Viking for knowledge-aware diagnostics.

### Implementation Plan

#### Phase 2A: Core MCP Server (1.5 days)

Same structure as original plan, with Viking tools added:

```
packages/mcp/
├── src/
│   ├── index.ts
│   ├── server.ts          <- tool + resource registration
│   ├── http-server.ts     <- verbatim from Hyphn
│   └── tools/
│       ├── admin.ts       <- wrap admin API
│       ├── memory.ts      <- wrap memory API
│       ├── viking.ts      <- wrap OpenViking API (search, browse, read)
│       └── channels.ts    <- wrap channel ops
├── Dockerfile
└── package.json
```

**Additional MCP Tools (beyond original list):**

| Tool | Maps To |
|------|---------|
| `openpalm:viking-search` | `POST /api/v1/search/find` on OpenViking |
| `openpalm:viking-browse` | `GET /api/v1/fs/ls` + `GET /api/v1/context/abstract` |
| `openpalm:viking-read` | `GET /api/v1/content/read` |
| `openpalm:viking-add` | `POST /api/v1/resources` |

**MCP Resources (expanded):**
- `openpalm://skills/{name}` — skill docs
- `openpalm://artifacts/{name}` — compose/Caddyfile
- `openpalm://viking/{path}` — proxy to `viking://` URIs (L0/L1/L2 aware)

#### Phase 2B: Component Registry Entry (1 day)

Create `registry/components/mcp/` with `compose.yml`, `.env.schema`, and
`mcp.caddy`:

`registry/components/mcp/compose.yml`:
```yaml
services:
  mcp:
    image: openpalm/mcp:${OP_IMAGE_TAG}
    restart: unless-stopped
    networks:
      - assistant_net
    environment:
      OP_ADMIN_TOKEN: ${OP_ADMIN_TOKEN}
      OP_ADMIN_URL: http://admin:8100
      OP_MEMORY_URL: http://memory:8765
      OPENVIKING_URL: ${OPENVIKING_URL:-}
      MCP_API_KEY: ${MCP_API_KEY:-}
```

`registry/components/mcp/.env.schema`:
```env
OP_ADMIN_TOKEN=    # Admin API token
MCP_API_KEY=             # API key for MCP client auth
OPENVIKING_URL=          # Optional — set if OpenViking component is installed
```

`registry/components/mcp/mcp.caddy`:
```
handle /mcp/* {
  import lan_only
  reverse_proxy mcp:9000
}
```

This uses the component registry:
- `POST /admin/registry/install { name: "mcp", type: "component" }`
- Admin copies compose overlay and caddy snippet to the appropriate locations
- Staging merges compose overlay into the assembled compose
- Caddy snippet added to `channels/lan/mcp.caddy`

#### Phase 2C: Client Config Generation (0.5 days)

`GET /admin/mcp/config` returns pre-filled config for Claude Desktop/Cursor.
Same as original plan.

### Estimated Effort: 3 days (unchanged)

---

## Priority 3: Eval Framework — DEFERRED TO 0.11.0

> **Deferred:** This priority is out of scope for 0.10.0. It is included here as context only. See `../0.11.0/knowledge-system.md` for the implementation plan.

### Goal

Measure assistant quality over time. Eval suites are **shell-executable
scripts** (using the `shell` automation action type) that work standalone via
scheduled automations. When the admin OpenCode instance (#304) is
available, it can invoke these scripts and provide LLM-augmented analysis of
results, but #304 is not required for eval to function.

### Changes from Original Plan

1. **Eval suites are shell-executable scripts first** — Each eval suite is a
   standalone CLI script that can be invoked via the `shell` automation action
   type. This ensures eval runs even without #304. The admin instance
   enhances eval (LLM-graded analysis, natural language reporting) but is not
   a prerequisite.

2. **LLM judge uses connection profiles** — Instead of hardcoding `@anthropic-ai/sdk`,
   the judge grader calls the admin API's existing model proxy
   (`POST /admin/connections/test` or a new `POST /admin/eval/grade`). This
   uses whatever LLM provider is configured, honoring Varlock-managed keys (#300).

3. **Viking-aware eval suite** — Test retrieval quality against OpenViking
   (when installed): seed known resources, query, verify recall.

### Implementation Plan

#### Phase 3A: Eval Types + Runner (2 days)

Create `packages/eval/`:
```
packages/eval/
├── src/
│   ├── types.ts          <- port EvalResult schema from Hyphn
│   ├── graders/
│   │   ├── base.ts       <- port Grader + GraderRegistry
│   │   ├── llm-judge.ts  <- adapted: calls admin LLM proxy, not direct SDK
│   │   └── tool-usage.ts <- new: grade tool selection accuracy
│   ├── runner.ts         <- shell-executable: calls admin API directly
│   ├── regress.ts        <- port regression clustering
│   └── cli.ts            <- CLI entrypoint for shell automation
├── suites/
│   ├── assistant-tools.yaml
│   ├── memory-retrieval.yaml
│   ├── viking-retrieval.yaml  <- new: Viking-specific (skipped if Viking absent)
│   ├── channel-pipeline.yaml
│   └── security.yaml
└── package.json
```

The runner calls the admin API directly using ADMIN_TOKEN (available in the
shell environment via `~/.openpalm/vault/system.env`). No dependency on the admin instance.

#### Phase 3B: Eval Suites (2 days)

| Suite | What It Tests | Runner |
|-------|--------------|--------|
| `assistant-tools` | Prompt -> correct tool selection + response quality | Shell script -> admin API -> assistant session |
| `memory-retrieval` | Add memories -> query -> recall + relevance | Direct memory API calls |
| `viking-retrieval` | Seed resources -> search -> verify L0/L1/L2 quality | Direct Viking API calls (skipped if Viking not installed) |
| `channel-pipeline` | Full E2E: channel -> guardian -> assistant -> response | Via channel API endpoints |
| `security` | Malicious inputs -> guardian blocks | Direct guardian HTTP |

#### Phase 3C: Scheduling + Results (2 days)

1. **Automation (shell fallback)**: `eval-nightly.yml` using `shell` action
   type — runs eval directly without requiring #304:
   ```yaml
   name: Nightly Eval
   schedule: "0 2 * * *"
   action:
     type: shell
     command: "bun run packages/eval/src/cli.ts run --suite all --output ~/.openpalm/data/eval/"
     timeout: 300000
   ```

   When #304 is available, an alternative `assistant` action type automation
   can invoke the same scripts with LLM-augmented analysis:
   ```yaml
   name: Nightly Eval (LLM-enhanced)
   schedule: "0 2 * * *"
   action:
     type: assistant
     content: "Run the full eval suite using packages/eval/src/cli.ts and analyze the results for regressions"
     agent: "admin-eval"
     timeout: 300000
   ```

2. **Admin API**: `GET /admin/eval/results` + `GET /admin/eval/regressions`

3. **Baseline management**: `~/.openpalm/data/eval/baselines/` with diff and
   regression clustering (ported from Hyphn).

### Dependencies
- Connection profiles for LLM judge (no new `@anthropic-ai/sdk` dep needed)
- Shell automation action type (already exists)
- #304 is **not** a hard blocker — enhances eval but not required

### Estimated Effort: 6 days (was 8 — no standalone SDK dep to manage)

---

## Priority 4: MemRL-Inspired Feedback Loop — DEFERRED TO 0.11.0

> **Deferred:** This priority is out of scope for 0.10.0. It is included here as context only. See `../0.11.0/knowledge-system.md` for the implementation plan.

### Goal

Close the loop with **learned utility scores** that update based on actual
outcomes, not just time decay. Memories that help succeed get reinforced;
memories that lead to failures get downweighted (but not necessarily deleted —
MemRL shows some failures encode useful near-correct reasoning).

### Changes from Original Plan

1. **Q-value replaces static confidence** — Instead of `confidence += 0.05` /
   `confidence -= 0.1` / `confidence *= 0.95`, use MemRL's Monte Carlo update:
   ```
   Q_new = Q_old + alpha * (R - Q_old)
   ```
   Where `alpha = 0.1` (learning rate) and `R` is the reward signal:
   - `R = 1.0` — task succeeded and this memory was used
   - `R = 0.5` — task succeeded but memory wasn't directly relevant
   - `R = 0.0` — task failed and this memory was used
   - `R = 0.3` — task failed but memory contributed partial insight

2. **Two-phase retrieval with graceful degradation** (from MemRL):
   - **When Viking is installed**: `assembleContext()` first filters by
     semantic relevance (OpenViking search), then re-ranks by Q-value. This
     prevents high-Q but irrelevant memories from dominating.
   - **When Viking is not installed**: `assembleContext()` uses memory service
     search for semantic filtering, then re-ranks by Q-value. Same two-phase
     logic, memory-only retrieval.

3. **Q-values stored in @openpalm/memory** — Each knowledge resource (whether
   stored as a Viking URI or a memory service ID) gets a companion memory entry
   in @openpalm/memory with `category: "procedural"` and metadata containing
   `{ resourceUri, qValue, usageCount, lastUsed, lastOutcome }`. This leverages
   the existing memory feedback API rather than building a separate scoring
   database. The core learning lifecycle works entirely through the memory
   service without requiring Viking.

4. **Maintenance via shell automations with optional admin OpenCode enhancement**
   (#304) — Learning curation, duplicate detection, and Q-value recalculation
   are implemented as shell-executable scripts. The admin instance can invoke
   these for LLM-augmented reasoning, but the scripts work standalone via
   scheduled `shell` automations.

### Implementation Plan

#### Phase 4A: Q-Value Tracking (2 days)

1. **Usage events in MemoryContextPlugin** — When `assembleContext()` includes a
   knowledge resource in the session context:
   - Log usage to memory metadata: `PUT /api/v1/memories/{id}` with updated
     `usageCount` and `lastUsed`
   - Track which resource URIs (Viking URIs or memory IDs) are active in the
     session

2. **Outcome attribution** — When `tool.execute.after` records success/failure:
   - Cross-reference active resource URIs from this session
   - Compute reward signal `R` based on task outcome
   - Update Q-value: `Q_new = Q_old + 0.1 * (R - Q_old)`
   - Write back via memory API

3. **Q-value metadata schema:**
   ```json
   {
     "resourceUri": "viking://agent/memories/patterns/error-handling",
     "qValue": 0.72,
     "usageCount": 14,
     "lastUsed": "2026-03-15T07:00:00Z",
     "lastOutcome": "success",
     "outcomeHistory": [1.0, 0.0, 1.0, 0.5, 1.0]
   }
   ```
   When Viking is not installed, `resourceUri` is the memory service ID instead
   of a `viking://` URI.

#### Phase 4B: Two-Phase Retrieval (1 day)

Update `assembleContext()`:

1. **Phase 1 — Semantic filter**:
   - If Viking is installed: `POST /api/v1/search/find` on Viking with session
     query. Get top-N candidates by vector similarity.
   - If Viking is not installed: search memory service with session query.
     Get top-N candidates by relevance.
2. **Phase 2 — Q-value rank**: For each candidate, look up Q-value from memory
   metadata. Final score = `0.6 * semantic_score + 0.4 * qValue`. This
   prevents cold-start memories (Q=0.5 default) from being excluded while
   giving proven memories a boost.
3. **Budget allocation** (Viking-enhanced path): L0 for all candidates, L1 for
   top-ranked, L2 only if explicitly requested by tool call. Without Viking,
   full content is returned for top-ranked candidates within the token budget.

#### Phase 4C: Automated Maintenance (2 days)

Maintenance tasks are **shell-executable scripts** that work standalone via
scheduled `shell` automations. The admin OpenCode instance (#304) can
invoke these for LLM-augmented reasoning when available.

**Shell automation scripts** (primary path, no #304 dependency):

| Script | Schedule | What It Does |
|--------|----------|-------------|
| `knowledge-validate.ts` | Weekly Sun 3am | Query memory API for Q-value < 0.2, flag for archival, output report |
| `knowledge-dedupe.ts` | Weekly Sun 4am | Search memory (+ Viking if installed) for duplicate patterns, merge candidates |
| `knowledge-report.ts` | Daily 8am | Generate knowledge health report: top performers, decaying items, new captures |

Delivered as `shell` automations:
```yaml
name: Knowledge Validate
schedule: "0 3 * * 0"
action:
  type: shell
  command: "bun run packages/eval/src/maintenance/knowledge-validate.ts"
  timeout: 120000
```

**Admin instance enhancement** (when #304 is available):

| Automation | Schedule | Admin Instance Prompt |
|-----------|----------|-------------------|
| `knowledge-synthesize` | Monthly 1st 6am | "Analyze agent patterns and cases, synthesize recurring themes into higher-level insights" |
| `knowledge-curate` | Weekly Sun 5am | "Review the knowledge-validate output and make informed retention/archival decisions using LLM reasoning" |

The synthesis task benefits significantly from LLM reasoning and is deferred
until #304 is available, but the validation, dedup, and reporting scripts
run independently.

#### Phase 4D: Admin Visibility (1 day)

1. **Admin API**:
   - `GET /admin/knowledge/stats` — Q-value distribution, usage trends,
     memory counts by category (+ Viking memory counts when installed),
     top/bottom performers
   - `GET /admin/knowledge/health` — overall knowledge system health score

2. **Admin UI**: `KnowledgeTab.svelte` showing:
   - Memory category counts (+ Viking categories when installed)
   - Q-value distribution histogram
   - Recent captures and their utility scores
   - Knowledge health trend over time

### Estimated Effort: 6 days (unchanged, but architecturally simpler)

---

## 0.10.0 Execution Order (Reduced Scope)

> Priorities 2-4 moved to 0.11.0. See `../0.11.0/knowledge-system.md`.

```
#298 Phase 1A: Viking component directory + compose overlay   1 day
#298 Phase 1B: Viking assistant tools                         2 days
#298 Phase 1C: Session memory extraction                      2 days
#298 Phase 1D: Token budget utilities                         1 day
                                                        Total: 6 days
```

**Total: ~6 working days** (reduced from 24 — Priorities 2-4 deferred to 0.11.0)

### Critical Path

```
#301 Component System (must be stable first)
       │
       v
#298 Viking component (1A) ──> Viking tools (1B) ──> Session extraction (1C)
                                                           │
                                                   Token budgets (1D)
```

**Dependency:** The Viking component directory (Phase 1A) requires the
component system (#301 Phase 1-2) to be functional. Viking tools (Phase 1B)
can be developed in parallel as dormant code gated on `OPENVIKING_URL` env var.

---

## Technology Mapping (0.10.0 Scope — Priority 1 Only)

| Concern | Technology | Why |
|---------|-----------|-----|
| Structured knowledge store | **OpenViking** (optional component) | Hierarchical filesystem, L0/L1/L2 tiered loading, session memory extraction, dedup |
| Episodic/preference memory | **@openpalm/memory** (existing) | LLM fact extraction, sqlite-vec — already integrated |
| Secret management | **Varlock** (#300) | Viking API key, embedding keys stored securely via unified secret manager |
| Service delivery | **Component registry** (#301) | OpenViking as installable component, not hardcoded compose entry |
| Config placement | **`~/.openpalm/vault/ov.conf`** | Contains `root_api_key` — lives in vault per fs-mounts-refactor secret boundary |

> **Deferred to 0.11.0:** MCP server component, eval framework, MemRL Q-value feedback loop, and knowledge maintenance automations. These are documented in Priorities 2-4 above for context but are not part of the 0.10.0 deliverable.

## Portable Code Summary (0.10.0 Scope)

| Source (Hyphn) | Target (OpenPalm) | Status |
|---|---|---|
| `lib/tokens/token-budget.ts` | `assistant-tools/src/context/tokens.ts` | **Keep** — copy |
| `disclose/src/lib/budget.ts` | `assistant-tools/src/context/budget.ts` | **Keep** — copy |
| agentikit `openviking.ts` | `assistant-tools/src/lib/viking.ts` | **Keep** — port client |

> MCP and eval portable code (Hyphn MCP server, heval-bun graders) deferred to 0.11.0.

**Portable LOC for 0.10.0: ~800** (token budgets + Viking client only).
