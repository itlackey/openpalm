# Architecture Review --- v0.10.0 Milestone

## Summary

The 0.10.0 milestone is ambitious but architecturally sound in its post-review-decisions form. The component model (replacing channels/services with a unified abstraction) is the right structural move, and the review-decisions.md resolved the most critical conflicts found in the earlier cross-plan review. However, three significant gaps remain: (1) the component plan's clean break from legacy channels is under-specified for the CLI orchestrator path, which must continue working without admin; (2) the knowledge-system-roadmap introduces substantial new runtime complexity (Q-values, two-phase retrieval, eval framework) that risks scope creep for a single milestone; and (3) issue #302 (TTS/STT) has no plan document, no architectural analysis, and no clear dependency on any other 0.10.0 work, making it a candidate for deferral.

## Issues Assessment

### #315 --- Azure Container Apps Deployment (KEEP)

Low risk, well-scoped. Pure deployment-layer addition with no core code changes. The issue correctly identifies that admin is unavailable in ACA and that the core message path (channel -> guardian -> assistant -> memory) is admin-independent. This is consistent with security invariant #1 (CLI/admin is the orchestrator --- the ACA deployment script replaces that role).

One architectural concern: the ACA deployment merges DATA_HOME and STATE_HOME into a single Azure Files share (`openpalm-data`). This violates the three-tier XDG model where STATE_HOME is disposable and DATA_HOME is durable. While pragmatic for cloud, this should be documented as a known deviation, not silently merged. The Varlock integration via Azure Key Vault is a natural fit with the pass plan's provider-agnostic design (decision Q3).

**Recommendation: Keep. Add a note in the deployment README documenting the XDG tier deviation.**

### #304 --- Brokered Admin-Authorized OpenCode Instance (KEEP, clarify scope for 0.10.0)

Architecturally well-designed. The issue itself is thorough and correctly constrains the instance to Admin API authority rather than system authority. Decision Q4 (ADMIN_TOKEN, full admin-level agent) simplifies the design significantly --- no broker mediation layer, no new token type.

Risk: the issue describes four phases but does not specify which phases are in-scope for 0.10.0. The knowledge-system-roadmap treats #304 as an optional enhancement (not a blocker), which is the right call per decision Q5 (shell automation fallback). But the issue itself has no phase-gating for the milestone.

The Docker build concern is real: the admin container currently uses plain npm install (per the docker-dependency-resolution contract). Adding OpenCode/Bun to the admin container must not break this. The issue mentions this but does not propose a solution. The admin Dockerfile rule is explicit: "Never use Bun to install dependencies in the admin Docker build." The second OpenCode process would need Bun as a runtime but must not interfere with the npm-based build pipeline.

**Recommendation: Keep. Scope to Phase 1 + Phase 2 for 0.10.0. Explicitly document the Bun-in-admin-container strategy (install Bun as a runtime binary, not as a build tool, similar to how pass is added to the Dockerfile).**

### #302 --- TTS/STT Setup and Admin Interface (REMOVE from 0.10.0)

This issue has a two-sentence description, no plan document, no architectural analysis, and no dependency on or from any other 0.10.0 issue. Voice interfaces introduce significant new concerns: audio streaming transport, codec handling, browser media APIs, new container dependencies (Whisper, TTS engines), and latency requirements. None of these are addressed.

The knowledge-system-roadmap mentions it as "Voice-driven learning capture and context retrieval (future, not in this plan)," explicitly deferring it. No other plan references it.

**Recommendation: Remove from 0.10.0 milestone. Create a plan document before adding to any future milestone.**

### #301 --- Configurable Services (MERGE into component plan)

This issue is effectively subsumed by the component plan. The original issue mentions Cloudflare integration and services extensibility. The component plan already covers this: Cloudflare Tunnel would be a component (`registry/components/cloudflare-tunnel/`), not a "configurable service." The knowledge-system-roadmap's MCP server is also a component per the review decisions.

The distinction between "services" and "channels" that this issue originally proposed has been eliminated by the component model (decision embedded in the components plan: "No channel/service distinction"). Keeping this as a separate issue creates confusion about what work remains.

**Recommendation: Close #301 and track remaining work (Cloudflare Tunnel component, MCP component) as sub-tasks of the component system implementation. Or retitle to "Unified Component System" and make it the tracking issue for the components plan.**

### #300 --- Password Manager / Varlock Improvements (KEEP)

The pass-impl-v3 plan is the most implementation-ready document in the set. It correctly addresses all review decisions: PlaintextBackend as default (Q10), unified secret manager wrapping Varlock (Q3), component secret lifecycle integration (Q3 cascading), ADMIN_TOKEN / ASSISTANT_TOKEN split (Q4).

One concern: Phase 1 (auth refactor with ASSISTANT_TOKEN) is a prerequisite for #304 and for the knowledge roadmap's eval framework (eval scripts need ADMIN_TOKEN to call admin API). This is a critical-path dependency that should be called out. The pass plan has 7 phases; for 0.10.0, Phases 0-4 are essential (hardening, auth refactor, backend abstraction, pass provider, secrets API). Phases 5-7 (UI, connections refactor, migration tooling) could be deferred.

**Recommendation: Keep. Prioritize Phases 0-4 as critical path. Phases 5-7 are nice-to-have for 0.10.0.**

### #298 --- OpenViking Integration (KEEP, reduce scope)

Decision Q1 (Viking as component, not core service) and Q6 (Q-values in memory service) are correctly reflected in the knowledge-system-roadmap. The roadmap properly treats Viking as optional with graceful degradation.

