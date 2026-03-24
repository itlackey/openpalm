# PRD Extension

In addition to the features in the PRD, we need these three features: a small metadata filter system, a configurable reconcile/update policy, and an optional raw transcript ingestion mode.

All three can be added **without changing the core architecture**:

* keep OpenViking as source of truth,
* keep SQLite as a derived entity index,
* keep `mem retain` / `mem recall` as the primary surface.

The cheapest path is:

* **metadata filter system:** a small JSON filter object applied after retrieval and before final ranking/output
* **configurable reconcile/update policy:** an optional markdown file or inline string passed to the reconcile prompt
* **raw transcript ingestion mode:** a flag on `retain` that stores transcript records and optionally extracts facts secondarily

That keeps the design file-first, CLI-first, and portable.

---

## 1. Small metadata filter system

### What to copy from Mem0

Mem0’s metadata filtering supports equality, comparisons, membership, substring matching, and boolean composition such as `AND` / `OR` / `NOT`. That is useful, but the full surface is more than you need for a lightweight CLI tool. ([Mem0][1])

### Minimum viable version

Do **not** implement Mem0’s whole filter language.

Implement only:

* `eq`
* `ne`
* `in`
* `nin`
* `gte`
* `lte`
* `contains`
* top-level `AND` and `OR`

Skip for now:

* `gt`, `lt` as separate ops if `gte` / `lte` cover the need
* `NOT`
* wildcard `*`
* deep nested boolean trees
* backend pushdown into OpenViking search

### Why this is enough

Your proposal already has:

* type filtering,
* temporal validity,
* entity traversal,
* structured YAML frontmatter.

So the missing piece is just a **deterministic post-filter** over memory metadata. You do not need a fancy query planner.

### Where it fits

Apply filters in `mem recall` after strategy collection and before final scoring output:

1. gather candidate URIs from semantic / keyword / temporal / entity
2. read frontmatter for candidates
3. apply metadata filter predicate
4. fuse/rank remaining results

That is the least invasive path.

### CLI shape

```bash
mem recall "deploy failures" \
  --filter '{"AND":[{"type":{"eq":"experience"}},{"confidence":{"gte":0.7}},{"context":{"contains":"staging"}}]}'
```

Also support a file:

```bash
mem recall "deploy failures" --filter-file ./filters/staging.json
```

### Suggested filter schema

```json
{
  "AND": [
    { "type": { "eq": "experience" } },
    { "confidence": { "gte": 0.7 } },
    { "context": { "contains": "staging" } }
  ]
}
```

### Implementation effort

Small.

You need:

* a parser/validator for a small JSON object,
* a metadata predicate evaluator,
* a hook in recall.

### Estimated code

About **120–180 lines**.

### Minimal TypeScript sample

```ts
type Scalar = string | number | boolean | null;
type Op =
  | { eq?: Scalar; ne?: Scalar; in?: Scalar[]; nin?: Scalar[]; gte?: number; lte?: number; contains?: string };

type FilterNode =
  | Record<string, Op>
  | { AND: FilterNode[] }
  | { OR: FilterNode[] };

function matchesOp(value: unknown, op: Op): boolean {
  if ("eq" in op && value !== op.eq) return false;
  if ("ne" in op && value === op.ne) return false;
  if ("in" in op && !op.in?.includes(value as Scalar)) return false;
  if ("nin" in op && op.nin?.includes(value as Scalar)) return false;
  if ("gte" in op && !(typeof value === "number" && value >= op.gte!)) return false;
  if ("lte" in op && !(typeof value === "number" && value <= op.lte!)) return false;
  if ("contains" in op) {
    if (typeof value === "string") {
      if (!value.includes(op.contains!)) return false;
    } else if (Array.isArray(value)) {
      if (!value.some((v) => String(v).includes(op.contains!))) return false;
    } else {
      return false;
    }
  }
  return true;
}

export function matchesFilter(meta: Record<string, unknown>, filter: FilterNode): boolean {
  if ("AND" in filter) return filter.AND.every((f) => matchesFilter(meta, f));
  if ("OR" in filter) return filter.OR.some((f) => matchesFilter(meta, f));

  return Object.entries(filter).every(([field, op]) => matchesOp(meta[field], op as Op));
}
```

### Recommendation

Store no extra index for this at first. Just read frontmatter from the candidate set. That keeps it simple and avoids premature complexity.

---

## 2. Configurable reconcile/update policy

### What to copy from Mem0

