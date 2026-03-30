# `mem` — Deep Research Review of a File-First Epistemic Memory CLI for Agents

## Research scope and success criteria

This review evaluates the proposed `mem` CLI as an “epistemic memory layer” that *extends* OpenViking with capabilities repeatedly shown to matter for long-horizon agents: epistemic separation (facts vs experiences vs opinions vs synthesized observations), multi-strategy retrieval fusion, temporal validity/knowledge updates, entity-relationship reasoning, and learning/utility weighting. The goal is to validate which claims are grounded in **repeatable, benchmarkable outcomes**, identify hidden complexity or invalid comparisons, and propose corrections that preserve the project’s constraints: **CLI-first, lightweight, portable, file-based as source of truth**, and **no dedicated database server** beyond what OpenViking already requires. citeturn30view0turn31view0turn32view1turn25view0turn27view0

“Lightweight” here must be interpreted operationally: minimal moving parts at runtime, no extra long-running services for the memory layer, rebuildable derived indexes, and simple failure modes (e.g., deleting the index should not corrupt canonical memory). Your design intent—OpenViking for canonical storage plus an embedded SQLite index for relational queries—fits that definition, with two important caveats addressed later: (1) cost/complexity of LLM-based extraction during rebuild and (2) cross-platform SQLite/WAL ergonomics in Bun. citeturn7search0turn7search30turn28view2turn7search16

## What recent, benchmark-backed evidence says works

The proposal’s core thesis—“filesystem hierarchy is a strong substrate, but we need epistemic + temporal + multi-strategy retrieval + entity reasoning”—is broadly consistent with the last ~18 months of agent-memory research and tooling, but several assumptions must be tightened so they remain verifiable.

### Epistemic separation is empirically high-leverage, but only when extraction is structured and audited

The strongest evidence in your reference set is the **four-network epistemic decomposition** popularized by Hindsight, which explicitly distinguishes *world facts*, *agent experiences*, *opinions with confidence*, and *observations as synthesized, preference-neutral entity summaries*. The Hindsight paper describes this as a first-order architectural abstraction (four logical networks plus retain/recall/reflect), and it defines opinion entries as confidence-scored beliefs and observations as entity summaries synthesized from multiple facts. citeturn31view0turn31view3

Two validation insights matter for your `mem` design:

1) Hindsight’s recall is not “vector search plus prompt.” It is a *systematic pipeline* that uses parallel retrieval channels and fuses them, then enforces token budgets. citeturn32view1turn31view4  
2) The Hindsight design makes the *epistemic type* a **stored attribute** of each memory item—not an emergent prompt convention—so it becomes measurable (classification accuracy, confusion matrices, downstream QA impact). citeturn31view0turn20view0

**Implication for `mem`:** your epistemic tagger must be treated as a measurable subsystem with an audit loop (you already propose `mem audit`). The missing requirement is that the system must store enough structured provenance to re-evaluate disagreements (input text, timestamp, classifier version, examples used), otherwise audits devolve into opaque “LLM disagreed with itself.” citeturn31view0turn24view0

### Multi-strategy retrieval + rank fusion is well-founded and reproducible

Your proposal to use Reciprocal Rank Fusion (RRF) is very defensible—both academically and practically. The original RRF paper reports that **k = 60 was near-optimal** in pilot experiments and that performance was not overly sensitive to k, which is why k≈60 has become a common default. citeturn8search0

Hindsight implements “four-way parallel retrieval (semantic, keyword/BM25, graph, temporal)” followed by **RRF** and then an optional cross-encoder reranker; it explicitly motivates rank fusion because it avoids score calibration across heterogeneous retrievers. citeturn32view1turn32view2

**Implication for `mem`:** RRF is a good choice to keep the implementation small and deterministic. However, “four strategies” should be defined in terms of *available primitives* in OpenViking and SQLite, otherwise you risk building “four strategies” that are actually the same underlying signal. Conveniently, OpenViking already exposes distinct retrieval primitives via API: fast semantic `find()` and regex-based `grep`, and a more complex `search()` that includes LLM-driven intent analysis and reranking. citeturn14view0turn18view0turn17view0turn13view1

### Temporal validity and knowledge updates are non-negotiable, but filesystem timestamps are not enough