However, the roadmap bundles four distinct capabilities under this single issue: (1) Viking as a component, (2) MCP server as a component, (3) eval framework, and (4) MemRL feedback loop. Only item (1) actually corresponds to "Add OpenViking integration." Items (2)-(4) should be separate issues.

The 24 working days estimated for the full knowledge-system-roadmap is aggressive for a milestone that also includes the component system rebuild, password manager, and brokered instance. The eval framework (Priority 3) and MemRL feedback loop (Priority 4) are valuable but could be 0.11.0 work.

**Recommendation: Keep #298 scoped to Viking component + assistant tools (Phases 1A-1D from the roadmap, ~6 days). Split out MCP server (#301 territory), eval framework, and MemRL as separate issues. Defer eval and MemRL to 0.11.0.**

### #13 --- Advanced Channel Configuration Support (SUPERSEDED by component plan)

This is the oldest issue in the milestone (original issue number #13). Its requirements --- multiple channel instances, custom UI per channel, per-channel OpenCode config, ENV variable management, secrets integration --- are all addressed by the component plan. The component model provides multi-instance by design (each instance is a separate directory with its own `.env`). The `.env.schema`-driven config form replaces the custom UI concept. Per-channel OpenCode config is a future extension on top of the component model.

The issue references code paths (`admin/src/server.ts`, `gateway/entrypoint.sh`, `opencode-channel/entrypoint.sh`) that no longer exist in the current codebase --- these are from a much older architecture.

**Recommendation: Close #13. The component plan (tracked via #301 or a new issue) fully supersedes it. Document which specific features from #13 are deferred (per-channel OpenCode config, custom channel config UIs, instance-level metrics).**

## Plan Document Assessment

### knowledge-system-roadmap.md

**Status:** Partially updated for review decisions, but scope is too large.

What is correct:
- Viking treated as a component (Q1 applied)
- Q-values stored in @openpalm/memory (Q6 applied)
- Shell automation fallback for eval and maintenance (Q5 applied)
- ov.conf in DATA_HOME (Q9 applied)
- #304 not a hard blocker (Q5 applied)
- MCP as component via registry (C3 resolved)
- ov.conf uses programmatic assembly, not template rendering (C1 resolved)

What needs updating:
- The document covers 4 distinct priorities (Viking, MCP, Eval, MemRL) that should map to 4 separate issues. Currently everything is crammed under #298 + #301.
- Phase 2 (MCP server) references `registry/services/mcp.yml` in the execution order but the body text correctly uses `registry/components/mcp/`. Minor inconsistency.
- The 24-day timeline assumes all 4 priorities ship in 0.10.0. With the component system rebuild also in 0.10.0, this is not realistic.
- Missing: how Viking component env vars (`OPENVIKING_URL`, `OPENVIKING_API_KEY`) flow into the assistant container. The component compose overlay must add these to the assistant's environment block, but the mechanism for a component to inject env vars into another service is not defined in the component plan.

**Recommendation: Split into 4 documents (Viking integration, MCP component, eval framework, MemRL). Keep Viking + MCP in 0.10.0. Defer eval + MemRL.**

### openpalm-components-plan.md

**Status:** Well-updated for review decisions. This is the strongest plan document.

What is correct:
- Three-tier XDG model preserved (Q2 applied)
- Clean break from legacy channels (Q8 applied)
- Unified secret manager for `@sensitive` fields (Q3 applied)
- Service name collision prevention with `openpalm-` prefix (M6 resolved)
- Compose variable references resolved by Docker Compose natively, not admin code (C1 resolved)
- Caddy route mechanism defined (H4 resolved)
- `enabled.json` persistence defined (D8 resolved)
- Catalog entry removal does not affect existing instances (D9 resolved)
- Archive on deletion (D4/D5 addressed)

What needs updating:
- **CLI orchestrator path missing.** The plan is written entirely from the admin container's perspective. Core principle: "Host CLI or admin is the orchestrator." The CLI (`packages/cli/`) must also support the component model. The staging pipeline in `packages/lib/src/control-plane/staging.ts` currently handles `CONFIG_HOME/channels/*.yml` --- this entire pipeline needs to be updated for the component model. The plan does not address this.
- **Cross-component environment injection.** The plan does not explain how one component can inject environment variables into another service. For example, OpenViking needs `OPENVIKING_URL` in the assistant container. The component compose overlay can add environment entries to existing services, but Compose overlay merge rules for `environment:` are additive only if the keys don't conflict. This interaction needs to be documented.
- **`compose.yml` naming convention.** The plan says components use `compose.yml` (modern convention) while core uses `docker-compose.yml` (legacy). Decision D3 says "should be documented" but the plan does not document the rationale clearly enough. This will confuse contributors.
- **Core services become components question.** The plan mentions Caddy as a component but the current codebase has Caddy in `OPTIONAL_SERVICES` (`types.ts` line 141-145). The plan should clarify: are core services (`memory`, `assistant`, `guardian`, `scheduler`) staying in `docker-compose.yml`? Are optional services (`caddy`, `admin`, `docker-socket-proxy`) migrating to components? This boundary is critical.

**Recommendation: Add a "CLI Integration" section. Add a "Cross-Component Dependencies" section. Clarify the core/optional/component boundary.**

### openpalm-pass-impl-v3.md

**Status:** Well-updated for review decisions. Most implementation-ready document.

What is correct:
- PlaintextBackend as default (Q10 applied)
- Unified secret manager (Q3 applied)
- Component secret lifecycle (Q3 cascading applied)
- ADMIN_TOKEN / ASSISTANT_TOKEN split (Q4 applied)
- Brokered instance uses ADMIN_TOKEN (Q4 applied)
- All three secret categories (core, component, ad-hoc) through one system (Q3 applied)
- `DATA_HOME/stack.env` gets 0o600 permissions (M9 resolved)
- CONFIG_HOME contract change documented (M8 addressed)
- GPG trust boundary documented (D6 addressed)
- Backup/restore implications documented (D7 addressed)
- `OPENVIKING_API_KEY`, `MCP_API_KEY`, `EMBEDDING_API_KEY` in secret maps (H1 resolved)

What needs updating:
- **`registerComponentSecrets` has a naming collision risk.** If two different component instances both have a field named `DISCORD_BOT_TOKEN`, the dynamic `ENV_TO_SECRET_KEY` map will have the second registration overwrite the first. The map uses the env var name as the key, but the secret path includes the instance ID. This works for the pass store path but breaks for the dynamic lookup. Each instance's `.env` file should use the instance-scoped secret, but the `ENV_TO_SECRET_KEY` map cannot distinguish between two instances with the same field name.
- **Phase ordering dependency.** Phase 1 (auth refactor) is a hard prerequisite for Phase 4 (secrets API) and for #304. This should be stated as a critical-path item.
- **`pass-init.sh` uses `eval` for generator commands** (line `eval "$generator" | pass insert -m ...`). This is a shell injection risk. Use a function or direct command instead.

**Recommendation: Fix the component secret naming collision in the plan. Remove `eval` from `pass-init.sh`. Add critical-path annotation for Phase 1.**

### openpalm-unified-registry-plan.md

**Status:** Well-updated for review decisions.

What is correct:
- Automations explicitly out of scope (Q7 applied)
- Legacy channel format replaced entirely (Q8 applied)
- Clean component-directory-based model
- Catalog entry removal does not orphan instances (D9 addressed)
- Archive retention noted (D4 addressed)

What needs updating:
- **Removed endpoint mapping is stale.** The "Removed / Replaced by" table references `GET /admin/gallery/search`, `POST /admin/gallery/install`, etc. These endpoints should be verified against the current codebase to ensure completeness.
- **Built-in component source.** The plan says "Built-in --- `components/` in the repo." But the current codebase has channels defined as YAML files in `registry/channels/` (e.g., `chat.yml`, `discord.yml`). These need to be migrated to component directories. The plan should specify what happens to `registry/channels/` and `packages/lib/assets/channels/`.
- **The `index.json` auto-generation** is described but no CI step is defined. This should be part of the implementation tasks.

**Recommendation: Verify endpoint mapping against current codebase. Add migration plan for existing `registry/channels/*.yml` files. Add CI task for index generation.**

### review-decisions.md

**Status:** Complete and well-structured. All 10 decisions are clear with affected-plans cross-references.

No changes needed. This document serves its purpose as a decision log.

### review-report.md

**Status:** Complete. The earlier cross-plan alignment review was thorough.

No changes needed. All findings have been addressed in review-decisions.md and (mostly) incorporated into plan documents.

## Cross-Plan Alignment

Checking whether each decision from review-decisions.md is properly reflected in the plan documents:

| Decision | Knowledge Roadmap | Components Plan | Pass Plan | Registry Plan | Status |
|----------|:-:|:-:|:-:|:-:|--------|
| Q1 Viking = component | Applied | N/A | N/A | N/A | OK |
| Q2 Preserve three-tier XDG | N/A | Applied | N/A | N/A | OK |
| Q3 Unified secret manager | N/A | Applied | Applied | N/A | OK |
| Q4 ADMIN_TOKEN for brokered instance | Applied | N/A | Applied | N/A | OK |
| Q5 Shell automation fallback | Applied | N/A | N/A | N/A | OK |
| Q6 Q-values in memory service | Applied | N/A | N/A | N/A | OK |
| Q7 Automations separate | N/A | N/A | N/A | Applied | OK |
| Q8 Clean break, no migration | N/A | Applied | N/A | Applied | OK |
| Q9 ov.conf in DATA_HOME | Applied | N/A | N/A | N/A | OK |
| Q10 Wizard prompts, plaintext default | N/A | N/A | Applied | N/A | OK |

**All 10 decisions are reflected in the relevant plan documents.** The review-decisions.md cascade was properly incorporated.

Remaining items from the review-report.md that are NOT fully resolved:

- **M7 (Assistant container missing Viking env vars):** The knowledge roadmap acknowledges this ("OPENVIKING_URL and OPENVIKING_API_KEY are injected into the assistant's environment via the Viking component's compose overlay") but does not show the compose overlay that does this. The component plan does not define the mechanism for cross-component environment injection. This gap persists.

- **D3 (compose.yml naming):** Acknowledged in the registry plan ("This is a deliberate choice") but not documented in a way that contributors would see. Should be in a contributing guide or the components plan itself.

- **D5 (Docker volume cleanup on component deletion):** The components plan now mentions "Clean up Docker volumes created by the component" in the delete flow. Resolved.

## Missing Concerns

### 1. CLI Orchestrator Parity

The component model is described entirely from the admin's perspective. Core principle: "Host CLI or admin is the orchestrator. The host CLI manages Docker Compose directly on the host." The CLI in `packages/cli/` must support creating/managing component instances without admin. The staging pipeline (`packages/lib/src/control-plane/staging.ts`) must be updated for the component model. No plan addresses this.

### 2. Cross-Component Environment Injection

When Viking (a component) needs the assistant (a core service) to have `OPENVIKING_URL` in its environment, how does this work? Compose overlay merge rules can add environment variables to existing services, but this requires the component's `compose.yml` to reference the core service name (`assistant`). This creates a coupling between component overlays and core service names. No plan documents this pattern or its constraints.

### 3. Upgrade Path Documentation

Decision Q8 says clean break, no migration. But the plans do not specify what happens during `openpalm update` from 0.9.x to 0.10.0. The CLI's update command, the admin's lifecycle transitions, and the staging pipeline all need to handle the format change. What does the user experience look like? Is there a pre-flight check that detects legacy channels and warns before upgrading?

### 4. Scheduler Integration with Components

The scheduler (`packages/scheduler/`) runs automations including shell actions. The knowledge roadmap adds eval and maintenance scripts as shell automations. But the scheduler's access to component state (e.g., knowing which components are installed, accessing their env vars) is not documented. Does the scheduler run inside a container? Does it have access to `DATA_HOME/components/enabled.json`?

### 5. Testing Strategy for the Component Model

The component model is a fundamental architectural change. The test suites table in CLAUDE.md covers admin unit tests, guardian tests, SDK tests, and E2E tests. None of these cover the component lifecycle (create, configure, start, stop, delete). No plan specifies what test coverage the component model needs.

### 6. Admin API Path Inconsistency

The components plan uses `/api/components` and `/api/instances` (no `/admin/` prefix). The registry plan uses `/api/registry`. But the existing admin API uses `/admin/*` for everything. The pass plan uses `/admin/secrets`. The knowledge roadmap uses `/admin/viking/*` and `/admin/knowledge/*`. These should be consistent. Either all new endpoints use `/api/` or all use `/admin/`.

## Recommendations

1. **REMOVE** #302 (TTS/STT) from the 0.10.0 milestone. No plan, no architectural analysis, no dependencies. Defer to 0.11.0 or later.

2. **UPDATE** #13 (Advanced Channel Configuration): close as superseded by the component plan. Document which specific features are deferred (per-channel OpenCode config, custom config UIs, instance-level metrics).

3. **UPDATE** #301 (Configurable Services): retitle to "Unified Component System" and make it the tracking issue for the components plan, or close it and create a dedicated component-system tracking issue.

4. **UPDATE** #298 (OpenViking): scope to Viking component + assistant tools only (Phases 1A-1D). Create separate issues for: MCP server component, eval framework, MemRL feedback loop. Defer eval and MemRL to 0.11.0.

5. **ADD** a "CLI Integration" section to `openpalm-components-plan.md` covering how the CLI creates/manages component instances, how `staging.ts` changes, and how `fullComposeArgs()` builds the overlay chain from `enabled.json`.

6. **ADD** a "Cross-Component Dependencies" section to `openpalm-components-plan.md` documenting the pattern for one component's compose overlay to inject env vars into another service, including constraints and naming conventions.

7. **ADD** an upgrade-path document (or section in the components plan) specifying the 0.9.x -> 0.10.0 migration experience: pre-flight detection of legacy channels, user warnings, and the expected manual steps.

8. **UPDATE** `openpalm-pass-impl-v3.md` to fix the `registerComponentSecrets` naming collision for instances with identical field names. Each instance's env vars should be scoped (e.g., `DISCORD_MAIN__DISCORD_BOT_TOKEN` or similar) or the resolution should happen at compose-time via instance-specific `--env-file`, not through a global map.

9. **UPDATE** `openpalm-pass-impl-v3.md` to remove the `eval` call in `pass-init.sh` and replace with a direct command execution.

10. **ADD** a testing strategy section to the components plan covering: component lifecycle unit tests, compose overlay integration tests, Caddy route staging tests, and enabled.json persistence tests.

11. **UPDATE** the admin API path convention across all plans to be consistent. Recommended: keep `/admin/*` for all admin-authenticated endpoints (matching the existing convention), or if migrating to `/api/*`, do it as a single coordinated change.

12. **UPDATE** `knowledge-system-roadmap.md` to split into separate documents: Viking integration (0.10.0), MCP component (0.10.0), eval framework (0.11.0), MemRL feedback loop (0.11.0).

13. **ADD** a note to #315 (Azure Container Apps) documenting the XDG tier deviation where DATA_HOME and STATE_HOME share a single Azure Files mount.

14. **UPDATE** `openpalm-components-plan.md` to clarify the boundary between core services (stay in `docker-compose.yml`), optional services (migrate to components?), and new components. Specifically: does Caddy move from `OPTIONAL_SERVICES` to a component? Does `docker-socket-proxy`?

15. **ADD** a scheduler integration section to the components plan or the knowledge roadmap, documenting how the scheduler accesses component state and what environment it runs in.

---

## Addendum: Filesystem & Mounts Refactor Review (2026-03-19)

### Summary

The fs-mounts-refactor proposal (`fs-mounts-refactor.md` + `fs-layout.md`) is a well-argued simplification that replaces the three-tier XDG model with a single `~/.openpalm/` root containing four purpose-separated subdirectories (`config/`, `vault/`, `data/`, `logs/`) plus `~/.cache/openpalm/` for ephemeral data. It directly contradicts review-decision Q2 ("Preserve the three-tier XDG model"), which means adopting it requires an explicit decision reversal. The proposal's core architectural insight is sound: the staging tier adds operational overhead disproportionate to its safety benefit for a single-user self-hosted stack. However, the proposal also introduces new complexity (hot-reload file watchers, validate-in-place with snapshot rollback, vault filesystem boundary) that must be evaluated against what it replaces, not just against the status quo.

### Core Principles Impact

**Preserved:**
- Goal 1 (file-drop modularity): Fully preserved. `config/components/` is the file-drop location for compose overlays, directly analogous to the current `CONFIG_HOME/channels/`.
- Goal 2 (assistant extensions by file copy): Preserved. `config/assistant/` serves the same role as `CONFIG_HOME/assistant/`.
- Goal 3 (host-stored config for advanced users): Improved. Everything is under one root, which makes discovery easier.
- Goal 4 (leverage Docker Compose/Caddy/OpenCode native features): Preserved. The compose invocation pattern (`--env-file vault/system.env --env-file vault/user.env -f config/components/*.yml`) is standard Compose.
- Goal 5 (no template rendering): Preserved. The proposal explicitly avoids string interpolation; compose files are passed unchanged.
- Goal 6 (never overwrite user files during automatic lifecycle): Preserved. The proposal explicitly states `vault/user.env` is never touched by upgrades, and `openpalm.yml` and user-installed channel overlays are not overwritten.
- Goal 7 (all persistent data on host): Preserved. `data/` replaces DATA_HOME.
- Goal 8 (user-accessible files): Improved. Single `~/.openpalm/` directory is easier to find, navigate, and manage permissions for.
- Goal 9 (core extensions baked into container): Not affected by this proposal.

**Violated:**
- Filesystem contract section 3 (STATE_HOME as assembled runtime): Eliminated. There is no STATE equivalent. The proposal replaces the staging model entirely with validate-in-place + rollback. `core-principles.md` would require a substantial rewrite of sections "Filesystem contract" (all three tiers) and "Volume-mount contract" (sections A, B, D).
- Security invariant 3 (assistant isolation mount list): Changed. The proposal lists the assistant's mounts as: `config/`, `config/assistant/`, `vault/user.env`, `data/assistant/`, `data/stash/`, `data/workspace/`, `logs/opencode/`, and `~/.cache/openpalm/registry/`. The current core-principles.md restricts assistant mounts to `DATA_HOME/assistant`, `CONFIG_HOME/assistant`, `DATA_HOME/opencode`, `STATE_HOME/opencode`, and `WORK_DIR`. The new mount list is different (notably: `config/` is mounted at `/etc/openpalm` read-only, giving the assistant read access to compose overlays and `openpalm.yml` which it cannot currently see). This is a minor expansion of the assistant's read surface. Whether this matters depends on whether compose overlays or stack config contain sensitive information — they should not, since secrets are in `vault/`, but it is a change.

**Improved:**
- Secret isolation is strictly improved. The current model uses `env_file:` to bulk-inject all secrets (both `stack.env` and `secrets.env`) into guardian and admin. The guardian currently has a bind mount to `STATE_HOME/artifacts/` (read-only) which includes the full `stack.env`. The proposal eliminates this: guardian receives only its specific secrets via `${VAR}` substitution, and the only mounted secrets file is `vault/user.env` into the assistant (read-only). This is a meaningful security improvement.
- Backup/restore is substantially improved. One directory, one `tar` command. The current model requires archiving two or three XDG directories spread across `~/.config/`, `~/.local/share/`, and `~/.local/state/`.
- Cognitive load for operators is reduced. 31 pre-created directories across 3 filesystem subtrees becomes 4 top-level directories under a single root.

### Decision Q2 Reassessment

**Should the three-tier XDG decision be reversed? Yes, with caveats.**

Q2 was made on 2026-03-15 in response to concern C2 (the components plan proposed eliminating CONFIG_HOME, which would break the three-tier contract). At that time, the alternative was not articulated — the only proposal was "remove CONFIG_HOME and put everything in DATA_HOME." The fs-mounts-refactor proposal is qualitatively different: it preserves the *semantics* of all three tiers (user-owned config, service-owned data, assembled runtime) while collapsing them under a single root and replacing the "assembled runtime" tier with a validate-in-place + rollback model.

The XDG base directory specification is designed for multi-application desktop systems where applications share `~/.config/`, `~/.local/share/`, and `~/.local/state/`. OpenPalm is a single-purpose self-hosted stack — the XDG directories contain only OpenPalm's files. Spreading them across three `~/.something/openpalm/` locations provides no benefit to a user who never has other applications in those same XDG trees. The fs-mounts-refactor correctly identifies that the XDG compliance adds operational cost (navigating three subtrees, archiving multiple directories, understanding the staging pipeline) without proportional benefit for this use case.

**Caveats:**
1. The proposal must explicitly document that `~/.openpalm/` is a departure from XDG, and why.
2. Environment variables (`OPENPALM_CONFIG_HOME`, `OPENPALM_DATA_HOME`, `OPENPALM_STATE_HOME`) must be replaced with a single `OPENPALM_HOME` variable (the proposal implies this with `OPENPALM_HOME` in `vault/system.env`). The old variables should be checked and produce a clear error or migration message if present.
3. The `config/` and `vault/` subdirectories must maintain the ownership/permission semantics that CONFIG_HOME had: user-editable, never overwritten by lifecycle operations. The proposal states this, but it should be formalized as a rule in the updated core-principles.md.

### Staging Tier Elimination Assessment

**What the staging tier currently provides:**
1. Services never read directly from user-editable files — they read staged copies.
2. A failed apply leaves the previous staged artifacts intact (implicit rollback).
3. `manifest.json` tracks checksums for change detection.
4. The admin container can reconstruct STATE from CONFIG + DATA.

**What validate-in-place + rollback provides:**
1. Pre-write validation (varlock schema check, `docker compose config --dry-run`, `caddy validate`) catches errors before any file is modified.
2. Explicit snapshot to `~/.cache/openpalm/rollback/` preserves the previous state.
3. Automated rollback on health check failure after deploy.
4. Manual `openpalm rollback` as an escape hatch.

**Pros of the new model:**
- Eliminates the `persistArtifacts()` function and its 11 staging operations (compose, caddyfile, ollama overlay, admin overlay, channel YMLs, channel caddyfiles, automations, env schemas, stack.env, secrets.env, manifest.json).
- Eliminates the `stateDir` concept from `ControlPlaneState`, simplifying the type system.
- Validation against temp files is actually safer than the current model, which writes staged files first and discovers errors only when `docker compose up` fails.
- Rollback is explicit and automated, whereas the current model has only implicit rollback (the admin regenerates STATE from CONFIG+DATA, which requires the admin container to be running).

**Cons of the new model:**
- The rollback directory in `~/.cache/openpalm/rollback/` is ephemeral (XDG cache semantics). If the cache is cleared between a failed apply and a rollback attempt, the rollback data is lost. The proposal should document this risk and consider whether rollback data should live in `~/.openpalm/backups/` instead (the layout diagram shows a `backups/` directory that exists for this purpose).
- The "services read live files" model means that if the admin container crashes mid-write to `config/components/core.yml`, the file could be partially written. The staging model avoided this by writing to STATE and then reading from STATE — a crashed write to STATE was harmless because CONFIG+DATA were intact. The proposal should specify atomic writes (write to temp, rename) for all config file mutations.
- `manifest.json` change detection is lost. The proposal does not describe how the system detects whether files have changed since the last apply. This matters for idempotent operations (e.g., `openpalm apply` when nothing has changed should be a no-op).

**Assessment: The staging tier elimination is architecturally sound if two gaps are addressed.** (1) Rollback data should live in `~/.openpalm/backups/` not `~/.cache/`. (2) All config file writes must be atomic (temp + rename).

### Vault Boundary Assessment

The `vault/` directory as the secrets boundary is a clear improvement over the current model.

**Current model problems identified in the proposal (verified against `assets/docker-compose.yml` and `assets/admin.yml`):**
- Guardian loads `stack.env` via both `env_file:` and bind mount, receiving all secrets (including LLM keys it never uses).
- Admin loads both `stack.env` and `secrets.env` via `env_file:`, receiving HMAC secrets it does not need for most operations.
- The admin container mounts all three XDG trees using identical host-to-container paths (confirmed in `admin.yml` lines 104-106), meaning it has read-write access to every file the user owns.
- `OPENAI_API_KEY` appears in `secrets.env`, staged `secrets.env`, and explicit `environment:` blocks of three containers.

**Vault model improvements:**
- `vault/system.env` is mounted only into admin (rw). Guardian, scheduler, memory, and caddy never mount it.
- `vault/user.env` is mounted only into assistant (ro) and admin (rw). No other container can read LLM keys from disk.
- Guardian receives only its specific HMAC secrets and admin token via `${VAR}` substitution at container creation time. This eliminates the over-broad `env_file:` approach.
- The admin's vault mount (`vault/` at `/etc/openpalm/vault/`) is scoped to the vault directory, not the entire filesystem tree.

**Concerns:**
1. The proposal says "no container except admin can access `system.env`" but the compose invocation uses `--env-file vault/system.env --env-file vault/user.env` host-side. Docker Compose reads these files on the host and substitutes `${VAR}` references in all compose files. This means all containers that use `${VAR}` in their `environment:` blocks will receive those values at creation time — they just cannot read the raw files at runtime. This is correct behavior but should be documented clearly to avoid confusion: the vault boundary restricts file-level access, not env-var injection.
2. `vault/ov.conf` for OpenViking config is an odd placement. Decision Q9 said "ov.conf in DATA_HOME" because Viking is a component and its config belongs with its instance data. The refactor proposal puts `ov.conf` in `vault/` alongside secrets. If `ov.conf` contains secrets (API keys), vault is appropriate. If it is primarily configuration (embedding model, workspace paths), it belongs in `config/` or in the component instance directory. This needs clarification.

### Plan Compatibility

**Components plan (`openpalm-components-plan.md`):**
- The components plan references `${OPENPALM_DATA}/components/` for instance directories and `${OPENPALM_STATE}/components/` for runtime state. Under the refactor, these would become `~/.openpalm/data/components/` (instances) — but the refactor's `config/components/` directory holds compose overlays (e.g., `core.yml`, `admin.yml`, `channel-slack.yml`), which is a different concept than the components plan's instance directories.
- **Conflict:** The components plan puts component instances in DATA_HOME with full instance directories (compose.yml + .env.schema + .env + data/). The refactor puts compose overlays in `config/components/`. These are two different things: the refactor's `config/components/core.yml` is the base stack definition, while the components plan's `DATA_HOME/components/discord-main/` is an instance with runtime data. The refactor needs to reconcile: where do component instance directories live? The refactor's `data/` directory is the natural location, which aligns with the components plan's `DATA_HOME/components/`.
- **Missing from refactor:** The refactor does not mention `enabled.json`, instance directories, per-instance `.env` files, or the component lifecycle at all. It describes a simpler model where compose overlays are dropped into `config/components/` and listed in `openpalm.yml`. The components plan's richer instance model must be integrated.

**Pass plan (`openpalm-pass-impl-v3.md`):**
- The pass plan references `CONFIG_HOME/secrets.env` (plaintext default) and `DATA_HOME/secrets/pass-store/` (encrypted backend). Under the refactor, `CONFIG_HOME/secrets.env` becomes `vault/user.env` (for user-facing secrets) and `vault/system.env` (for system secrets). The pass plan's `PlaintextBackend` would need to read/write `vault/user.env` instead of `CONFIG_HOME/secrets.env`.
- The pass plan's `provider.json` at `DATA_HOME/secrets/` would move to either `vault/` or `data/secrets/`. Since it controls the secrets backend, `vault/` is a reasonable location.
- The pass plan's `CORE_ENV_TO_SECRET_KEY` map conflates user-facing secrets (LLM keys in `user.env`) with system secrets (ADMIN_TOKEN, MEMORY_AUTH_TOKEN in `system.env`). Under the refactor, these are in different files with different access rules. The `PlaintextBackend` would need to know which file to read/write for each key, or the interface would need to be split.
- **The two-file split creates a complication for the pass backend.** When `pass` is the backend, all secrets are in the pass store regardless of user/system classification. The two-file model is a plaintext-specific concern. The pass plan and refactor proposal need to be reconciled: are `user.env` and `system.env` the plaintext backend's files, with encrypted backends ignoring them entirely? Or do they exist alongside the encrypted backend as resolved-value caches?

**Knowledge system roadmap:**
- The roadmap references `DATA_HOME` for `ov.conf` (decision Q9). The refactor puts `ov.conf` in `vault/`. This needs reconciliation (see vault assessment above).

**Registry plan:**
- Minimal impact. The registry plan deals with component discovery and catalog management, which is independent of the filesystem layout of the running stack.

### Hot-Reload Assessment

The `user.env` hot-reload via file watcher is an elegant UX improvement but introduces architectural considerations:

1. **Process.env mutation is global and non-atomic.** The proposed `loadUserEnv()` function writes to `process.env` key-by-key. If the assistant reads `OPENAI_API_KEY` between the write of `OPENAI_API_KEY` and `OPENAI_BASE_URL`, it could get a new key with an old base URL. For LLM provider config where key and URL are paired, this is a real (if unlikely) race. The loader should parse the entire file, build the complete update, and apply it atomically (or use a separate config object rather than `process.env`).

2. **OpenCode's provider system may not support runtime key changes.** OpenCode initializes AI SDK providers at startup. Changing `process.env.OPENAI_API_KEY` after initialization may not take effect until the next provider construction. The proposal should verify that OpenCode re-reads environment variables per-request rather than caching them at startup. If OpenCode caches, the hot-reload provides a false sense of immediacy — the key would take effect only when OpenCode internally reconstructs its provider objects.

3. **The `ALLOWED_KEYS` allowlist is a security boundary.** If a malicious or buggy write to `user.env` adds `HOME=/tmp` or `PATH=/malicious`, the allowlist prevents it from affecting the assistant. This is good design. But the allowlist must be kept in sync with the `user.env.schema` — if new keys are added to the schema without updating the allowlist, they will not be hot-reloaded. This should be a single source of truth, not two hardcoded lists.

4. **File watcher reliability.** `fs.watch` has known issues on some platforms (particularly NFS, CIFS, and some container overlay filesystems). Since `user.env` lives on a bind-mounted host directory, this should work on standard setups but may fail in unusual Docker configurations. A polling fallback (check mtime every N seconds) would be more robust.

### Cascade: What Changes If This Proposal Is Adopted

1. **`docs/technical/core-principles.md`** — Major rewrite required. All three filesystem tier definitions, the volume-mount contract (sections A through F), and the operational behavior section must be updated. The three-tier model is deeply embedded in this document.
2. **`review-decisions.md`** — Q2 must be explicitly reversed with rationale. Q9 (ov.conf in DATA_HOME) needs reassessment if vault is the new location.
3. **`openpalm-components-plan.md`** — Must reconcile `config/components/` (compose overlays) with `data/components/` (instance directories). The Directory Summary section near the end currently shows `${OPENPALM_CONFIG}/`, `${OPENPALM_DATA}/components/`, and `${OPENPALM_STATE}/components/` — all three tiers would need updating.
4. **`openpalm-pass-impl-v3.md`** — `PlaintextBackend` must be updated to understand the two-file model (`user.env` vs `system.env`). Phase 0 references to `stageSecretsEnv()` become irrelevant. The `CONFIG_HOME contract note` section needs rewriting.
5. **`packages/lib/src/control-plane/paths.ts`** — `resolveConfigHome()`, `resolveDataHome()`, `resolveStateHome()` collapse into `resolveOpenPalmHome()` plus subdirectory accessors.
6. **`packages/lib/src/control-plane/staging.ts`** — Entire file is replaced. `persistArtifacts()`, `stageArtifacts()`, all stage functions, and the manifest system are eliminated. A new validation + snapshot + apply pipeline takes their place.
7. **`packages/lib/src/control-plane/setup.ts`** — `ensureXdgDirs()` is rewritten to create the `~/.openpalm/` tree.
8. **`assets/docker-compose.yml`** and `assets/admin.yml`** — All volume mount paths change from `${OPENPALM_DATA_HOME:-...}` / `${OPENPALM_STATE_HOME:-...}` / `${OPENPALM_CONFIG_HOME:-...}` to `${OPENPALM_HOME:-...}/data/`, `${OPENPALM_HOME:-...}/vault/`, `${OPENPALM_HOME:-...}/config/`. The `env_file:` directives change. Guardian loses its bind mount to artifacts.
9. **`packages/cli/src/lib/staging.ts`** — `fullComposeArgs()` must be rewritten to use the new overlay chain from `config/components/` and `openpalm.yml`.
10. **`CLAUDE.md`** — XDG Directory Model table, Architecture Rules summary, Build & Dev Commands, and any references to CONFIG_HOME/DATA_HOME/STATE_HOME need updating.
11. **`scripts/dev-setup.sh`** — Must create `~/.openpalm/` structure instead of `.dev/config`, `.dev/data`, `.dev/state`.
12. **All existing tests** that reference XDG paths (unit tests in `paths.test.ts`, staging tests, install edge case tests) need updating.

### Recommendations

1. **REVERSE** decision Q2 (preserve three-tier XDG). The fs-mounts-refactor makes a compelling case that the single-root model preserves the semantic separation (user-config vs service-data vs secrets) while eliminating operational overhead. The original Q2 decision was made before this alternative was articulated. Reversing Q2 should be documented with full rationale in `review-decisions.md`.

2. **UPDATE** the refactor proposal to reconcile `config/components/` (compose overlay drop zone) with the components plan's instance model (`data/components/` with per-instance directories, enabled.json, .env files). Currently these are two unconnected concepts. Recommended resolution: `config/components/` holds system-managed compose overlays (core.yml, admin.yml) and user-dropped channel overlays; `data/components/` holds instance directories per the components plan. `openpalm.yml` lists which system-level components are enabled; `data/components/enabled.json` lists which instances are active.

3. **UPDATE** the refactor proposal to move rollback data from `~/.cache/openpalm/rollback/` to `~/.openpalm/backups/rollback/`. Cache directories may be cleared by OS maintenance, package managers, or user cleanup scripts. Rollback data is safety-critical during apply operations and should not be ephemeral.

4. **UPDATE** the refactor proposal to specify atomic writes for all config/vault file mutations (write to temporary file, `fsync`, rename to target path). The staging model provided implicit atomicity; validate-in-place does not.

5. **UPDATE** the refactor proposal to clarify `vault/ov.conf` placement. If `ov.conf` contains secrets (API keys for the Viking backend), vault is appropriate. If it is primarily non-secret configuration, it belongs in the component instance directory under `data/components/openviking/` per decision Q9 and the component model. Recommend keeping Q9 as-is (ov.conf in the component instance directory) unless it genuinely contains secrets that warrant vault placement.

6. **UPDATE** `openpalm-pass-impl-v3.md` to handle the two-file model. The `PlaintextBackend` must know that user-facing secrets (LLM keys, provider URLs) live in `vault/user.env` and system secrets (admin token, HMAC secrets) live in `vault/system.env`. The `write()` method needs a way to determine which file to target — either by key prefix convention or by maintaining an explicit mapping.

7. **UPDATE** the hot-reload implementation to: (a) apply env var changes atomically (parse full file, then swap all values); (b) verify OpenCode re-reads `process.env` per-request rather than caching provider config at startup; (c) derive the `ALLOWED_KEYS` set from the `user.env.schema` rather than hardcoding it; (d) add a polling fallback for platforms where `fs.watch` is unreliable.

8. **ADD** a migration section to the refactor proposal for the 0.9.x to 0.10.0 transition. Users currently have files in `~/.config/openpalm/`, `~/.local/share/openpalm/`, and `~/.local/state/openpalm/`. The upgrade must detect these, move them to the new layout, and handle the `OPENPALM_CONFIG_HOME` / `OPENPALM_DATA_HOME` / `OPENPALM_STATE_HOME` environment variables (error if set, with migration guidance).

9. **UPDATE** the assistant mount list to justify mounting `config/` at `/etc/openpalm` (read-only). The current core-principles.md restricts assistant mounts to specific subdirectories. Mounting all of `config/` gives the assistant read access to compose overlays and `openpalm.yml`. While these should not contain secrets (vault is separate), this is a broader read surface than the current model. If the assistant does not need compose overlays, mount only `config/assistant/` and `config/automations/` (if needed).

10. **ADD** a change-detection mechanism to replace `manifest.json`. The validate-in-place model needs a way to determine whether an `openpalm apply` is a no-op (nothing changed since last apply). Options: checksum file in `~/.openpalm/` tracking last-applied hashes of config files, or timestamp comparison. Without this, every `apply` will snapshot + validate + write + deploy even when nothing has changed.

11. **UPDATE** `core-principles.md` comprehensively if this proposal is adopted. This is not a patch — it is a rewrite of sections 3 (filesystem contract), 4 (volume-mount contract), and 5 (operational behavior). The rewrite should preserve the *invariant structure* (numbered goals, security invariants, named contracts) while updating the content to reflect the new layout. Do not simply delete the old text and add new text — the numbered goals and security invariants should be updated in place so that cross-references from other documents remain valid.

12. **UPDATE** the mount count table in the refactor proposal (Section 5.2). The proposal claims assistant goes from 6 to 8 mounts, but the current `docker-compose.yml` shows 6 assistant mounts. Adding `config/` and `vault/user.env` as new mounts on top of the existing functional mounts brings the total to 8, which is correct. However, the proposal should note that the 8 mounts serve a broader purpose than the current 6 (hot-reload and config visibility) and explain why the increase is acceptable despite not reducing mount count.
