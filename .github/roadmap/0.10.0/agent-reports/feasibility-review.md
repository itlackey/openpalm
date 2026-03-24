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

---

## Addendum: Filesystem & Mounts Refactor Feasibility Review (2026-03-19)

### Summary

The FS refactor proposal (`fs-mounts-refactor.md`) collapses the three-tier XDG layout (`~/.config/openpalm`, `~/.local/share/openpalm`, `~/.local/state/openpalm`) into a single `~/.openpalm/` root with `config/`, `vault/`, `data/`, `logs/` subdirectories and `~/.cache/openpalm/` for ephemeral data. It eliminates the staging tier entirely (replacing it with validate-in-place + snapshot rollback), splits `secrets.env` + `stack.env` into `vault/user.env` + `vault/system.env` with strict per-container mount isolation, and adds hot-reload of `user.env` via a file watcher in the assistant entrypoint. This is a well-reasoned simplification that addresses real operational pain (31 directories across 3 trees, 3-hop secret pipeline, no rollback). However, it is a pervasive change that touches every layer of the stack and is being proposed alongside the component system rewrite, which already rewrites the same code.

### Effort Estimate

**Direct code changes: 12-18 working days.** File-by-file breakdown:

**`@openpalm/lib` (packages/lib/src/control-plane/) — 19 files affected:**

| File | Lines | Change Scope | Days |
|------|-------|-------------|------|
| `paths.ts` (78 lines) | Full rewrite | `resolveConfigHome()` / `resolveDataHome()` / `resolveStateHome()` replaced with `resolveOpenPalmHome()` + subdirectory helpers. `ensureXdgDirs()` replaced with new directory tree creation. | 0.5 |
| `staging.ts` (399 lines) | ~70% rewrite | Staging tier elimination. `stageSecretsEnv()`, `stagedEnvFile()`, `stagedStackEnvFile()`, `buildEnvFiles()`, `stageStackEnv()`, `stageChannelYmlFiles()`, `stageChannelCaddyfiles()`, `stageAutomationFiles()`, `stageEnvSchemas()`, `persistArtifacts()` — all must be rewritten or removed. Replaced with validate-in-place + snapshot flow. | 3-4 |
| `lifecycle.ts` (382 lines) | ~50% rewrite | `createState()` must read from new paths. `buildComposeFileList()` reads from `config/components/` instead of `stateDir/artifacts/`. `buildEnvFiles()` returns `vault/system.env` + `vault/user.env`. `isSetupComplete()` reads from `vault/system.env`. `validateEnvironment()` validates against new schema locations. | 2-3 |
| `types.ts` (164 lines) | Moderate | `ControlPlaneState` loses `stateDir`, gains `openPalmHome` or equivalent. `configDir` / `dataDir` become sub-paths of `~/.openpalm/`. Add `vaultDir`, `logsDir`, `cacheDir`. | 0.5 |
| `secrets.ts` (178 lines) | Full rewrite | `secrets.env` path references become `vault/user.env`. `loadSecretsEnvFile()` reads from `vault/user.env`. `ensureSecrets()` seeds `vault/user.env` + `vault/system.env`. `patchSecretsEnvFile()` writes to vault. | 1-2 |
| `core-assets.ts` (320 lines) | Moderate | All `resolveDataHome()` calls change. Caddyfile lives in `data/caddy/Caddyfile`. Schema files move to `vault/`. `refreshCoreAssets()` targets new paths. | 1 |
| `setup-status.ts` (31 lines) | Rewrite | `isSetupComplete()` reads `vault/system.env` instead of `stateDir/artifacts/stack.env`. | 0.25 |
| `docker.ts` (449 lines) | Moderate | `composeFile()` reads from `config/components/core.yml` instead of `stateDir/artifacts/docker-compose.yml`. Env file loading changes. | 0.5 |
| `channels.ts` (199 lines) | Already being rewritten by #301 | — |
| Other lib files (audit, scheduler, env, connection-*, memory-config, stack-spec, setup) | Path adjustments | Each file that references `configDir`, `dataDir`, or `stateDir` needs path updates. 10+ files with 3-50 references each. | 1-2 |