Multiple sources agree that “temporal reasoning” and “knowledge updates” are major failure modes in long-horizon memory.

LongMemEval was designed specifically to test **knowledge updates** and **temporal reasoning** (among other abilities), and the dataset format encodes evidence sessions/turns so recall can be evaluated directly. citeturn9search0turn24view0

Zep/Graphiti argues for maintaining a timeline of facts and relationships, including validity intervals, and it describes extracting temporal validity (e.g., `valid_at` / `invalid_at`) for relationships. citeturn25view0turn25view0

OpenViking also acknowledges recency as a first-class signal in retrieval scoring: its `find()` scoring combines semantic similarity with a “hotness” component based on `active_count` and recency (`updated_at`). citeturn16view3turn18view0

**Implication for `mem`:** your “filesystem bitemporal approximation” is pointed in the right direction (store ingestion time + event time/valid interval in frontmatter), but your current draft over-relies on file timestamps and LLM conflict resolution. For benchmarked temporal correctness, you need explicit, queryable fields: `event_time` (or `valid_from`/`valid_until`) and `ingested_at`—and you need to ensure they survive moves, edits, and rebuilds. citeturn24view0turn25view0turn28view2

### Entity graphs help, but “graph infrastructure” is the typical portability tax

Your “SQLite entity graph as derived index” aligns with the portability constraint.

Graphiti’s documentation explicitly steers users toward **Neo4j** setup as the simplest path, reinforcing that many knowledge-graph memory systems still assume a dedicated graph database service. citeturn6search22turn6search19

Hindsight explicitly notes a PostgreSQL dependency in its setup documentation, and its retrieval design includes BM25 over a GIN index (a Postgres-associated full-text index), reinforcing the “heavier infra” profile even when developer experience is streamlined. citeturn5search4turn32view0

Mem0’s paper describes a two-phase “extraction then update” pipeline, and its graph variant stores memories as a directed labeled graph with conflict detection and invalidation. That design is conceptually close to your SQLite-derived entity index, but Mem0’s update operations include DELETE for contradicted memories—something your proposal avoids (correctly, for historical reasoning). citeturn27view0turn27view0turn25view0

**Implication for `mem`:** an embedded SQLite index is a reasonable compromise if you sharply constrain graph requirements to what SQLite does well (indexed lookups, joins, recursive CTE traversal with small hop counts). SQLite’s `WITH RECURSIVE` support is official and mature. citeturn7search1turn28view2

## Proposal audit against OpenViking’s current capabilities

A critical part of validating assumptions is identifying what OpenViking already provides—because duplicating it will both increase complexity and muddy evaluation claims.

### Areas where the proposal is aligned with OpenViking

OpenViking’s positioning matches your foundational assumption: treat context as a navigable virtual filesystem with `viking://` URIs, and rely on hierarchical abstraction layers L0/L1/L2 for token efficiency. The OpenViking docs define L0 as ~100 tokens, L1 as ~2k tokens, L2 as full detail. citeturn13view0turn30view0

OpenViking also reports a concrete LoCoMo10-based evaluation for an OpenClaw plugin setup, including explicit experimental groups and token-cost deltas, and it documents removal of LoCoMo category 5 due to missing ground truth. citeturn30view0turn23view0

These are good anchors for your own baselines, because they are already in the “OpenViking ecosystem.”

### Areas where the proposal duplicates or conflicts with OpenViking primitives

**Retrieval orchestration overlaps.** Your draft treats extraction of multiple strategies and progressive loading as primarily a `mem` responsibility. But OpenViking already has:

- `find()` (fast semantic search) and `search()` (session-aware retrieval with LLM intent analysis generating 0–5 typed queries and reranking). citeturn13view1turn18view0turn14view0  
- `grep` as a native regex/pattern search API. citeturn17view0turn14view0  

This matters because, if `mem` uses OpenViking `search()` internally, you’re stacking LLM analysis on top of your own query analyzer, which undermines “lightweight” and complicates benchmarking (two LLMs might be involved before answering). The simplest “Occam” alignment is:

- Use OpenViking `find()` as your semantic channel.
- Use OpenViking `grep` as your lexical/keyword channel.
- Apply `mem`-specific temporal/entity channels as *post-filters and candidate expanders* (not as separate heavyweight retrieval pipelines).
- Fuse with RRF. citeturn18view0turn17view0turn8search0turn32view2