Mem0’s update policy prompt explicitly frames reconciliation as `ADD`, `UPDATE`, `DELETE`, or `NONE`, with examples and traceable decisions. That is a strong pattern and worth borrowing. ([Mem0][2])

### Minimum viable version

Do **not** build a full policy engine.

Add:

* one optional markdown file or inline string,
* one reconcile prompt builder,
* one structured output schema.

Use the policy only in retain-time reconciliation.

### Proposed config

In config:

```json
{
  "reconcile": {
    "policy_file": "~/.config/mem/reconcile-policy.md",
    "policy_inline": "",
    "enabled": true
  }
}
```

CLI overrides:

```bash
mem retain "Bob manages the API team now" --policy-file ./policy.md
mem retain "Bob manages the API team now" --policy "Prefer UPDATE over DELETE for preference changes."
```

### Prompt model

Base prompt:

* describe default behavior,
* append optional markdown policy,
* ask model to return one of:

  * `ADD`
  * `UPDATE`
  * `DELETE`
  * `NONE`
  * optionally `SUPERSEDE`

Because your proposal already uses supersession, I would map:

* `UPDATE` for same-memory edit,
* `DELETE` for explicit invalidation/removal,
* `SUPERSEDE` for temporal replacement of a world fact,
* `NONE` for duplicates or irrelevant changes.

That is cleaner than forcing every temporal change into plain `UPDATE`.

### Why markdown file is the right minimum

It is dead simple:

* inspectable,
* versionable,
* optional,
* no extra DSL.

### Example policy file

```md
# Reconcile Policy

Prefer conservative updates.

Rules:
- Use NONE if the new fact is semantically the same as an existing memory.
- Use SUPERSEDE for world facts that replace older time-sensitive facts.
- Use UPDATE for richer phrasing of the same still-valid memory.
- Use DELETE only for explicit removals or hard contradictions that should no longer remain active.
- Never delete experiences; preserve them as historical records.
- Prefer keeping both memories if uncertainty is high.
```

### Output schema

```json
{
  "decision": "SUPERSEDE",
  "target_id": "mem_2026_001",
  "replacement_text": "Bob manages the API team",
  "reasoning": "New world fact replaces previous current manager fact",
  "confidence": 0.86
}
```

### Implementation effort

Small to medium.

You need:

* policy loader,
* prompt builder,
* one decision applier.

### Estimated code

About **100–160 lines** on top of your existing conflict detection path.

### Minimal TypeScript sample

```ts
type ReconcileDecision = "ADD" | "UPDATE" | "DELETE" | "NONE" | "SUPERSEDE";

interface ReconcileResult {
  decision: ReconcileDecision;
  target_id?: string;
  replacement_text?: string;
  reasoning: string;
  confidence: number;
}

function buildReconcilePrompt(args: {
  policyMd?: string;
  incoming: string;
  existing: Array<{ id: string; type: string; text: string; metadata?: Record<string, unknown> }>;
}): string {
  const policy = args.policyMd?.trim()
    ? `\nOptional policy:\n${args.policyMd}\n`
    : "";

  return `
You are reconciling a new memory against existing memories.

Allowed decisions:
- ADD: store as a new memory
- UPDATE: replace text/metadata of an existing still-current memory
- DELETE: mark an existing memory deleted/inactive
- NONE: no change
- SUPERSEDE: keep history but replace an old current fact with a new current fact

${policy}

Incoming memory:
${args.incoming}

Existing memories:
${JSON.stringify(args.existing, null, 2)}

Return JSON only:
{
  "decision": "ADD|UPDATE|DELETE|NONE|SUPERSEDE",
  "target_id": "optional existing id",
  "replacement_text": "optional",
  "reasoning": "brief explanation",
  "confidence": 0.0
}
`.trim();
}
```

### Recommendation

Do not expose policy files everywhere. Just support:

* config file default
* per-command override

That is enough.

---

## 3. Optional raw transcript ingestion mode

### What to copy from Mem0

Mem0’s add flow supports sending message arrays, and also supports disabling inference so raw messages are stored directly. That is the key behavior worth copying. ([Mem0][2])

### Minimum viable version

Add a `--raw-transcript` mode to `mem retain`.

It should:

* accept either stdin or a JSON file,
* store the transcript as a memory artifact,
* optionally trigger secondary extraction into normal memory entries.

### CLI shape

```bash
mem retain --raw-transcript --input transcript.json
cat transcript.json | mem retain --raw-transcript
mem retain --raw-transcript --extract-facts transcript.json
```

### Data format

Use a plain JSON array:

