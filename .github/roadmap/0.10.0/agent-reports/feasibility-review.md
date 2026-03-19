# Implementation Feasibility Review — v0.10.0 Milestone

## Summary

v0.10.0 attempts to simultaneously rebuild the extension system (components replacing channels), introduce a knowledge/learning layer (OpenViking + MemRL), add secrets management (Varlock/pass), create an MCP server, build an eval framework, embed an admin OpenCode instance, and add TTS/STT — all targeting a 6-week window. The component system alone is a foundational rewrite touching staging, lifecycle, registry, Caddy routing, the admin API, the admin UI, the CLI, and the setup wizard. Layering five other major features on top makes this milestone overloaded. The "24 working days across 6 weeks" estimate in the knowledge roadmap accounts only for knowledge-system work and ignores the component system rewrite, Varlock integration, TTS/STT, Azure deployment, and advanced channel config — each of which is multi-week work. Realistic delivery requires splitting this into at least two releases.

---

## Issues Assessment

### #301 — Configurable Services (Components System)

**Feasibility:** High, but effort is severely underestimated. This is the foundational rewrite that every other issue depends on.

**Effort estimate:** The components plan lists 5 implementation phases with no time estimates. Based on the current codebase analysis:

- **Phase 1 (Core)** rewrites the staging pipeline (`staging.ts` — 399 lines), the channel discovery system (`channels.ts` — 199 lines), the compose file builder and managed services builder (`lifecycle.ts` — 382 lines), the CLI staging pipeline (`cli/src/lib/staging.ts`), and the Docker runner (`docker.ts` — 449 lines). It also introduces the `enabled.json` persistence layer, the `INSTANCE_ID`/`INSTANCE_DIR` env var convention, dynamic allowlists, and Caddy snippet staging for components. The current `discoverChannels()` scans `CONFIG_HOME/channels/` for `.yml` files — this entire flow must be replaced with `DATA_HOME/components/` instance scanning. The `buildComposeFileList()` and `buildManagedServices()` functions that currently enumerate core, admin, ollama, and channel YMLs must be rewritten for the `-f`/`--env-file` chain pattern. This is approximately 1,500-2,000 lines of changed/new code in `@openpalm/lib` alone. **Estimate: 8-10 working days.**

- **Phase 2 (Admin API)** adds 12+ new API endpoints (`/api/components`, `/api/instances`, `/api/instances/:id/config`, etc.) replacing most of the current `/admin/channels/*`, `/admin/registry/*`, and `/admin/installed` routes. The existing `RegistryProvider` interface (`channelYml()`, `channelCaddy()`, `channelNames()`, `automationYml()`, `automationNames()`) must be reworked or replaced for the component model. **Estimate: 5-6 working days.**

- **Phase 3 (Admin UI)** replaces the current Extensions tab and adds the Components tab with instance cards, config form renderer (from `.env.schema`), category grouping, and the instance lifecycle controls. The setup wizard also needs a new "Optional Components" step. **Estimate: 4-5 working days.**

- **Phase 4 (Registry)** rewrites `registry/channels/` to `registry/components/`, builds the index generator, adds CI validation. **Estimate: 2-3 working days.**

- **Phase 5 (Docs)** — upgrade documentation, breaking change notes. **Estimate: 1-2 working days.**

**Total realistic estimate: 20-26 working days (4-5 weeks).**

**Breaking change impact:** The clean break from `CONFIG_HOME/channels/*.yml` (review-decisions Q8) is significant. Every existing installation's channels stop working on upgrade. The upgrade path ("uninstall old channels, upgrade, reinstall as components") requires users to manually reconfigure all channel secrets. This is acceptable for an alpha/beta project but must be prominently documented.

**Recommendation: KEEP — this is the cornerstone of 0.10.0. But acknowledge it alone consumes most of a 6-week release window.**

---

### #300 — Password Manager (Varlock Improvements)

**Feasibility:** Moderate. The 8-phase plan (openpalm-pass-impl-v3.md) is thorough but ambitious.

**Effort estimate:** The plan spans Phases 0-7:
- Phase 0 (Varlock hardening — permissions, redact schema): 1-2 days
- Phase 1 (Auth refactor — ADMIN_TOKEN/ASSISTANT_TOKEN split): 3-4 days. Touches every admin API route's auth middleware, the `ControlPlaneState` type, `createState()`, `secrets.ts`, guardian auth, and scheduler auth. The current `requireAdmin()` is already in `helpers.ts` — this adds `requireAuth()` and `identifyCallerByToken()` and migrates ~18 route directories.
- Phase 2 (Secret backend abstraction): 2-3 days. New `SecretBackend` interface + `PlaintextBackend`.
- Phase 3 (pass provider): 2-3 days. GPG integration, `pass` CLI shelling.
- Phase 4 (Secrets API routes): 2-3 days
- Phase 5 (Password manager UI): 2-3 days
- Phase 6 (Connections endpoint refactor): 2-3 days
- Phase 7 (Migration tooling): 1-2 days