**OpenViking already has a URI relation graph.** OpenViking exposes `link()` / `relations()` enable building a “context graph” between URIs for navigation and retrieval support. citeturn15view0turn15view1  
This is not the same as an entity-relationship graph, but it creates a design decision: which graph is canonical for which purpose?

- OpenViking relations are *document-to-document* links (URI graph).
- Your SQLite graph is *entity-to-entity* links, plus *entity-to-URI* mentions.

If you use both, you should define a one-way projection to avoid confusion: `mem` may optionally write OpenViking URI links for provenance/citation (“this observation summarizes these facts”), but the entity graph remains a derived local index. citeturn15view0turn31view0

**Relevance scoring overlaps with OpenViking hotness.** OpenViking computes scores blending semantic similarity and a “hotness_score” from `active_count` and recency. citeturn16view3turn18view0  
If `mem` adds another multiplicative relevance score, you can accidentally double-count recency/usage and destabilize ranking. A lightweight approach is to store a single `utility_weight` in your frontmatter and incorporate it in rank fusion only after RRF (small, bounded effect). This keeps ranking interpretable and auditable.

## Design flaws and gaps in the current PRD draft

These are the major issues that, if unaddressed, will either (a) break portability/lightweight goals or (b) make benchmark claims non-reproducible.

### Index rebuild must not require re-running LLM extraction across all files

Your PRD says: if SQLite is deleted, `mem index rebuild` re-scans OpenViking and reconstructs the entity graph; the provided pseudocode uses an LLM call per file. That is a *recovery mechanism* in the draft, but it still violates “lightweight and portable” in practice because rebuild cost becomes unbounded and depends on external model availability.

This is fixable with one design change:

**Make extracted structure a first-class part of the canonical file content.**  
At `retain` time, store the extracted entities and relationships (and ideally atomic propositions for world facts) in YAML frontmatter. Then rebuild becomes a pure parse-and-insert operation with no LLM calls. The LLM is used only during ingestion (and optionally during “deep re-index” audits).

This aligns with how benchmark datasets encode evidence labels: you want deterministic mappings from retrieved “memories” back to source turns/sessions without re-running a model. LongMemEval explicitly provides evidence session IDs and `has_answer` labels for recall evaluation. citeturn24view0turn23view0

### LLM-only conflict resolution is non-deterministic and hard to benchmark

Your supersession decision is currently: “entity overlap → LLM conflict detector → supersede/coexist”. This is not reliably reproducible across model versions and prompts, and it is difficult to validate in temporal benchmarks.

A more benchmarkable approach is: supersession is triggered by **colliding fact keys** over structured propositions.

This is aligned with what PropMem-style evaluations found helpful: extract atomic propositions with resolved dates at ingestion time, then apply deterministic update/penalty rules for older conflicting facts. citeturn21view0

Even Mem0’s update pipeline makes the update operation explicit (ADD/UPDATE/DELETE/NOOP), but because it allows DELETE, historical correctness can degrade; your invalidation-not-deletion principle is better for temporal benchmarks. citeturn27view0turn25view0

### The evaluation plan needs stronger guardrails to be “true comparisons”

Your PRD proposes LoCoMo and LongMemEval parity targets, but published numbers across systems often vary because the evaluation pipeline varies: LLM backbone, embeddings, token budgets, judge prompts, and even which LoCoMo categories are included. The LoCoMo maintainers’ own issue tracker documents that LLM-as-a-judge can be inconsistent and can reward over-specific hallucinated answers when evidence is not provided to the judge. citeturn29view0turn23view0

Also, LoCoMo10 is explicitly a **subset** of an earlier 50-conversation release, chosen for cost-effective evaluation; if you compare to older “LoCoMo (50)” numbers without declaring the subset, you will produce misleading claims. citeturn23view0turn22view0

### SQLite + Bun portability requires explicit operational rules

Using SQLite in WAL mode is correct for read-heavy workloads, but SQLite WAL has one writer at a time, and WAL file semantics can interact with filesystem behavior. SQLite’s own WAL documentation states explicitly: “there can only be one writer at a time.” citeturn28view2

