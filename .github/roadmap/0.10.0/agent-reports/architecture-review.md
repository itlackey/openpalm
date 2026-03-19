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
