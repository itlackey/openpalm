# Issue #298 - Add OpenViking integration

## Scope

- Deliver only roadmap Phases 1A-1D for 0.10.0: OpenViking as an optional component, assistant-side Viking tools, session-memory hooks, and token-budget utilities.
- Treat this as a post-#301 feature. The component system, overlay merge behavior, instance/env handling, and registry layout must exist before Phase 1A lands.
- Keep all portable control-plane logic in `packages/lib/` when lifecycle, config assembly, validation, path resolution, or secret handling are involved; admin and CLI stay thin consumers.

## Dependencies and assumptions

- Hard dependency on #301 component system, especially `registry/components/`, component instance lifecycle, compose overlay chaining, and cross-component environment injection into `assistant`.
- Assumes the 0.10.0 single-root filesystem and vault boundary are in force, so Viking secrets/config live under `~/.openpalm/vault/` and not legacy XDG paths.
- Assumes assistant integration remains container-local and env-driven: the assistant discovers Viking via `OPENVIKING_URL` and `OPENVIKING_API_KEY`, and must degrade cleanly when those vars are absent.
- Assumes admin, when present, is the only service allowed to write Viking config/secrets on the host; assistant only consumes them through mounted env/config per the architecture rules.
- Assumes #300 secret backend work is available enough to store `OPENVIKING_API_KEY` and embedding secrets without introducing Viking-specific secret handling outside the shared secret backend.

## Phase breakdown

### Phase 1A - OpenViking component registry entry

1. Create `registry/components/openviking/` with at least:
   - `compose.yml`
   - `.env.schema`
   - optional docs/README if registry conventions require per-component notes
2. Build the compose overlay to do two things only:
   - define the OpenViking service with pinned image, healthcheck, workspace mount, and vault-backed config mount
   - extend the existing `assistant` service environment with `OPENVIKING_URL` and `OPENVIKING_API_KEY`
3. Keep the overlay aligned with component-system rules:
   - no `container_name`
   - no overrides of existing assistant env keys
   - only additive env injection into `assistant`
   - collision validation for injected env names if more than one component targets `assistant`
4. Define `.env.schema` fields for:
   - `OPENVIKING_API_KEY`
   - embedding provider/model/base URL/dimensions
   - embedding API key if required by the chosen provider
5. Add lib-first config assembly for Viking's runtime config file:
   - introduce a `packages/lib/src/control-plane/` helper that assembles full-file `ov.conf` content from validated settings
   - write `ov.conf` into the vault as a whole file; do not template or mutate fragments in place
   - ensure install/update/apply paths seed or refresh this file only through explicit control-plane flows
6. Extend component validation/tests so the registry and instance lifecycle accept the new component shape, including assistant env injection and vault config presence.

### Phase 1B - Assistant tooling and OpenViking client

1. Add a shared Viking client helper in `packages/assistant-tools/opencode/tools/` or a nearby assistant-tools lib module following the existing `memoryFetch()` pattern:
   - `vikingFetch(path, options)`
   - auth header injection from `OPENVIKING_API_KEY`
   - timeout/error normalization
   - graceful disabled-state responses when Viking env vars are missing
2. Implement the initial tool surface required by the roadmap and issue scope:
   - resource ingestion (`add-resource`)
   - search (`search` / semantic find)
   - resource fetch/read (`get-resource` or read/browse equivalents)
   - list/browse resources (`list-resources`)
   - session-memory append/logging (`add-session-memory`)
   - session-memory discovery (`search-sessions`)
3. Reconcile naming with the more detailed knowledge roadmap before merge. If the code ships with user-facing tool names like `viking-search`, `viking-read`, `viking-browse`, keep the plan-to-code mapping explicit in docs/tests so the deliverable still covers the six wrappers expected by the roadmap.
4. Keep tools read/write bounded to Viking HTTP APIs only. Do not add direct filesystem access from the assistant to Viking data.
5. Add unit tests around:
   - missing env vars
   - non-2xx Viking responses
   - auth header behavior
   - argument validation and output formatting

### Phase 1C - Session memory integration