More importantly for your portability goal, there is an open Bun issue reporting that on Windows, SQLite database files can remain locked after closing when WAL mode is enabled, preventing deletion. citeturn7search16

This doesn’t kill the design—but it changes how you should implement “rebuild”: **never delete the DB file as the rebuild mechanism**; instead, truncate tables inside the DB (transactionally) and reinsert. That both avoids the Windows delete path and simplifies concurrency.

## Recommended lightweight final design

The aim is to preserve your vision—filesystem-native canonical memory + embedded relational index—while making rebuilds deterministic, reducing LLM calls, aligning with OpenViking primitives, and making evals defensible.

### Canonical storage remains OpenViking, but the file format becomes “rebuild-complete”

Keep OpenViking as the source of truth. Store memory items as Markdown (or plain text) in a `viking://agent/mem/` namespace (or your chosen one), but change the frontmatter contract:

**Required frontmatter fields for every memory item**
- `id` (stable UUID or content-addressed hash)
- `epistemic_type` ∈ {world, experience, opinion, observation}
- `ingested_at` (ISO 8601)
- `event_time` or `valid_from` / `valid_until` (ISO 8601; may be null)
- `source` (where it came from: session ID, tool run ID, URL, etc.)
- `entities` (canonical slugs)
- `relations` (typed edges as triples, even if empty)
- `propositions` (for world facts only; see below)

This single change makes:
- entity index rebuild LLM-free,
- temporal eval reproducible,
- retrieval-evidence mapping deterministic (critical for LoCoMo/LongMemEval recall metrics). citeturn23view0turn24view0

### Replace “classification only” with “atomic proposition extraction” for world facts

The MemEval/PropMem analysis argues that “atomic propositions instead of large chunks” improves retrieval slot efficiency and temporal consistency, especially when dates are resolved at ingestion. citeturn21view0

You can keep the four epistemic classes, but for `world` memories, store **one or more atomic propositions** in frontmatter:

- `subject` (entity slug)
- `predicate` (normalized verb / attribute key)
- `object` (entity slug or literal string)
- `qualifiers` (optional: units, modality, scope)
- `valid_from` / `valid_until` (optional)
- `confidence` (optional)

Then supersession becomes deterministic: a new proposition supersedes older propositions with the same `(subject, predicate, scope)` key when the object changes, with `valid_until` set. You still keep the old record (“invalidate, don’t delete”), matching the temporal-graph approach used by Zep/Graphiti and avoiding Mem0’s deletion risk. citeturn25view0turn27view0

### Retrieval architecture: leverage OpenViking primitives and keep fusion simple

A minimal, high-signal retrieval pipeline that remains faithful to the evidence:

1) **Semantic channel:** OpenViking `find()` scoped to your memory directory. citeturn18view0turn14view0  
2) **Lexical channel:** OpenViking `grep` with a safe regex derived from the query (plus optional quoted identifiers). citeturn17view0  
3) **Entity channel:** local SQLite:
   - resolve query mentions to entity slugs (alias table)
   - collect mention URIs (direct)
   - optional hop expansion (1–2 hops default) via recursive CTE. citeturn7search1turn28view2  
4) **Temporal handling:** do not treat temporal as a separate retriever initially. Instead:
   - parse query time constraints (deterministic parser or simple rules)
   - apply a *post-filter / score boost* to candidates based on `valid_from/valid_until` / `event_time`.

Then **RRF** merges ranked lists. This mirrors Hindsight’s logic but remains smaller because:
- you skip cross-encoder reranking by default (YAGNI; add later behind a flag),
- you reuse OpenViking’s own scoring and hotness within the semantic channel. citeturn32view2turn8search0turn16view3turn18view0

### SQLite index contract: keep it strictly derived, small, and cross-platform safe

Use SQLite exactly as you propose, but incorporate two operational constraints from SQLite/Bun realities:

- Always enable WAL for read/write concurrency, but assume **single writer** and batch writes accordingly. citeturn28view2  
- Avoid deleting the DB file in normal operations (especially rebuild); truncate tables instead to avoid Windows WAL deletion pitfalls reported in Bun. citeturn7search16  
- Use `busy_timeout` and short transactions to avoid `SQLITE_BUSY` edge cases; SQLite itself warns that WAL can still hit busy situations and that apps should be prepared. citeturn28view2turn28view2

