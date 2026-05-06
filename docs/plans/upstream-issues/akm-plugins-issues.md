# Upstream issue drafts — `itlackey/akm-plugins`

These are ready to paste into <https://github.com/itlackey/akm-plugins/issues/new>. Each block has a suggested **title**, a body, and suggested **labels**. Source plan: `docs/plans/simplify-via-akm.md`.

> **Reality-checked against akm-opencode 0.7.3 on 2026-05-06.** Most earlier proposals (`session.created` retrieval with budget, scope auto-attach, conversation-derived feedback with negative cues, session-end `akm index`) **already shipped** as env-var-controlled features. Only the items below remain.

Each issue should ship in both the `opencode/` and `claude/` subdirectories (see #4 for the parity meta-issue).

---

## 1. Harness-LLM passthrough shim

**Title:** Implement the `AKM_LLM_PROXY_CMD` shim so akm can borrow the harness's provider connection

**Labels:** `enhancement`, `opencode`, `claude`, `llm`, `index`

**Body:**

### Summary
When the user has provider credentials configured for the agent harness but no `akm.llm` configured for akm, expose those credentials to akm via a small stdio shim. Pairs with the matching `AKM_LLM_PROXY_CMD` hook proposed in `itlackey/akm` (CLI side).

### Today
`akm index --enrich` requires `akm.llm`. Users either configure providers twice (once for the harness, once for akm) or skip enrichment entirely.

### Proposal
- On plugin init, detect that no `akm.llm` is configured.
- Spawn / register a tiny shim (a Bun script bundled with the plugin) and set `AKM_LLM_PROXY_CMD=<shim path>` for child `akm` invocations.
- The shim reads the JSON request from stdin (per the upstream CLI hook contract), forwards it through the harness's existing provider connection, and writes the JSON response back to stdout.
- No provider credentials cross the plugin / CLI boundary in plaintext — the shim handles the call.

### Why plugin, not CLI
Only the harness has the user-authenticated provider connection; akm itself stays harness-agnostic.

### Depends on
- `itlackey/akm` issue: "Pluggable LLM proxy hook so embedding hosts can lend their provider connection to akm" — the CLI defines the contract; the plugin implements one side of it.

### Acceptance
- [ ] With no `akm.llm` configured but a harness LLM available, `akm index --enrich` succeeds via the plugin shim.
- [ ] Disabling the harness LLM falls back to no-op (not error) on index passes.
- [ ] Behaviour parity-matched in `opencode/` and `claude/`.

---

## 2. Bug: stale `feedback` guard skips `memory:` and `vault:` refs

**Title:** Remove stale guard that skips `akm feedback` for `memory:` and `vault:` refs

**Labels:** `bug`, `opencode`, `claude`, `feedback`

**Body:**

### Summary
The opencode plugin contains a guard that skips feedback for `memory:` and `vault:` refs, with a comment claiming "memories do not accept feedback." That comment is stale — akm-cli 0.7.x **does** accept feedback on those refs.

### Source pointer
`itlackey/akm-plugins/blob/main/opencode/index.ts` — search for:

```ts
if (ref.startsWith("memory:") || ref.startsWith("vault:")) continue;
```

### Today
Plugin silently drops legitimate feedback on memories and vaults, breaking the relevance-learning loop on the asset types users re-rank most.

### Proposal
- Remove the guard.
- Mirror in `claude/` if the same guard exists there.
- Optionally add a fast-path that reuses the existing feedback batching logic.

### Acceptance
- [ ] `akm feedback memory:<ref> --positive` issued through the plugin actually runs.
- [ ] `akm feedback vault:<ref> --positive` issued through the plugin actually runs.
- [ ] Existing tests (if any) cover the removed branch.
- [ ] Behaviour parity-matched in `opencode/` and `claude/`.

---

## 3. Bug: `buildScopedArgs()` sends `--user`/`--agent`/etc. to verbs that don't accept them

**Title:** Plugin sends direct scope flags to `search` and `show`, but those verbs expect `--filter`/`--scope`

**Labels:** `bug`, `opencode`, `claude`, `scoping`

**Body:**

### Summary
A single `buildScopedArgs()` helper pushes `--user X --agent Y --run Z --channel C` into argv for `akm remember`, `akm search`, **and** `akm show`. Only `remember` accepts that shape today — `search` expects `--filter <k>=<v>` and `show` expects `--scope <k>=<v>`. As a result, scope filtering on plugin-issued search/show calls silently fails.

### Source pointer
`itlackey/akm-plugins/blob/main/opencode/index.ts` — `buildScopedArgs()` and the call sites that route through `akm_search` / `akm_show`.

### Resolution options
Pick one (mirror in `claude/`):
- (a) Wait for / depend on the upstream CLI fix (`itlackey/akm` issue: "Scope flag shape differs between `akm remember` and `akm search` / `akm show`") to accept both shapes.
- (b) Update `buildScopedArgs()` to emit the right shape per verb:
  - `remember`: `--user X --agent Y ...`
  - `search`: `--filter user=X --filter agent=Y ...`
  - `show`: `--scope user=X --scope agent=Y ...`

### Acceptance
- [ ] Plugin-issued `akm_search` / `akm_show` honour scope.
- [ ] Behaviour parity-matched in `opencode/` and `claude/`.

---

## 4. Cross-harness parity (meta)

**Title:** Track feature / bug-fix parity between `opencode/` and `claude/`

**Labels:** `meta`, `opencode`, `claude`

**Body:**

### Summary
Meta-issue to track parity between the two harness plugins as the issues above land.

### Tracked items
- [ ] Harness-LLM passthrough shim (#1)
- [ ] `feedback` guard removal (#2)
- [ ] `buildScopedArgs()` fix (#3)

(Update issue numbers once filed.)

---

## Already shipped — no longer proposed

For maintainer reference, the following appeared in earlier drafts and have since landed in 0.7.x:

- **Session-start retrieval with token budget** — `AKM_CONTEXT_BUDGET_CHARS` is honoured by the existing `session.created` hook.
- **Scope auto-attach from session metadata** — `AKM_SCOPE_KEYS` (default `user,agent,run,channel`) is forwarded automatically (modulo the bug in #3).
- **Conversation-derived feedback (negative cues)** — `AKM_RETROSPECTIVE_NEGATIVE_PATTERN` ships alongside the original positive-cue pattern.
- **Session-end optional `akm index`** — `AKM_INDEX_ON_SESSION_END=1` triggers `akm index` after the session-end flush.

## Out of scope for this repo

- **Per-thread / per-conversation stash overlays** — considered, dropped. Scope flags + `AKM_SCOPE_KEYS` cover the multi-user case without overlay complexity.
- **CLI auto-install on plugin load** — explicitly removed in 0.7.x. Hosts must install `akm` on PATH themselves.