**`packages/admin` — 62 files reference XDG paths:**
- `hooks.server.ts` — startup apply rewrite (no more `ensureXdgDirs()` + staging pipeline)
- `lib/server/staging.ts` — thin wrapper; tracks lib changes
- ~20 API route handlers reference `state.stateDir`, `state.configDir`, `state.dataDir`
- ~26 test files with 964 total `configDir`/`dataDir`/`stateDir` references
- **Estimate: 2-3 days** (mostly mechanical path substitution, but test fixtures need rebuilding)

**`packages/cli` — 14 files affected:**
- `lib/staging.ts` — `ensureStagedState()` and `fullComposeArgs()` rewrite
- `lib/env.ts`, `commands/install.ts` — path changes
- 8 test files with references to XDG env vars
- **Estimate: 1-2 days**

**Asset files:**
- `assets/docker-compose.yml` — all 16 bind mount paths change (e.g., `${OP_DATA_HOME:-...}/memory:/data` becomes `${OP_HOME:-...}/data/memory:/data`)
- `assets/admin.yml` — all 14 bind mount paths change; admin's clever "mount same host path" pattern must be redesigned since the admin no longer needs to mount 3 separate XDG trees
- `compose.dev.yaml` — env file paths change
- `assets/Caddyfile` — channel import paths change
- **Estimate: 1-2 days**

**Dev environment:**
- `scripts/dev-setup.sh` — full rewrite of directory creation and env seeding (currently creates `.dev/config`, `.dev/data`, `.dev/state`; must become `.dev/config`, `.dev/vault`, `.dev/data`, `.dev/logs`, `.dev/cache`)
- `scripts/dev-e2e-test.sh`, `scripts/release-e2e-test.sh`, `scripts/upgrade-test.sh` — path updates
- **Estimate: 1 day**

**Documentation — 17+ docs files with hardcoded XDG paths:**
- `docs/technical/directory-structure.md`, `docs/technical/environment-and-mounts.md`, `docs/technical/authoritative/core-principles.md`, `docs/backup-restore.md`, `docs/manual-setup.md`, `docs/managing-openpalm.md`, `CLAUDE.md`, etc.
- **Estimate: 1-2 days**

**New code (validate-in-place + rollback + hot-reload):**
- Rollback snapshot mechanism: ~100-150 lines
- Validate-before-write pipeline: ~150-200 lines (compose config dry-run, varlock validation against temp copies, Caddy validate)
- Hot-reload file watcher: ~50 lines in assistant entrypoint (TypeScript, as shown in proposal)
- **Estimate: 2-3 days**