### Disposition and scoring: keep, but restrict to auditable mechanisms

Disposition-conditioned reflection is a reasonable feature because Hindsight shows disposition profiles can shape consistent reasoning, but it should be strictly scoped:

- Only apply disposition in `reflect`, not in `recall`.
- Store the disposition config as a plain file (OpenViking or local config), version it, and include it in evaluation logs so results are attributable. citeturn31view4

For scoring (“learned relevance”), keep only explicit, auditable signals at first:

- `mem score boost|penalize <uri>` modifies `utility_weight` in frontmatter.
- Optionally decay `utility_weight` over time, but keep it bounded and monotonic toward 1.0 so ranking doesn’t collapse.
- Avoid heuristic “auto-boost if user didn’t correct” as a default; it can reinforce hallucinations and is not benchmarkable.

This preserves the self-improving intent without drifting into untestable RL-style claims.

## Evaluation and benchmarking that produce valid, repeatable comparisons

Your evaluation section is directionally strong but needs rigor around *which metrics are authoritative* and *what controls are required* for fair comparisons.

### Use dataset-provided evidence labels to evaluate recall directly

Both flagship benchmarks you cite provide evidence annotations that can be used to evaluate recall quality, not just answer quality:

- LoCoMo10 JSON includes QA items with an `evidence` list of dialog IDs “when available,” plus generated observations/session summaries used for RAG baselines. citeturn23view0  
- LongMemEval provides `answer_session_ids` (evidence sessions) and marks evidence turns with `has_answer: true`, explicitly “used for turn-level memory recall accuracy evaluation.” citeturn24view0  

**Therefore, your eval harness should treat retrieval metrics as first-class:**
- Recall@K over evidence sessions/turns
- MRR for first evidence hit
- “Evidence coverage” (fraction of evidence sessions hit)
- Temporal correctness (did you retrieve *current* vs *superseded* facts when asked)

This produces repeatable outcomes even if LLM judging is noisy.

### Fix the known LoCoMo LLM-judge validity problems

LoCoMo’s issue tracker documents that LLM-as-a-judge:
- can be inconsistent for list containment,
- can reward over-specific answers because the judge prompt does not include supporting evidence. citeturn29view0  

To address this, your harness should implement an “evidence-aware judge” mode:

- Provide the judge: (question, gold answer, model answer, **retrieved evidence excerpts + URIs + timestamps**).
- Add a strict instruction: “Mark correct only if the answer is supported by the evidence; penalize unsupported specifics.”

Even better: for categories with structured answers (names, dates, enumerations), compute token-F1 / exact match style metrics, and reserve LLM judging primarily for inferential questions. (This aligns with the general direction of LongMemEval’s “oracle retrieval” file and evidence labeling.) citeturn24view0turn9search0

### Declare and enforce pipeline controls for fairness

To compare against systems like Mem0, Zep, and Hindsight, pipeline controls must be explicit. Variations in embedding model, LLM backbone, token budgets, ingestion granularity, and whether category 5 is excluded can dominate results.

OpenViking’s own LoCoMo10 report explicitly removes category 5 “without ground truth” and gives full experimental group detail (memory-core toggles, token totals). You should mirror this transparency. citeturn30view0turn23view0

LongMemEval’s repo also notes dataset cleanups and provides multiple dataset variants (`oracle`, `s_cleaned`, `m_cleaned`), and it provides an official evaluation script workflow. Your harness should log exactly which file variant was used and why. citeturn24view0

### Baselines that are actually comparable to your architecture

A defensible baseline ladder for `mem` that minimizes “apples vs oranges”:

1) **Full-context baseline** (where feasible): directly feed full histories; this is explicitly included in LongMemEval and LoCoMo evaluations and provides an upper bound on “no retrieval, just context stuffing,” albeit expensive. citeturn24view0turn23view0  
2) **OpenViking-only baseline:** OpenViking `find()` over your memory directory (no epistemic separation, no SQLite entity expansion). citeturn18view0turn14view0  
3) **OpenViking hybrid baseline:** OpenViking `find()` + `grep`, fused with RRF (no entity graph). citeturn17view0turn8search0  
4) **`mem` full pipeline:** epistemic + entity expansion + temporal post-filter + RRF.  
5) Optional external-system adapters (only if you can run them locally with reproducible configs): Mem0 OSS, Hindsight OSS, Graphiti. For these, report them as “separate systems under identical harness controls,” not as direct “SOTA” claims unless you actually rerun them.

