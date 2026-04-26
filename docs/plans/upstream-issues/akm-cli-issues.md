# Upstream issue drafts — `itlackey/akm`

These are ready to paste into <https://github.com/itlackey/akm/issues/new>. Each block has a suggested **title**, a body, and suggested **labels**. Source plan: `docs/plans/simplify-via-akm.md`.

Selection criteria for this repo: features useful outside any specific host, runnable as a one-shot subprocess, no assumption about an agent loop. Items that need lifecycle hooks live in the akm-plugins repo (see `akm-plugins-issues.md`).

---

## 1. Memory-inference as part of `akm index`, controlled by global config

**Title:** Inference pass inside `akm index`, toggled via global config

**Labels:** `enhancement`, `memory`, `index`, `cli`

**Body:**

### Summary
Add an opt-in inference pass to `akm index` that uses the configured LLM to split memories pending inference into atomic facts.

### Today
`akm remember "<text>"` stores the input verbatim. Consumers that want atomic recall (RAG pipelines, anything summarising long inputs) build their own extraction loop.

### Proposal
Extend the existing index process to detect memories pending inference and run the configured LLM over them, splitting each into atomic memories with frontmatter `inferred: true` and a backref to the source.

- Toggle via `akm config set index.infer true|false`.
- When disabled: indexing leaves memories untouched.
- When enabled: every `akm index` run drains the pending queue.
- No new flag on `akm remember` — the verb surface stays the same.

### Why this shape
Folding the work into the existing indexing pipeline lets users adopt it just by scheduling `akm index`, with no new flags to remember. It also keeps the extraction logic in one place rather than scattering it across consumers.

### Acceptance
- [ ] Pending memories are detected by indexer.
- [ ] When `index.infer=true`, atomic memories are written with `inferred: true` and a `source:` backref.
- [ ] Re-running indexing is idempotent.
- [ ] Toggling off via config halts the pass without losing existing inferred memories.

---

## 2. First-class memory scoping (`--user`, `--agent`, `--run`, `--channel`)

**Title:** Native scoping flags on `akm remember` / `akm search` / `akm show`

**Labels:** `enhancement`, `memory`, `cli`

**Body:**

### Summary
Add canonical scope flags so multi-user / multi-agent deployments stop inventing their own conventions.

### Today
Scoping is achievable only by setting a different `AKM_STASH_DIR` per scope or by writing custom frontmatter via a host wrapper.

### Proposal
- `akm remember "<text>" --user <id> --agent <id> --run <id> --channel <name>` — persists the values as canonical frontmatter.
- `akm search "<query>" --filter user=<id> --filter agent=<id> ...` — pre-filters via the search index.
- `akm show memory:<ref> --scope user=<id>` — narrows resolution.

### Why
Any multi-user / multi-agent / multi-tenant deployment of akm needs this. Today every consumer (chatbots, shared dev teams, multi-tenant deployments) invents its own scoping convention, which makes stashes non-portable.

### Acceptance
- [ ] Scope flags persist as a stable frontmatter shape.
- [ ] Search index respects the filters at query time.
- [ ] Existing memories without scope still match unfiltered queries.

---

## 3. `akm feedback` should accept any valid ref

**Title:** Allow `akm feedback` on any valid ref (memory, vault, etc.)

**Labels:** `enhancement`, `feedback`, `cli`

**Body:**

### Summary
`akm feedback` currently rejects some ref types (notably `memory:` and `vault:`). The opencode plugin auto-skips those refs as a result, so relevance signal on memories and vaults has no upstream path.

### Proposal
Allow feedback on any valid ref. Vault feedback can store an aggregated count without leaking values (counts, not contents). Hybrid ranking already reads frontmatter for boosts, so the wiring is small.

### Why
Closes the relevance-learning loop uniformly across asset types instead of asking consumers to remember which refs are "feedback-eligible".

### Acceptance
- [ ] `akm feedback memory:<ref> --positive` succeeds and is reflected in subsequent ranking.
- [ ] `akm feedback vault:<ref> --positive` succeeds without surfacing values.
- [ ] No ref type silently rejects feedback.

---

## 4. `akm events` — read / tail asset-mutation events

**Title:** Append-only events stream + `akm events list|tail`

**Labels:** `enhancement`, `observability`, `cli`

**Body:**

### Summary
Add a documented event stream so external observers (sync, replication, audit, dashboards) can react to stash changes without polling.

### Today
There is no documented event stream; consumers have to scrape mtimes or build their own log.

### Proposal
- An append-only `events.jsonl` written by the CLI on every add / update / delete / feedback / index pass.
- `akm events list [--since <ts>] [--type <event-type>] [--ref <ref>]` — paged history.
- `akm events tail [--since <ts>]` — follow mode.
- Same JSON envelope conventions as the rest of the CLI.

### Why
Foundational for any external observer that needs to react to stash changes without polling. Pairs naturally with the periodic-`akm index` pattern for downstream consumers, and is a clean primitive even when no harness is involved.