1. Extend `MemoryContextPlugin` with conditional Viking behavior instead of replacing the existing memory flow.
2. At `session.created`:
   - detect whether Viking is available
   - create a Viking session or equivalent session handle
   - retrieve cheap L0/L1 context for key Viking namespaces in parallel with current memory retrieval
   - inject a combined context block without regressing existing memory-only behavior
3. At `tool.execute.after`:
   - record tool outcomes into the active Viking session when enabled
   - preserve existing memory feedback behavior for procedural reinforcement
4. At `session.idle` and/or `session.deleted`:
   - commit the Viking session so native extraction/dedupe runs
   - preserve existing episodic/procedural memory extraction until the Viking-backed path is proven stable
   - make commit idempotent or safely guarded so multiple idle/delete hooks do not double-write session state
5. At `experimental.session.compacting`:
   - prefer Viking overviews/summaries, not full-content payloads
   - keep compacted context within explicit token budgets
6. Track session-local Viking identifiers in plugin state so commit/log hooks can correlate a session without leaking secrets or coupling to UI state.
7. Add integration coverage for both modes:
   - Viking disabled -> existing memory behavior unchanged
   - Viking enabled -> session create/log/commit calls happen alongside memory calls

### Phase 1D - Token-budget utilities and context assembly

1. Add shared token-budget helpers inside assistant-tools context code:
   - token estimation
   - fit-in-budget/bin-packing helpers
   - budget parsing and recommended splits
2. Build or refactor an `assembleContext()`-style helper that can:
   - search Viking when installed
   - fall back to memory search when Viking is absent
   - request lower-cost summaries first
   - promote only the best candidates to more expensive detail levels inside a fixed budget
3. Keep ranking/budget logic separate from transport code so future Q-value reranking can layer on later without rewriting Viking or memory clients.
4. Use the utilities in both session-start retrieval and session-compaction paths where practical so 0.10.0 gets one budget model, not multiple ad hoc caps.
5. Add deterministic tests for budget calculations and item fitting to avoid regressions as context formats evolve.

## Cross-cutting work

### Component registry and control-plane

- Put component discovery, instance config assembly, `ov.conf` generation, validation, and any env-injection collision logic in `packages/lib/`, not `packages/admin/`.
- Keep admin route handlers and CLI commands as thin callers into lib APIs.
- Ensure file writes follow the filesystem contract: whole-file assembly, validate before write, non-destructive lifecycle behavior for user-owned config.

### Assistant tooling/plugin integration

- Keep Viking HTTP helpers and tool wrappers in `packages/assistant-tools/` beside existing memory tooling patterns.
- Gate all Viking behavior on env/config presence so the assistant remains fully functional without the optional component.
- Avoid hard-coding admin-specific assumptions into assistant tools; assistant talks to Viking directly over the Docker network and still respects assistant isolation.

### Session memory integration

- Treat Viking as an enhancement to retrieval/extraction, not a replacement for `@openpalm/memory` in 0.10.0.
- Preserve current memory feedback and episodic capture so fallback behavior remains intact and measurable.
- Structure state so later 0.11.0 work can add Q-value feedback without redesigning the plugin lifecycle.

### Token-budget utilities

- Keep budget helpers portable and side-effect free.
- Prefer one shared implementation used by Viking-enhanced and memory-only paths.
- Leave Q-value weighting, eval-driven tuning, and maintenance automation for 0.11.0.

### Docs

- Update 0.10.0 docs to explain:
  - OpenViking is optional and depends on the component system
  - required env/schema fields and vault placement of `ov.conf`
  - assistant behavior when Viking is absent
  - the exact tool names exposed to OpenCode and what each does
- Add operator-facing setup notes for embedding provider requirements and health/debug expectations.

### Tests

- `packages/lib/` tests for component config assembly, validation, and `ov.conf` generation.
- `packages/assistant-tools/` tests for Viking fetch helper, tool wrappers, token-budget helpers, and `MemoryContextPlugin` dual-mode behavior.
- Component/registry tests once #301 test scaffolding exists, covering install/configure/start/health with OpenViking enabled.
- No 0.10.0 scope expansion into full eval suites; only targeted unit/integration coverage needed for the shipped feature.