**Dependency on #301:** The unified secret manager must integrate with the component lifecycle (Q3 decision). `@sensitive` fields in `.env.schema` files flow through the secret backend. This means Phase 2+ of #300 cannot finalize until #301's Phase 1 (component directory structure and `.env.schema` parsing) is at least scaffolded.

**Total realistic estimate: 15-23 working days.** Phase 0-1 can ship early. Phases 2-7 require #301's component model.

**Recommendation: SPLIT.** Phase 0-1 (hardening + auth refactor) stays in 0.10.0. Phases 2-7 (pass provider, secrets API, UI, migration) defer to 0.11.0. The `PlaintextBackend` is the default and existing behavior — encrypted storage via `pass` is opt-in and can land later without breaking the component system.

---

### #298 — Add OpenViking Integration

**Feasibility:** Moderate. The knowledge roadmap's plan is well-structured but depends heavily on #301 (component system) and partially on #300 (secret management for `OPENVIKING_API_KEY`).

**Effort estimate per the plan:** 6 days (Phases 1A-1D). This is **underestimated**.

- Phase 1A (Viking component directory): 1 day — realistic, but only if the component system (#301) is already built. Creating `registry/components/openviking/compose.yml` + `.env.schema` is straightforward; the admin API and staging pipeline that consume it are part of #301.
- Phase 1B (Viking assistant tools): 2 days — reasonable. Porting the agentikit client and creating 6 tool wrappers following the existing `memoryFetch()` pattern is well-scoped. Currently `packages/assistant-tools/src/index.ts` has 15 tools — adding 6 more is incremental.
- Phase 1C (Session memory extraction): 2 days — **risky.** The `MemoryContextPlugin` hooks (`session.created`, `tool.execute.after`, `session.idle`) are the heart of the integration. Wiring Viking's SessionService alongside the existing memory hooks adds conditional branching to a critical path. Testing requires a running OpenViking instance with embedding configured.
- Phase 1D (Token budget utilities): 1 day — reasonable for a copy-and-adapt from Hyphn.

**Hidden prerequisite:** The assistant container's compose environment block (`assets/docker-compose.yml`) has no `OPENVIKING_URL` or `OPENVIKING_API_KEY`. With Viking as a component, these must be injected via the component's compose overlay affecting the assistant service — but component overlays add new services, they don't modify existing ones. The assistant needs a mechanism to discover optional components (e.g., reading a components manifest, or the component overlay adding env vars to the assistant via a Compose extends pattern). This is a design gap not addressed in the plans.

**Total realistic estimate: 8-10 working days** (including the component system prerequisite and the assistant env var injection mechanism).

**Recommendation: DEFER to 0.11.0.** Phase 1B (Viking tools) could be prototyped in 0.10.0 as dormant code gated on env vars, but the full integration requires the component system to be stable. The MCP server and eval framework (Priorities 2 and 3) also depend on Viking, creating a cascade.

---

### #304 — Brokered Admin-Authorized OpenCode Instance

**Feasibility:** Moderate-low. This embeds a second OpenCode instance inside the admin container with ADMIN_TOKEN access (Q4 decision). No code exists yet.

**Effort estimate:** Not explicitly estimated in any plan, but the knowledge roadmap notes it as "tracked separately" and schedules it for Phase B (Week 3-4).

**Implementation scope:**
- Admin container must run an embedded OpenCode process (separate from the user's assistant container)
- Admin UI must expose a chat interface for the embedded instance
- The instance needs admin-tools and assistant-tools plugins loaded
- Must handle process lifecycle (start/stop with admin container)
- Must isolate its state from the user's assistant instance
- Must surface in the admin UI with appropriate security context

This is effectively building a second assistant deployment model inside a different container. The OpenCode runtime integration is non-trivial — the current assistant uses `entrypoint.sh` with `socat` proxies, `gosu` overrides, and careful volume mounting (see MEMORY.md notes about gosu HOME overrides and lmstudio proxy hacks).

**Realistic estimate: 8-12 working days.**

**Risk:** The knowledge roadmap's eval framework (Priority 3) and maintenance scripts (Priority 4C) list #304 as an enhancement, not a hard blocker, because of the shell automation fallback (Q5 decision). This is the correct design — but it means #304 adds value primarily for LLM-augmented analysis, which is a "nice to have" for 0.10.0.

**Recommendation: DEFER to 0.11.0.** The shell automation fallback ensures eval and maintenance work without it. Building #304 on top of a stable component system in 0.11.0 is safer.

---

### #302 — TTS/STT Setup and Admin Interface

**Feasibility:** Low for 0.10.0. The knowledge roadmap explicitly says "future, not in this plan." The `StackSpec` type already has `voice?: { tts?: string; stt?: string }` and `types.ts` defines `TtsAssignment` and `SttAssignment` types, but no implementation exists.

**Effort estimate:** Not estimated in any plan document. Based on scope:
- Admin API for TTS/STT configuration: 2-3 days
- Admin UI for voice settings: 2-3 days
- Integration with connection profiles (which provider handles TTS/STT): 1-2 days
- Actual audio pipeline (WebSocket/streaming from admin UI to provider): 5-8 days
- Testing with real TTS/STT providers: 2-3 days

**Total realistic estimate: 12-19 working days.**

**Recommendation: DEFER to 0.11.0 or later.** The type scaffolding exists. Implementing the audio pipeline is substantial and orthogonal to the component system focus.

---

### #315 — Azure Container Apps Deployment with Key Vault Integration

**Feasibility:** Low for this milestone. This is a deployment target, not a feature. It requires:
- Dockerfile optimization for Azure Container Apps (multi-stage, health probes)
- Azure Key Vault integration as a Varlock provider (Phase 2+ of #300)
- ARM/Bicep templates or Terraform for Azure infra
- Managed identity configuration for Key Vault access
- Azure-specific networking (no Docker Compose, no local volumes)

This is a fundamentally different deployment model from the Docker Compose + XDG filesystem approach that the entire codebase assumes. The `ControlPlaneState` type has `stateDir`, `configDir`, `dataDir` — all local filesystem paths. Azure Container Apps uses Azure Files or managed storage.

**Effort estimate: 15-25 working days** (including Varlock Azure KV provider, infrastructure templates, and testing).

**Recommendation: DEFER to 0.12.0 or later.** This requires the secrets backend abstraction (#300 Phase 2+) to be complete first. It's a separate deployment track, not a feature milestone item.

---

### #13 — Advanced Channel Configuration Support

**Feasibility:** High, but only after #301 (components) lands. The components model IS the advanced channel configuration — per-instance `.env.schema` with typed fields, `@sensitive` markers, category grouping, and compose labels. The knowledge roadmap notes this enables "per-channel OpenCode config" and "per-channel learning scopes" as future capabilities.

**Effort estimate:** If #301 ships, #13 is largely satisfied. The remaining work is:
- Per-component OpenCode config overrides: 2-3 days
- Per-channel guardian routing rules: 2-3 days
- Documentation: 1 day

**Total realistic estimate: 5-7 working days** (incremental on top of #301).

**Recommendation: KEEP, but scope it as "the component system satisfies this." Close #13 when #301's Phase 1-3 ship. Any advanced per-channel features (OpenCode config overrides, learning scopes) are 0.11.0.**

---

## Dependency Graph

```
#301 (Components)  ─────────────────────────────────────────┐
   │                                                         │
   ├─► #300 Phase 2+ (Secret backend for @sensitive fields)  │
   │      │                                                  │
   │      └─► #300 Phase 3-7 (pass provider, UI, migration)  │
   │                                                         │
   ├─► #298 (OpenViking as component)                        │
   │      │                                                  │
   │      ├─► Knowledge Roadmap Phase 1C (session extraction) │
   │      ├─► Priority 2 (MCP as component)                  │
   │      └─► Priority 4 (MemRL feedback loop)               │
   │                                                         │
   ├─► #13 (Advanced channel config — satisfied by #301)     │
   │                                                         │
   └─► #304 (Brokered instance — admin container changes)    │
          │                                                  │
          └─► Knowledge Priorities 3C, 4C (LLM-enhanced     │
              eval + maintenance — NOT hard blocked)          │
                                                             │
#300 Phase 0-1 (Varlock hardening + auth refactor) ──────────┘
   (no dependency on #301, can ship early)

#302 (TTS/STT) ── independent, no blockers, no dependents
#315 (Azure) ── requires #300 Phase 2+ (Secret backend abstraction)
```

**Critical path:** #300 Phase 0-1 --> #301 Phases 1-3 --> #13 (closed) --> everything else.

The component system (#301) is the bottleneck for the entire milestone. Nothing else can finalize without it. The auth refactor (#300 Phase 0-1) can proceed in parallel since it touches auth middleware, not the component model.

---

## Scope Assessment

**v0.10.0 is significantly overloaded.** Here is the honest accounting:

| Work Item | Realistic Effort | Proposed for 0.10.0 |
|-----------|-----------------|---------------------|
| #301 Components system | 20-26 days | Yes |
| #300 Phase 0-1 (auth refactor) | 4-6 days | Yes |
| #300 Phase 2-7 (pass/secrets) | 11-17 days | Yes (should defer) |
| #298 OpenViking integration | 8-10 days | Yes (should defer) |
| Knowledge Priorities 2-4 (MCP, eval, MemRL) | 15-18 days | Yes (should defer) |
| #304 Brokered instance | 8-12 days | Yes (should defer) |
| #302 TTS/STT | 12-19 days | Yes (should defer) |
| #315 Azure deployment | 15-25 days | Yes (should defer) |
| #13 Advanced channels | 0-2 days (via #301) | Yes |
| **Total** | **93-135 days** | — |

A single developer working 5 days/week over 6 weeks has 30 working days. Even with 2 developers, that is 60 working days — still short of the lower bound.

### Recommended v0.10.0 Scope (achievable in 6 weeks)

1. **#301 Components system** (Phases 1-4) — the defining feature
2. **#300 Phase 0-1** (Varlock hardening + ADMIN_TOKEN/ASSISTANT_TOKEN split)
3. **#13 Advanced channel config** (closed by #301)

Total: 24-34 working days. Achievable with focused effort.

### Recommended v0.11.0 Scope

1. **#300 Phase 2-7** (pass provider, secrets UI, migration)
2. **#298 OpenViking** (as component, with assistant integration)
3. **Knowledge Priorities 2-4** (MCP, eval, MemRL)
4. **#304 Brokered admin instance**

### Recommended v0.12.0 or later

1. **#302 TTS/STT**
2. **#315 Azure deployment**

---

## Risk Register

### Risk 1: Component System Scope Creep
**Likelihood: HIGH | Impact: HIGH**

The component system touches almost every module in `@openpalm/lib` (staging, lifecycle, channels, docker, setup, paths) plus all admin API routes, the CLI, and the admin UI. Scope creep from edge cases (volume cleanup, secret resolution at compose-up time, Caddy reload race conditions, multi-instance naming collisions) could easily add 50% to the estimate. The plan describes the happy path well but does not address error recovery, partial failure states, or concurrent instance operations.

**Mitigation:** Implement Phase 1 (core) and Phase 2 (API) first with a single built-in component (e.g., Discord). Do not attempt multi-instance or registry integration until single-instance works end-to-end.

### Risk 2: Breaking Change Backlash
**Likelihood: MEDIUM | Impact: HIGH**

The clean break from legacy channels (Q8) means every existing installation's channels break on upgrade. The "uninstall, upgrade, reinstall" path requires users to re-enter all channel secrets. If the password manager (#300) is not ready, those secrets are lost unless manually backed up. Combined with the Caddy routing changes (Caddy becomes a component, not a core service), the entire networking layer changes.

**Mitigation:** Ship a pre-upgrade checklist script (`openpalm pre-upgrade`) that exports current channel configs and secrets to a backup file. Document the upgrade path prominently. Consider keeping `Caddy` as a core service for 0.10.0 and componentizing it in 0.11.0 — changing the networking and extension model simultaneously is dangerous.

### Risk 3: Assistant Environment Variable Injection for Optional Components
**Likelihood: HIGH | Impact: MEDIUM**

The plans assume optional components (OpenViking, MCP) can inject environment variables into the assistant container via compose overlays. But Docker Compose overlays add new services — they do not modify existing service environment blocks. The assistant's `OPENVIKING_URL` and `OPENVIKING_API_KEY` cannot be set by a component overlay unless the core `docker-compose.yml` already references them with `${OPENVIKING_URL:-}` defaults, or the component overlay uses Compose `extends` (which has limitations). This is a fundamental design gap that affects every optional component that needs to communicate with the assistant.

**Mitigation:** Define the env injection mechanism before building component overlays. Options: (a) pre-declare all optional env vars in core compose with empty defaults, (b) use a shared env file that components write to and the assistant reads, (c) use Docker network DNS discovery instead of env vars.

### Risk 4: Test Suite Regression During Rewrite
**Likelihood: HIGH | Impact: MEDIUM**

The project has 592 admin unit tests, 112 non-admin unit tests, 69 mocked Playwright tests, and 45 integration tests. The component system rewrite will break a significant portion of these — particularly the channel-related tests, staging tests, lifecycle tests, and registry tests. The `install-edge-cases.test.ts` (1,214 lines) and `setup.test.ts` (1,195 lines) are the largest test files and directly test the code being rewritten.

**Mitigation:** Plan for 3-5 days of test migration as part of the component system work. Do not count on the existing test suite passing during the rewrite — budget for it.

### Risk 5: Caddy-as-Component Creates Chicken-and-Egg Problem
**Likelihood: MEDIUM | Impact: HIGH**

The components plan shows Caddy as a component (`services/caddy/compose.yml`). But Caddy is the ingress proxy — it must be running before any other component's routes are accessible. If Caddy is a component that users optionally enable, the default installation has no ingress proxy. The current architecture has Caddy in the admin profile (`admin.yml` overlay) — making it a user-managed component changes the security model. A misconfigured or stopped Caddy component exposes services directly.

**Mitigation:** Keep Caddy as a core/admin service for 0.10.0. The component system can manage channels, services, and optional tools. Caddy componentization is a separate concern that requires careful security review and should be 0.11.0 at earliest.

---

## Recommendations

1. **DEFER #298 (OpenViking) to 0.11.0.** The component system must be stable before optional components can be meaningfully integrated. Prototype the Viking assistant tools as dormant code gated on env vars, but do not build the session extraction or context assembly.

2. **DEFER #304 (Brokered admin instance) to 0.11.0.** The shell automation fallback (Q5 decision) ensures eval and maintenance work without it. This is complex runtime engineering that should not compete with the foundational rewrite.

3. **DEFER #302 (TTS/STT) to 0.11.0 or later.** The knowledge roadmap explicitly marks this as "future." The type scaffolding already exists.

4. **DEFER #315 (Azure deployment) to 0.12.0.** This is a separate deployment model requiring the secrets backend abstraction that is also being deferred.

5. **SPLIT #300 (Password Manager).** Phase 0 (Varlock hardening) and Phase 1 (auth refactor) ship in 0.10.0. Phases 2-7 (secret backend abstraction, pass provider, UI, migration) defer to 0.11.0. The `PlaintextBackend` remains the default.

6. **UPDATE #301 (Components) effort estimates.** The plan has no time estimates. Add phase-level estimates totaling 20-26 working days. Prioritize Phase 1 (core) and Phase 2 (API) over Phase 3 (UI polish) and Phase 4 (registry).

7. **ADD a pre-upgrade migration script** to the #301 scope. Even with a clean break, users need a way to export their current channel configs and secrets before upgrading. A `openpalm export-config` command that dumps channels, secrets, and connection profiles to a single file would significantly reduce upgrade friction.

8. **UPDATE the components plan to keep Caddy as a core/admin service.** Componentizing the ingress proxy alongside the extension model rewrite is high-risk. Caddy should remain in `admin.yml` for 0.10.0 and be evaluated for componentization in 0.11.0.

9. **ADD an explicit design for assistant-to-component env var injection.** The current compose structure does not support optional components injecting env vars into existing services. This must be resolved before #298 or any component that needs assistant integration. Document the mechanism in the components plan.

10. **UPDATE the knowledge roadmap's "24 working days across 6 weeks" estimate to acknowledge it covers only knowledge-system work.** The actual 0.10.0 total is 93-135 working days across all issues. Remove Priorities 2-4 (MCP, eval, MemRL) from 0.10.0 and schedule them for 0.11.0 alongside Viking.

11. **ADD test migration budget (3-5 days) to #301.** The 2,409 lines of `setup.test.ts` + `install-edge-cases.test.ts` directly test the staging and lifecycle code being rewritten. Budget explicitly for updating these.

12. **REMOVE the knowledge roadmap's Priority 2 (MCP server) and Priority 3 (eval framework) from 0.10.0.** Neither is achievable without the component system being stable, and both depend on Viking integration which is being deferred. These are 0.11.0 items.

13. **UPDATE review-decisions.md Q1 (Viking as component) to note the assistant env var injection gap.** The decision is correct, but the mechanism for the assistant to discover and communicate with optional components is not defined.

### Revised 0.10.0 Scope

| Issue | Scope | Estimated Days |
|-------|-------|---------------|
| #301 Components (Phases 1-4) | Full component system: core, API, UI, registry | 20-26 |
| #300 Phase 0-1 | Varlock hardening + auth refactor | 4-6 |
| #13 Advanced channels | Closed by #301 | 0-2 |
| Test migration | Update existing test suites for component model | 3-5 |
| Buffer | Integration testing, edge cases, docs | 3-5 |
| **Total** | | **30-44 days** |

This is achievable in 6 weeks with 1-2 developers, with reasonable buffer for the inevitable surprises in a foundational rewrite.