This isolates what you’re adding vs what OpenViking already does.

## Detailed implementation plan with complexity containment

The biggest risk to meeting “~1,200 LOC, clean, YAGNI” is overbuilding LLM-dependent ingestion and overcomplicating temporal/entity resolution. The plan below is structured to keep the runtime small and push heavy experimentation into the eval harness.

### Phase A: Minimal viable, benchmarkable memory layer

Deliverables:
- CLI scaffolding (Bun) + config (XDG-aware paths; cross-platform)
- OpenViking HTTP client (only endpoints you need: `fs/*`, `content/*`, `search/find`, `search/grep`) citeturn14view0turn17view0turn18view0  
- `retain` that writes a file with complete frontmatter contract (including extracted entities/relations/propositions)
- Extraction LLM call can be a single “all-in-one structured extraction” per retained item (type + entities + propositions) to keep ingestion to 1 call in the default path
- SQLite schema + incremental updates in a single transaction per retain (WAL + busy_timeout)

Exit criteria:
- Rebuild index from files with **zero LLM calls**
- LoCoMo10 retrieval metrics (Recall@K over evidence dialog IDs) are computed end-to-end.

### Phase B: Deterministic temporal + supersession

Deliverables:
- supersession based on proposition-key collisions (no LLM conflict detector in default path)
- `timeline` and `valid-only` recall mode, computed from explicit validity fields (not file timestamps)
- “deep audit” command that re-extracts propositions for a sample and reports drift (optional LLM use)

Exit criteria:
- LongMemEval knowledge-update and temporal-reasoning recall metrics reported using evidence-session labels. citeturn24view0turn9search0

### Phase C: Entity expansion via SQLite, bounded hops

Deliverables:
- alias-resolved entity lookup
- recursive traversal query (bounded depth 1–2 default)
- entity-scoped retrieval that expands candidate URIs, then relies on OpenViking for content reads

Exit criteria:
- LoCoMo multi-hop and LongMemEval multi-session evidence recall improves vs Phase A baseline.

### Phase D: Evaluation harness and ablations as a first-class artifact

Deliverables:
- `mem eval locomo` and `mem eval longmemeval` runners that:
  - ingest conversations deterministically (timestamps preserved)
  - compute retrieval metrics from evidence labels
  - compute answer metrics (token-F1 where applicable + evidence-aware judge mode)
  - output JSON with full config fingerprints (model IDs, dataset variant, k, topK, budgets)
- Ablation matrix runs (no-entity, no-grep, no-epistemic routing, etc.), mirroring Hindsight-style “channel contribution” logic. citeturn32view1turn8search0

Exit criteria:
- A run is reproducible from a single command + a pinned config file.

## Code samples for the most complex parts

### Reciprocal Rank Fusion with stable dedup and bounded post-weighting

```ts
// rrf.ts
export type RankedList<T extends string> = Array<{ id: T }>;

export interface RrfOptions {
  k: number; // e.g. 60
  // Optional bounded post-weighting (e.g., utility_weight in [0.5, 2.0])
  weightById?: (id: T) => number;
}

// Rank-based fusion: no normalization needed.
export function rrfFuse<T extends string>(
  lists: Array<RankedList<T>>,
  opts: RrfOptions,
): Array<{ id: T; score: number }> {
  const k = opts.k;
  const acc = new Map<T, number>();

  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i].id;
      const rank = i + 1; // 1-based
      const inc = 1 / (k + rank);
      acc.set(id, (acc.get(id) ?? 0) + inc);
    }
  }

  const out: Array<{ id: T; score: number }> = [];
  for (const [id, base] of acc) {
    const w = opts.weightById ? opts.weightById(id) : 1.0;
    out.push({ id, score: base * w });
  }

  // Deterministic ordering: score desc, then id asc.
  out.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
  return out;
}
```

This is directly aligned with (a) the original RRF loop and (b) Hindsight’s rationale for rank-based fusion. citeturn8search0turn32view2