## Deferred items - do not pull into 0.10.0

- MCP server component and any generic `packages/mcp/` work
- Eval framework, Viking retrieval eval suites, nightly grading, or regression dashboards
- MemRL/Q-value feedback loop, semantic-plus-Q reranking, and maintenance automations
- Admin knowledge dashboards or new Viking-specific admin feature surfaces beyond normal component APIs
- Broad knowledge-management automation beyond the Phase 1C lifecycle hooks required for session commit

## Acceptance criteria

- OpenViking can be installed as a component through the #301 component model using a registry directory with `compose.yml` and `.env.schema`.
- Enabling the component injects `OPENVIKING_URL` and `OPENVIKING_API_KEY` into `assistant` without modifying core compose assets directly.
- Viking runtime config is assembled as a whole file and stored in the vault under the 0.10.0 filesystem contract.
- Assistant tools expose the agreed Viking capability set and return clear disabled/error responses when Viking is not installed.
- `MemoryContextPlugin` retains existing memory behavior and adds Viking session create/log/commit flows only when Viking is available.
- Context assembly uses explicit token-budget utilities and gracefully falls back to memory-only retrieval when Viking is absent.
- Tests cover the lib/config path, assistant tool path, and dual-mode plugin behavior.
- Docs clearly mark deferred work so 0.10.0 does not absorb MCP, eval, or Q-value scope.

## Risks

- #301 may still shift component directory conventions or instance/env semantics, which would force rework in Phase 1A.
- The repo still contains legacy XDG/staging control-plane code, so Viking planning must avoid baking new work into soon-to-be-replaced paths.
- Tool naming is inconsistent between the roadmap summary and the detailed knowledge roadmap; leaving that unresolved could create docs/test drift.
- Viking session hooks could duplicate writes or bloat context if lifecycle transitions are not carefully gated.
- Embedding/provider configuration spans component config, secret management, and runtime file assembly; ownership boundaries must stay clear to avoid secret leakage.

## Relevant files

- `.github/roadmap/0.10.0/README.md:88` - issue #298 milestone scope, dependency on #301, and Phase 1A-1D deliverables.
- `.github/roadmap/0.10.0/README.md:219` - roadmap-level rule that all control-plane logic belongs in `packages/lib/`.
- `.github/roadmap/0.10.0/knowledge-system-roadmap.md:52` - detailed OpenViking implementation breakdown for the 0.10.0 priority.
- `.github/roadmap/0.10.0/knowledge-system-roadmap.md:89` - proposed component layout, `ov.conf` handling, assistant tools, session hooks, and token-budget work.
- `.github/roadmap/0.10.0/plans/issue-301-unified-component-system.md` - addon overlay design and extension points for issue #301.
- `docs/technical/authoritative/core-principles.md:30` - whole-file assembly, single-root filesystem, and shared-lib control-plane requirements.
- `docs/technical/authoritative/core-principles.md:50` - vault boundary and assistant/admin write-access rules relevant to `ov.conf` and secrets.
- `docs/technical/authoritative/core-principles.md:128` - authoritative shared control-plane library rule.
- `packages/assistant-tools/opencode/plugins/memory-context.ts:99` - current session lifecycle hooks to extend for Viking-aware retrieval and commit.
- `packages/assistant-tools/opencode/tools/lib.ts:44` - existing fetch/helper pattern to mirror for `vikingFetch()`.
- `packages/assistant-tools/tests/memory-context.integration.test.ts:78` - existing plugin integration coverage to expand for Viking-enabled and fallback modes.
- `packages/admin/src/lib/server/control-plane.ts:1` - current thin-wrapper pattern showing admin should re-export lib logic rather than owning new control-plane behavior.
- `packages/lib/src/control-plane/paths.ts:1` - legacy XDG path code that should not receive new 0.10.0-specific Viking design assumptions.
- `packages/lib/src/control-plane/staging.ts:1` - legacy staging pipeline referenced by prior plans; useful only as a migration contrast while implementing the new whole-file/vault approach.
