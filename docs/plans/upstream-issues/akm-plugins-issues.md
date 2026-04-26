# Upstream issue drafts — `itlackey/akm-plugins`

These are ready to paste into <https://github.com/itlackey/akm-plugins/issues/new>. Each block has a suggested **title**, a body, and suggested **labels**. Source plan: `docs/plans/simplify-via-akm.md`.

Selection criteria for this repo: features that need agent-harness lifecycle hooks, tool registration, or system-prompt transforms. CLI-shaped enhancements live in <https://github.com/itlackey/akm/issues> (see `akm-cli-issues.md`).

Each issue should ship in both the `opencode/` and `claude/` subdirectories (see #6 for the parity meta-issue).

---

## 1. `session.created` retrieval with token budget

**Title:** Inject curated context on session start, not just on first message

**Labels:** `enhancement`, `opencode`, `claude`, `context`

**Body:**

### Summary
Subscribe to the harness's session-start hook and inject curated context before the first user message.

### Today
The plugin injects context on `chat.message` (curate-on-message), not on session start. Cold sessions miss curated context until the user types.

### Proposal
On the harness session-start hook:
- Run `akm curate --limit N --for-agent` against the session's scope (using the new CLI scope flags — see `itlackey/akm` issue "Native scoping flags").
- Inject results via the harness's system-prompt transform (`experimental.chat.system.transform` for opencode; equivalent for Claude).
- Budget configurable via `AKM_CONTEXT_BUDGET_CHARS`.

### Why plugin, not CLI
Requires harness lifecycle hooks and prompt-transform APIs that only exist inside the agent runtime.

### Acceptance
- [ ] Curated context appears in the system prompt of a fresh session before any user message.
- [ ] Total injected size respects `AKM_CONTEXT_BUDGET_CHARS`.
- [ ] Behaviour is parity-matched between `opencode/` and `claude/`.

---

## 2. Auto-attach scope from harness session metadata

**Title:** Auto-pass `--user`/`--agent`/`--run`/`--channel` from harness session metadata

**Labels:** `enhancement`, `opencode`, `claude`, `scoping`

**Body:**

### Summary
When the harness exposes session metadata (channel, user id, agent id), the plugin transparently passes those through to the new CLI scope flags on every `akm_remember` / `akm_curate` call. No user action required.

### Today
There is no automatic scope attachment. Multi-user / multi-tenant deployments either run separate stashes per scope or write custom frontmatter via host wrappers.

### Proposal
- Read available session metadata from the harness on plugin init / hook fire.
- Pass through to the CLI as `--user <id> --agent <id> --run <id> --channel <name>` on every `akm_remember`, `akm_curate`, `akm_feedback` call.
- Configurable via `AKM_SCOPE_KEYS` if the user wants to opt in / out per field.

### Why plugin, not CLI
Scope sources are harness-specific (OpenCode session ids, Claude Code thread ids, etc.). The CLI provides the flags; the plugin knows how to fill them.

### Depends on
- `itlackey/akm` issue: "Native scoping flags on `akm remember` / `akm search` / `akm show`".

### Acceptance
- [ ] Memories created during a session carry the harness-derived scope as frontmatter.
- [ ] Searching with the same scope returns those memories.
- [ ] No bleed of scope into manually-invoked CLI calls outside the plugin.

---

## 3. Conversation-derived feedback

**Title:** Infer positive/negative feedback from conversation signals

**Labels:** `enhancement`, `opencode`, `claude`, `feedback`

**Body:**

### Summary
Extend the existing positive-cue matcher to negative cues, multi-turn confirmation, and explicit "this was wrong" detection. Call `akm feedback <ref>` against any harvested ref.

### Today
`akm-opencode` has `AKM_RETROSPECTIVE_FEEDBACK_PATTERN` matching positive cues only. Negative signal goes nowhere; explicit corrections aren't captured.

### Proposal
- Add a configurable negative-cue pattern (`AKM_RETROSPECTIVE_NEGATIVE_PATTERN`) and a corrected-fact detector.
- On match, call `akm feedback <ref>` against the most-recently-used asset(s) for that turn.
- Works for any ref type, including memories, once the CLI accepts them (see CLI issue "Allow `akm feedback` on any valid ref").

### Why plugin, not CLI
Needs access to the conversation transcript and the harness's tool-execution timeline.

### Depends on
- `itlackey/akm` issue: "Allow `akm feedback` on any valid ref".

### Acceptance
- [ ] Negative cues trigger negative feedback against the right asset(s).
- [ ] Multi-turn confirmation is required before flipping feedback (avoids false positives on hedging).
- [ ] Behaviour parity-matched in `opencode/` and `claude/`.

---

## 4. Session-end optionally runs `akm index`

**Title:** Optional `akm index` invocation on session end

**Labels:** `enhancement`, `opencode`, `claude`, `index`

**Body:**

### Summary
After flushing the session buffer to a memory artifact, optionally invoke `akm index` so the new memories are processed (inference, graph) by akm's index passes.

### Today
The plugin already flushes a session buffer into a memory artifact on `stop` / `session.idle` / `session.compacted` / `session.deleted`. Index-time passes only fire when the host runs `akm index` separately.

### Proposal
- Gate via `AKM_INDEX_ON_SESSION_END=1` (default off so single-session users don't pay the cost).
- After the existing flush, run `akm index` once.
- With the new index-pass config (CLI issues "Inference pass inside `akm index`" and "Graph-extraction pass inside `akm index`"), a single run handles inference and graph passes — no plugin-side extraction logic.

### Why plugin, not CLI
The trigger is the harness lifecycle event; the work itself is upstream.

### Depends on
- `itlackey/akm` issue: "Inference pass inside `akm index`, toggled via global config".
- `itlackey/akm` issue: "Graph-extraction pass inside `akm index`, toggled via global config" (optional).

### Acceptance
- [ ] When env toggle is set, `akm index` runs once at session end.
- [ ] Failures are logged and do not abort session cleanup.
- [ ] Behaviour parity-matched in `opencode/` and `claude/`.

---

## 5. Harness-provided LLM fallback for akm passes

**Title:** Lend the harness's provider connection to akm when no `akm.llm` is configured

**Labels:** `enhancement`, `opencode`, `claude`, `llm`, `index`

**Body:**

### Summary
When the harness already has provider credentials configured for the agent, the plugin offers them to akm as the LLM backend for index-time passes (memory inference, graph build).

### Today
If no LLM is configured for akm, the new index passes (inference, graph) cannot run.

### Proposal
- Plugin detects that akm has no `akm.llm` configured.
- Plugin exposes a small shim (e.g., a local script or socket) and sets a CLI-side env / config such as `AKM_LLM_PROXY_CMD=<shim path>`.
- akm consults the proxy command when no native LLM is configured; the shim forwards prompts through the harness's existing provider connection and returns the result.
- No provider credentials cross the plugin / CLI boundary in plaintext — the shim handles invocation.

### Why plugin, not CLI
Only the harness has the user-authenticated provider connection; akm itself stays harness-agnostic.

### Open questions
- Exact shim contract (stdio / unix socket / file).
- Streaming vs. one-shot.
- Per-pass model selection.

### Depends on
- `itlackey/akm` issue: "Single configurable LLM block reused across index passes" (the proxy hooks into the same config path).

### Acceptance
- [ ] With no `akm.llm` configured but a harness LLM available, `akm index` passes succeed.
- [ ] Disabling the harness LLM falls back to no-op (not error) on index passes.
- [ ] Behaviour parity-matched in `opencode/` and `claude/`.

---

## 6. Cross-harness parity (meta)

**Title:** Track feature parity between `opencode/` and `claude/` plugins

**Labels:** `meta`, `opencode`, `claude`

**Body:**

### Summary
Meta-issue to track parity between the two harness plugins as the issues above land.

### Why
Each harness has its own hook surface; parity has to be coded per-harness. A meta-issue surfaces drift.

### Tracked features
- [ ] Session-start retrieval (#1)
- [ ] Auto-attach scope (#2)
- [ ] Conversation-derived feedback (#3)
- [ ] Session-end `akm index` (#4)
- [ ] Harness-provided LLM fallback (#5)

(Update issue numbers once filed.)

---

## Out of scope for this repo

- **Per-thread / per-conversation stash overlays** — considered, dropped. Scope flags (CLI side) cover the multi-user case without overlay complexity.