### SQLite entity traversal with WAL-safe ergonomics in Bun

```ts
// entity_db.ts
import { Database } from "bun:sqlite";

export function openEntityDb(path: string): Database {
  const db = new Database(path);

  // WAL improves read/write concurrency; still single-writer overall.
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 2500;");

  return db;
}

export function initSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS entities (
      slug TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      summary TEXT,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS relationships (
      source TEXT NOT NULL,
      relation TEXT NOT NULL,
      target TEXT NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      source_uri TEXT NOT NULL,
      PRIMARY KEY (source, relation, target, source_uri),
      FOREIGN KEY (source) REFERENCES entities(slug),
      FOREIGN KEY (target) REFERENCES entities(slug)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS mentions (
      entity_slug TEXT NOT NULL,
      uri TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (entity_slug, uri),
      FOREIGN KEY (entity_slug) REFERENCES entities(slug)
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_mentions_uri ON mentions(uri);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target);`);
}

export function traverseUris(
  db: Database,
  startSlug: string,
  maxHops: number,
): string[] {
  // Bounded traversal using a recursive CTE (SQLite-supported).
  const rows = db.query(`
    WITH RECURSIVE walk(slug, depth) AS (
      SELECT ?1, 0
      UNION
      SELECT
        CASE
          WHEN r.source = w.slug THEN r.target
          ELSE r.source
        END,
        w.depth + 1
      FROM walk w
      JOIN relationships r
        ON (r.source = w.slug OR r.target = w.slug)
      WHERE w.depth < ?2
        AND (r.valid_until IS NULL) -- treat NULL as current
    )
    SELECT DISTINCT m.uri
    FROM walk w
    JOIN mentions m ON m.entity_slug = w.slug;
  `).all(startSlug, maxHops) as Array<{ uri: string }>;

  return rows.map(r => r.uri);
}
```

This leans on three verified facts:
- `bun:sqlite` is a built-in SQLite driver in Bun. citeturn7search0turn7search30  
- SQLite supports recursive CTEs. citeturn7search1  
- WAL allows concurrent readers with a single writer, and SQLite explicitly states “only one writer at a time.” citeturn28view2  

### Deterministic supersession based on proposition keys

```ts
// supersession.ts
export interface Proposition {
  subject: string;   // entity slug
  predicate: string; // normalized key, e.g. "manages_team"
  object: string;    // entity slug or literal
  scope?: string;    // optional disambiguator, e.g. "api"
  valid_from?: string;  // ISO 8601
  valid_until?: string; // ISO 8601 | undefined
}

export function propKey(p: Proposition): string {
  return `${p.subject}::${p.predicate}::${p.scope ?? ""}`;
}

export function detectSupersessions(
  existing: Proposition[],
  incoming: Proposition[],
): Array<{ oldProp: Proposition; newProp: Proposition }> {
  const byKey = new Map<string, Proposition[]>();
  for (const p of existing) {
    byKey.set(propKey(p), [...(byKey.get(propKey(p)) ?? []), p]);
  }

  const supersedes: Array<{ oldProp: Proposition; newProp: Proposition }> = [];
  for (const np of incoming) {
    const key = propKey(np);
    const candidates = byKey.get(key) ?? [];
    for (const op of candidates) {
      if (!op.valid_until && op.object !== np.object) {
        supersedes.push({ oldProp: op, newProp: np });
      }
    }
  }
  return supersedes;
}
```

This eliminates an LLM-dependent conflict detector in the default path while preserving invalidation-not-deletion (a property emphasized in temporal graph approaches). citeturn25view0turn24view0

---

**Bottom line:** The proposed direction is technically sound and consistent with benchmark-backed patterns (epistemic separation, RRF fusion, explicit temporal validity, entity expansion), but to make the system truly lightweight and the evaluations truly comparable you should (1) make memory files rebuild-complete (store extracted structure in frontmatter), (2) make supersession deterministic over proposition keys, (3) treat OpenViking `find()` + `grep` as your core retrieval primitives, and (4) redesign the eval harness around dataset-provided evidence labels and evidence-aware judging to avoid known LoCoMo evaluation pitfalls. citeturn23view0turn24view0turn29view0turn18view0turn17view0turn32view2turn8search0