```json
[
  { "role": "system", "content": "You are helpful." },
  { "role": "user", "content": "I prefer dark mode." },
  { "role": "assistant", "content": "Noted." }
]
```

### Storage strategy

Store transcripts under a separate path:

```text
viking://agent/memory/transcripts/YYYY/MM/<id>.json
```

Do **not** mix them into `world/`, `opinions/`, etc.

Then add one optional extraction path:

* `--extract-facts` runs a summarizer/extractor over the transcript and emits standard `retain` calls into the normal epistemic directories.

That gives you both:

* raw audit/debug storage,
* and curated fact memory.

### Why this is the minimum

You avoid redesigning the whole memory model around chat logs.
You keep raw transcripts clearly separated from curated long-term memory.

### Suggested behavior

Default raw transcript behavior:

* store only,
* not used by default in `recall`.

Optional:

* `mem recall --include-transcripts`
* or use transcripts only as a fallback source

This prevents transcript spam from polluting retrieval.

### Implementation effort

Small.

You need:

* parser for transcript input,
* storage path + metadata,
* optional extractor bridge.

### Estimated code

About **80–140 lines** for raw storage only, or **140–220 lines** including extract-facts support.

### Minimal TypeScript sample

```ts
interface TranscriptTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp?: string;
}

async function retainRawTranscript(
  turns: TranscriptTurn[],
  opts: { context?: string; extractFacts?: boolean }
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const uri = `viking://agent/memory/transcripts/${now.slice(0, 4)}/${now.slice(5, 7)}/${id}.json`;

  await openviking.write(uri, JSON.stringify({
    id,
    created_at: now,
    context: opts.context ?? null,
    turns
  }, null, 2));

  if (opts.extractFacts) {
    const condensed = turns
      .filter((t) => t.role === "user" || t.role === "assistant")
      .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
      .join("\n");

    await retainCuratedMemory(condensed, { context: opts.context });
  }

  return { action: "retained", mode: "raw-transcript", uri };
}
```

### Recommendation

Do not index transcript turns into SQLite entities directly in v1.
Only extract entities if `--extract-facts` is enabled.

That keeps ingestion cheap and predictable.

---

## Combined implementation plan

### New commands/flags

Add only these:

```bash
mem recall --filter '{...}'
mem recall --filter-file ./filter.json

mem retain --policy "markdown text"
mem retain --policy-file ./policy.md

mem retain --raw-transcript --input transcript.json
mem retain --raw-transcript --extract-facts
```

### Suggested config additions

```json
{
  "reconcile": {
    "enabled": true,
    "policy_file": "~/.config/mem/reconcile-policy.md",
    "policy_inline": ""
  },
  "transcript": {
    "store_raw_by_default": false,
    "extract_facts_by_default": false,
    "include_in_recall": false
  }
}
```

### Minimum code by feature

* metadata filters: **120–180 LOC**
* reconcile policy: **100–160 LOC**
* raw transcript mode: **80–140 LOC** storage only, **140–220 LOC** with extraction bridge

### Total realistic addition

If done carefully and minimally:

* **lean version:** about **300–400 LOC**
* **comfortable version with validation/tests:** about **450–650 LOC**

That is still well within the spirit of your proposal.

---

## What I would explicitly not do

To keep this clean and small, I would avoid:

* full Mem0 metadata operator parity
* backend-level query pushdown into OpenViking
* transcript retrieval by default
* a dedicated policy DSL
* policy files per memory type in v1
* asynchronous ingestion daemons
* multimodal transcript mode
* separate REST APIs for these features

Those all add complexity fast.

---

## Recommended final shape

If the goal is minimum code and maximum value, I would ship this:

### Phase A

* metadata filtering
* reconcile policy file/string
* raw transcript storage only

### Phase B

* `--extract-facts` for transcript mode
* `SUPERSEDE` as explicit reconcile outcome
* filter support on `stats` / `timeline` / `entity list`

That gives you most of the value without turning `mem` into another kitchen-sink memory platform.

The only Mem0 ideas worth stealing here are the **shape**, not the whole product: small filter object, prompt-driven reconcile decisions, and optional raw transcript capture. ([Mem0][2])

[1]: https://docs.mem0.ai/open-source/features/metadata-filtering?utm_source=chatgpt.com "Enhanced Metadata Filtering - Mem0"
[2]: https://docs.mem0.ai/open-source/features/custom-update-memory-prompt?utm_source=chatgpt.com "Custom Update Memory Prompt - Mem0"