### Acceptance
- [ ] Every CLI verb that mutates state emits an event.
- [ ] `--since` is monotonic and durable across processes.
- [ ] `tail` keeps up with concurrent writers without losing events.

---

## 5. `akm history` — surface the existing mutation history

**Title:** First-class `akm history` command

**Labels:** `enhancement`, `observability`, `cli`

**Body:**

### Summary
Surface the mutation history akm already writes so downstream tools don't reinvent it.

### Today
akm writes mutation history internally; there is no first-class command to read it. Consumers wanting an audit trail either scrape filesystem mtimes or build a parallel log.

### Proposal
`akm history [--ref <ref>] [--since <ts>] [--format json|jsonl|text|yaml]` — returns per-asset and stash-wide history with the same JSON envelope as the rest of the CLI.

Distinct from `akm events`:
- **history** = per-asset state changes ("this memory was added then edited then deleted").
- **events** = realtime stream of any mutation across the stash.

### Why
Closes the audit-trail need without forcing every downstream tool to build its own.

### Acceptance
- [ ] `akm history --ref memory:<id>` shows full lifecycle of a single asset.
- [ ] `akm history` (no ref) shows stash-wide history.
- [ ] JSON envelope matches existing CLI conventions.

---

## 6. Pluggable secret backends and rotation for `akm vault` *(future consideration)*

**Title:** Pluggable secret backends + rotation for `akm vault`

**Labels:** `enhancement`, `vault`, `discussion`

**Body:**

> Status: deferred / future consideration. Filed so the design is captured; not a near-term commitment.

### Summary
Make `akm vault` a credible production secret store rather than a developer-laptop convenience. Tracks #190.

### Today
Vault is `.env`-style files only; no rotation, no remote secret-manager integration.

### Proposal
A backend interface with built-in adapters and hooks for external managers:
- Built-in: OS keychain, age-encrypted files.
- External hooks: `pass`, 1Password CLI, AWS / GCP Secrets Manager, HashiCorp Vault.
- Rotation: `akm vault rotate <key>` (re-keys + re-encrypts in place).
- Backend selection: `akm vault backend set <name>`.

### Why
Production deployments need rotation and centralised secret management. Today users either pick `akm vault` and accept dev-only semantics or shell out to a different secret manager entirely.

### Acceptance (when picked up)
- [ ] Backend interface defined with at least one built-in alternative to `.env`.
- [ ] Rotation is atomic (no readers see a half-rotated key).
- [ ] Existing `.env` vaults migrate without breaking refs.

---

## 7. Graph-build as part of `akm index`, controlled by global config

**Title:** Graph-extraction pass inside `akm index`, toggled via global config

**Labels:** `enhancement`, `index`, `graph`, `cli`

**Body:**

### Summary
Add an opt-in graph pass to `akm index` that extracts entities and relations from `memory:` and `knowledge:` assets.

### Today
akm's hybrid search is purely document-level. Graph reasoning across memories is left to consumers, which forces every stack with that need to bolt on a separate graph-memory service.

### Proposal
Same shape as the inference pass (#1):
- Toggle via `akm config set index.graph true|false`.
- When enabled, the index process extracts entities and relations using the configured LLM and persists a queryable graph file under the stash.
- Search ranking consults the graph when it exists; otherwise behaves as today.

### Why
Folding graph building into indexing means users don't manage a separate `graph build` cadence — one `akm index` run keeps everything in sync. Same on/off-ramp as memory inference.

### Acceptance
- [ ] Graph file is written under the stash and refreshed on each index run when enabled.
- [ ] Search ranking improvement is measurable for graph-eligible queries.
- [ ] Toggling off doesn't remove the graph file (just stops refreshing it).

---

## 8. Single configurable LLM block reused across index passes

**Title:** Unify `akm.llm` config across all index-time passes

**Labels:** `enhancement`, `config`, `cli`

**Body:**

### Summary
One `akm.llm` config block reused by every LLM-needing pass inside `akm index`.

### Today
The optional LLM is wired for indexing-time metadata enrichment, but additional passes (memory inference, graph extraction, future passes) would each need their own config wiring.

### Proposal
- Single `akm.llm` block in config — provider, model, baseUrl, etc.
- Every LLM-using pass inside `akm index` reads this block by default.
- Per-pass opt-out via `index.<pass>.llm = false` for users who want enrichment but not graph (or vice versa).

### Why
One place to configure, consistent behaviour across enrichment, inference, and graph building. Avoids fan-out where each pass has its own provider settings.

### Acceptance
- [ ] All index passes default to `akm.llm`.
- [ ] Per-pass opt-out works.
- [ ] No duplicate provider configuration paths.

---

## Explicitly **not** proposed (documented as non-goals)

For maintainer reference, the following were considered and rejected so they don't get re-proposed:

- **`akm serve` / any HTTP daemon** — akm will not serve HTTP. The CLI is the only programmatic surface; consumers either embed it as a subprocess or share the stash directory.
- **`akm workflow schedule` / cron triggers** — out of scope for akm. Scheduling stays in the host (cron, systemd, the host app's scheduler).