**Test migration:**
- 4,443 lines across 8 key test files directly test staging/path/secret behavior
- 964 `configDir`/`dataDir`/`stateDir` references across 26 test files
- Every test fixture that creates temp directories with XDG layout needs updating
- **Estimate: 3-4 days** (overlaps heavily with test migration already budgeted for #301)

### Scope Impact

**Net effect on 0.10.0 total effort: adds 5-10 days beyond what #301 already requires, but replaces some #301 work.**

The critical insight: the component system (#301) already rewrites `staging.ts`, `lifecycle.ts`, `channels.ts`, `buildComposeFileList()`, `fullComposeArgs()`, and the admin API's staging pipeline. The FS refactor rewrites the same files. Doing both simultaneously means each piece of code is rewritten once (with both the new component model AND the new directory layout), rather than rewriting for components in 0.10.0 and then rewriting again for FS layout in a future release.

Quantified overlap:
- `staging.ts` — #301 rewrites ~60% (channel staging removal), FS refactor rewrites ~70% (staging tier elimination). Combined: ~85% rewrite. **Not additive — one rewrite covers both.**
- `lifecycle.ts` — #301 rewrites `buildComposeFileList()` and `buildManagedServices()`. FS refactor rewrites `createState()`, path resolution, and env file chains. **Partially additive — different functions in the same file.**
- `paths.ts` — #301 does not touch this. FS refactor rewrites it entirely. **Purely additive.**
- `secrets.ts` — #301 does not rewrite secrets management (that is #300). FS refactor rewrites the secret file layout. **Purely additive.**
- `docker-compose.yml` bind mounts — #301 may add component mounts but does not change core service mounts. FS refactor changes all of them. **Purely additive.**

Of the 12-18 day FS refactor estimate:
- ~4-6 days overlap with work #301 already requires (staging rewrite, compose file list builder, test migration)
- ~8-12 days are net-new work (paths.ts, secrets layout, compose bind mounts, rollback mechanism, hot-reload, dev setup, documentation)

**Updated scope impact: +8-12 net working days added to 0.10.0.**

My previous revised scope was 30-44 days. Adding the FS refactor makes it 38-56 days. This is still within reach for 2 developers over 6 weeks (60 working days) but leaves very little buffer.

### Synergy with Component System

**Doing both simultaneously simplifies the long-term outcome but complicates the 0.10.0 development process.**

Positive synergy:
1. **Single rewrite of staging pipeline.** The component system eliminates channel-specific staging (`stageChannelYmlFiles`, `stageChannelCaddyfiles`). The FS refactor eliminates the staging tier itself (`persistArtifacts` writing to `STATE_HOME/artifacts/`). Doing both means `staging.ts` is rewritten once with a clear new model: components live in `config/components/`, validation happens in-place, and rollback uses `~/.cache/openpalm/rollback/`.

2. **Component compose overlays align with new directory layout.** The component plan has instances at `${OP_DATA}/components/`. The FS refactor puts everything under `~/.openpalm/`. The compose invocation in the FS refactor (`-f ~/.openpalm/config/components/core.yml -f ~/.openpalm/config/components/channel-slack.yml --env-file ~/.openpalm/vault/system.env --env-file ~/.openpalm/vault/user.env`) is cleaner than mixing XDG paths with component data paths.

3. **`ControlPlaneState` type only changes once.** Currently `{ stateDir, configDir, dataDir }`. The component system would add component-related fields. The FS refactor would replace the three dirs with a single root. Doing both means the type changes once.

4. **Env file simplification benefits components.** The FS refactor's two-file model (`vault/user.env` + `vault/system.env`) is simpler for the component system to work with than the current three-hop chain (`CONFIG_HOME/secrets.env` -> `DATA_HOME/stack.env` -> `STATE_HOME/artifacts/` copies). The compose invocation for components becomes deterministic: `--env-file vault/system.env --env-file vault/user.env --env-file components/discord-main/.env`.

Negative synergy:
1. **Two breaking changes compound migration complexity.** Users upgrading from 0.9.x face both "your channels are now components" AND "your files moved from 3 XDG directories to `~/.openpalm/`". The migration script must handle both.

2. **Debugging difficulty.** During development, when something breaks, it is harder to determine whether the issue is from the component model change or the directory layout change. Isolating bugs in a dual-rewrite is significantly harder than in a single-rewrite.

3. **The component plan already uses XDG paths.** The `openpalm-components-plan.md` explicitly says "Preserve three-tier XDG model" and references `${OP_CONFIG}`, `${OP_DATA}`, `${OP_STATE}` throughout. The FS refactor contradicts this. The component plan would need to be revised to use the new layout, adding coordination overhead.

### Migration Complexity

**Moderate-high.** The migration from current XDG layout to `~/.openpalm/` involves:

1. **Structural relocation of ~31 directories.** Every file currently at `~/.config/openpalm/*` moves to `~/.openpalm/config/*` (or `vault/*` for secrets). Every file at `~/.local/share/openpalm/*` moves to `~/.openpalm/data/*`. `~/.local/state/openpalm/*` is eliminated (no staging tier). This is not a simple rename — it is a scatter-gather operation where `secrets.env` goes to `vault/user.env`, `stack.env` splits between `vault/system.env` and `config/openpalm.yml`, and `STATE_HOME/artifacts/*` simply disappears.

2. **Env file content splitting.** The current `secrets.env` contains both user secrets (LLM keys) and system secrets (ADMIN_TOKEN, MEMORY_AUTH_TOKEN). The FS refactor splits these into `vault/user.env` (user-editable) and `vault/system.env` (system-managed). The current `stack.env` contains paths, UID/GID, image tags, and channel HMAC secrets — all of which go into `vault/system.env`. A migration tool must parse both existing files and correctly distribute keys into the two new files.

3. **Compose file path references.** Every running container's volume mounts reference the old paths. The migration must be: stop stack, relocate files, update compose paths, restart stack. There is no hot-migration path.

4. **Dev environment parallel migration.** The current `.dev/config`, `.dev/data`, `.dev/state` structure must change to `.dev/config`, `.dev/vault`, `.dev/data`, `.dev/logs`. All developers must run the new `dev-setup.sh` after pulling the changes. The `compose.dev.yaml` env file paths change.

**Migration tool estimate: 2-3 days to build a `openpalm migrate-layout` command that:**
- Detects old XDG layout
- Creates new `~/.openpalm/` tree
- Copies files to new locations
- Splits env files correctly
- Validates the result
- Offers rollback if migration fails

This migration tool is required if the FS refactor ships. Without it, users must manually reorganize their filesystem — which is unreasonable.

### Risk Assessment

**Risk 6: Dual Breaking Change Compounds User Upgrade Pain**
**Likelihood: HIGH | Impact: HIGH**

Users upgrading from 0.9.x face:
(a) Channel format change (channels -> components) — must reinstall all channels
(b) Filesystem layout change (XDG -> ~/.openpalm/) — must relocate all files + re-enter secrets

If either migration fails, the user is in a broken state. If both fail simultaneously, recovery is complex. The channel migration depends on the filesystem migration completing first (component overlays expect the new paths). This creates a strict ordering requirement in the migration tool.

**Mitigation:** Ship `openpalm migrate` as a single command that handles both changes atomically. Test extensively with the `scripts/upgrade-test.sh` harness.

**Risk 7: Staging Elimination Removes a Safety Net**
**Likelihood: MEDIUM | Impact: MEDIUM**

The current staging tier, despite its complexity, provides a genuine safety property: user-editable files in CONFIG_HOME are never read directly by containers. If a user corrupts `secrets.env`, the last-staged copy in STATE_HOME continues to work until the next apply. The validate-in-place model removes this buffer — a validation bug or race condition means corrupted files go live immediately.

The proposal's mitigation (snapshot to `~/.cache/openpalm/rollback/`) is weaker than the current model because:
- The rollback directory is in `~/.cache/`, which tools like `bleachbit` or manual cache clearing may delete
- The snapshot is only taken during apply operations, not continuously
- There is no equivalent of "containers keep running with last-known-good staged files"

**Mitigation:** Ensure the rollback snapshot is taken before every write, not just during explicit `apply` operations. Consider keeping rollback outside `~/.cache/` (perhaps `~/.openpalm/backups/`).

**Risk 8: Hot-Reload File Watcher Introduces Complexity in the Assistant Container**
**Likelihood: MEDIUM | Impact: LOW**

The proposal adds a `fs.watch()` call in the assistant entrypoint that modifies `process.env` at runtime when `user.env` changes. This is elegant for the user-facing use case (add an API key without restarting) but introduces:
- Race conditions if `user.env` is written partially (editor save in progress)
- Platform-specific `fs.watch` behavior differences (inotify vs kqueue vs polling)
- Security surface: the assistant can observe when secrets change (timing side-channel)
- The assistant runs OpenCode, which may cache provider instances; changing `process.env.OPENAI_API_KEY` may not propagate to already-instantiated AI SDK clients

**Mitigation:** Use debouncing (100ms delay after last change event). Read the full file atomically. Document that hot-reload applies to new requests only, not in-flight sessions. Accept that some providers may require a session restart to pick up new keys. This is low risk because hot-reload is a convenience feature — the restart path still works.

### Recommendations

14. **ADD the FS refactor to 0.10.0 scope, but ONLY if the component system rewrite is committed.** The FS refactor makes most sense when done alongside #301 because both rewrite the same code. Doing the FS refactor alone (without #301) or after #301 (as a separate release) doubles the rewrite effort on `staging.ts`, `lifecycle.ts`, and the test suite. The natural pairing is: "0.10.0 is the big infrastructure overhaul — new extension model, new directory layout, clean break." This is a legitimate "rip off the bandaid" moment.

15. **UPDATE the component plan (`openpalm-components-plan.md`) to use `~/.openpalm/` paths.** The current plan references `${OP_CONFIG}`, `${OP_DATA}`, `${OP_STATE}` and explicitly says "Preserve three-tier XDG model." If the FS refactor is adopted, the component plan must be revised. Component instances would live at `~/.openpalm/data/components/` (not `${OP_DATA}/components/`), and `enabled.json` would move accordingly.

16. **ADD a unified migration tool to the scope.** A `openpalm migrate` command that handles both the XDG-to-openpalm-home relocation and the channel-to-component transition in a single atomic operation. **Estimate: 3-4 days** (includes the env file splitting logic, directory relocation, and validation). This is non-negotiable if both breaking changes ship in the same release.

17. **DEFER hot-reload to a fast-follow or 0.10.1.** The file watcher in the assistant entrypoint is a convenience feature, not a structural requirement. The FS refactor's core value is the simplified directory layout, staging elimination, and secret isolation. Hot-reload adds 1-2 days of work plus testing complexity (platform-specific `fs.watch` behavior, race conditions, SDK client caching). Ship it as a polish item after the core layout is stable.

18. **UPDATE rollback storage location.** Move rollback from `~/.cache/openpalm/rollback/` to `~/.openpalm/backups/rollback/`. The `~/.cache/` location is semantically correct (ephemeral, regenerable) but operationally risky — cache-cleaning tools may delete it at the worst time. The proposal already shows `~/.openpalm/backups/` in the layout (`fs-layout.md`). Use it.

19. **UPDATE the revised 0.10.0 scope estimate.** With the FS refactor included:

| Issue | Scope | Estimated Days |
|-------|-------|---------------|
| #301 Components (Phases 1-4) | Full component system with new directory layout | 22-30 (was 20-26; +2-4 for FS path integration) |
| FS refactor (net-new work) | paths.ts, secrets layout, compose mounts, rollback mechanism, dev setup, docs | 8-12 |
| Migration tool | `openpalm migrate` covering both layout and channel->component transition | 3-4 |
| #300 Phase 0-1 | Varlock hardening + auth refactor (vault/system.env aligns with new layout) | 4-6 |
| #13 Advanced channels | Closed by #301 | 0-2 |
| Test migration | Update test suites for both component model and new paths | 4-6 (was 3-5; +1 for path changes) |
| Buffer | Integration testing, edge cases, docs | 3-5 |
| **Total** | | **44-65 days** |

This is achievable with 2 developers over 6-8 weeks but exceeds the capacity of a solo developer. If only one developer is available, defer the FS refactor to 0.10.1 (a quick follow-up that rewrites paths after the component system is stable).

20. **REMOVE the `openpalm.yml` config file from the FS refactor scope for 0.10.0.** The proposal introduces `config/openpalm.yml` as a human-readable stack config file (enabled components, feature flags, network settings). This overlaps with the component system's `enabled.json` and the existing `stack.env` settings. Having both `openpalm.yml` and `enabled.json` as sources of truth for which components are enabled is a design conflict that must be resolved before implementation. Defer `openpalm.yml` to 0.10.1 and use `enabled.json` as the sole persistence mechanism for 0.10.0.
