# OpenPalm v0.10.0 Roadmap

> **Note (2026-03):** The component/instance system described in some sub-plans below (e.g., `/api/components`, `/api/instances`, `data/components/`, `registry/components/`, multi-instance support) was removed during implementation and replaced by the simpler addon model. Addons are managed via `stack.yaml` and the `/admin/addons` API. References to the old component system in sub-plan documents are historical and do not reflect the current codebase.

**Status:** Planning complete, ready for implementation
**Target:** 6-8 weeks with 1-2 developers
**Breaking changes:** Yes (filesystem layout, legacy channel removal, addon model cleanup, env file split)

---

## Overview

v0.10.0 is a structural release that rebuilds the addon model, filesystem layout, and secrets management. The three defining changes are:

1. **Unified Addon Model** — replaces the legacy channel/service distinction with a single addon abstraction backed by compose overlays and `.env.schema` config forms
2. **Filesystem Simplification** — collapses three XDG directories into `~/.openpalm/` with a vault-based secrets boundary, eliminates the staging tier, adds validate-in-place with snapshot rollback
3. **Secrets Management** — splits secrets into `vault/user/user.env` (hot-reloadable user keys) and `vault/stack/stack.env` (admin-managed tokens), introduces ADMIN_TOKEN/ASSISTANT_TOKEN split, adds pluggable encrypted backend via `pass`

---

## Milestone Issues

### [#301 — Unified Addon Model](https://github.com/itlackey/openpalm/issues/301)

**Scope:** Full (Phases 1-5) | **Effort:** 20-26 days | **Priority:** Critical path

The cornerstone of v0.10.0. Every optional container — channels, services, infrastructure — becomes an addon with a standardized directory structure: `compose.yml` + `.env.schema`.

User-facing terminology is now **addon**. Some implementation and storage surfaces still use earlier `component` naming (`/api/components`, `data/components/`, `registry/components/`) while the refactor settles, but they refer to the same addon model.

**Deliverables:**

- Addon lifecycle: create, configure, start, stop, delete, archive
- Admin API: addon discovery and instance endpoints (`/api/components`, `/api/instances`) with config form generation from `.env.schema`
- Admin UI: Addons tab replacing Containers + Registry
- CLI addon lifecycle commands (current implementation still exposes `openpalm component ...` while naming cleanup finishes)
- Addon catalog stored under `registry/components/` with CI validation
- Multi-instance support (e.g., two Discord bots with different configs)
- `enabled.json` persistence and dynamic Docker allowlists
- Clean break from legacy `CONFIG_HOME/channels/*.yml` format
- No compatibility mode and no automated migration path for legacy channels

**Plan:** [plans/issue-301-unified-component-system.md](plans/issue-301-unified-component-system.md)
**Registry:** [openpalm-unified-registry-plan.md](openpalm-unified-registry-plan.md)
**Supersedes:** [#13](https://github.com/itlackey/openpalm/issues/13) (closed)

---

### [#300 — Password Manager (Phases 0-4)](https://github.com/itlackey/openpalm/issues/300)

**Scope:** Phases 0-4 | **Effort:** 15-17 days | **Priority:** High (auth refactor is prerequisite for #304)

Introduces a provider-agnostic secrets backend with `PlaintextBackend` as default and `pass` (GPG-encrypted) as opt-in.

**Deliverables:**

- **Phase 0:** Varlock hardening — file permissions (`0o600`), redact schema for log safety
- **Phase 1:** Auth refactor — ADMIN_TOKEN / ASSISTANT_TOKEN split across all admin routes, guardian, and scheduler
- **Phase 2:** Secret backend abstraction — `SecretBackend` interface + `PlaintextBackend` handling `vault/user/user.env` + `vault/stack/stack.env`
- **Phase 3:** `pass` provider — GPG integration, `pass` CLI shelling, `validateEntryName()`, setup wizard opt-in
- **Phase 4:** Secrets API routes — `GET/POST/DELETE /admin/secrets`, audit logging, addon secret lifecycle

**Deferred to 0.11.0:** Phase 5 (Password Manager UI), Phase 6 (Connections refactor), Phase 7 (Migration tooling)

**Plan:** [openpalm-pass-impl-v3.md](openpalm-pass-impl-v3.md)

---

### Filesystem & Mounts Refactor (no dedicated issue — embedded in #301 scope)

**Scope:** Full | **Effort:** 12-18 days (8-12 net new, rest overlaps with #301) | **Priority:** High (Phase 0 — lands before addon work)

Replaces the three-tier XDG layout with a single `~/.openpalm/` root. Unanimously approved by all 5 review agents.

**Deliverables:**

- **Single root:** `~/.openpalm/` with `config/`, `vault/`, `data/`, `logs/`
- **Vault boundary:** `vault/user/user.env` (user-editable LLM keys) + `vault/stack/stack.env` (system-managed tokens). Admin mounts full vault rw; assistant mounts only `vault/user/user.env` ro; no other container mounts vault
- **Staging elimination:** replace CONFIG→STATE copy pipeline with validate-in-place + `~/.cache/openpalm/rollback/` snapshot
- **Hot-reload:** assistant file watcher on `vault/user/user.env` — LLM key changes apply in seconds, no restart
- **Two-file env model:** `--env-file vault/stack/stack.env --env-file vault/user/user.env` for compose substitution
- **Rollback:** `openpalm rollback` as first-class CLI command, automated on deploy failure
- **Clean break:** no automated XDG migration; `~/.openpalm/` is the only supported 0.10.0 layout
- **Backup simplification:** `tar czf backup.tar.gz ~/.openpalm` — one directory, one command

**Plan:** [fs-mounts-refactor.md](fs-mounts-refactor.md)
**Layout reference:** [fs-layout.md](fs-layout.md)
**Decision reversal:** Q2 in [review-decisions.md](review-decisions.md) (three-tier XDG → single root, 5/5 unanimous)

---

### [#298 — OpenViking Integration (Phases 1A-1D)](https://github.com/itlackey/openpalm/issues/298)

**Scope:** Viking addon + assistant tools only | **Effort:** 6-8 days | **Priority:** Medium (depends on #301)

Adds OpenViking as an optional knowledge addon with assistant tool integration.

**Deliverables:**

- **Phase 1A:** Viking addon definition — `registry/components/openviking/compose.yml` + `.env.schema`
- **Phase 1B:** Viking assistant tools — `vikingFetch()` + 6 tool wrappers (add-resource, search, get-resource, list-resources, add-session-memory, search-sessions)
- **Phase 1C:** Session memory extraction — conditional hooks in `MemoryContextPlugin` for Viking session commit
- **Phase 1D:** Token budget utilities — ported from Hyphn for context assembly

**Deferred to 0.11.0:** MCP server addon, eval framework, MemRL Q-value feedback loop

**Plan:** [knowledge-system-roadmap.md](knowledge-system-roadmap.md) (Priority 1 only)
**Deferred plan:** [../0.11.0/knowledge-system.md](../0.11.0/knowledge-system.md)

---

### [#304 — Admin OpenCode Instance](https://github.com/itlackey/openpalm/issues/304)

**Scope:** Simplified (direct access) | **Effort:** 1-2 days | **Priority:** Medium

Admin-authorized OpenCode instance inside the admin container, accessed directly via `localhost:3881` — same pattern as the assistant at `localhost:3800`. No broker, no intermediary API, no session proxying.

**Deliverables:**

- OpenCode auto-starts with admin container (entrypoint) — already implemented
- Direct web UI access at `localhost:3881` (host-only) — already wired in compose
- Config seeding with admin-tools plugin — already implemented
- Admin UI link/status indicator for admin OpenCode
- Documentation and test updates

**Key design decisions:**

- Uses ADMIN_TOKEN (full admin-level agent, not assistant) — [review-decisions.md Q4](review-decisions.md)
- Direct host-only access, no Caddy route, no broker layer — user accesses web UI directly
- Shell automation fallback ensures eval/maintenance work without it — [review-decisions.md Q5](review-decisions.md)

---

### [#315 — Azure Container Apps Deployment](https://github.com/itlackey/openpalm/issues/315)

**Scope:** Full | **Effort:** 15-20 days | **Priority:** Low (parallel track, no core code changes)

Pure additive deployment target — Azure Container Apps with Key Vault integration. Develops independently of all other 0.10.0 work.

**Deliverables:**

- Deployment script (`deploy/azure/deploy-aca.sh`) with Key Vault managed identity
- ARM/Bicep templates or az CLI automation
- Channel management via `deploy-aca.sh add-channel`
- Documentation of XDG tier deviation (DATA_HOME + STATE_HOME share Azure Files mount)

**Note:** Admin is unavailable in ACA. The core message path (channel → guardian → assistant → memory) operates independently.

---

## Dependency Graph

```
FS Refactor (Phase 0)
    │
    ├──▶ #301 Addons (Phases 1-5)  ◀── critical path
    │       │
    │       ├──▶ #298 Viking (Phases 1A-1D)
    │       │
    │       └──▶ #13 (closed — satisfied by #301)
    │
    └──▶ #300 Secrets (Phases 0-4)
            │
            └──▶ #304 Admin OpenCode Instance

#315 Azure  ── independent, parallel track
```

**Critical path:** FS Refactor → #301 Phases 1-3 → everything else

---

## Phasing

### Phase 0: Filesystem Refactor + Port Standardization (Week 1-2)

- Implement `~/.openpalm/` directory structure
- Implement vault boundary and two-file env model
- Rewrite `paths.ts` → `home.ts`, eliminate `staging.ts`
- Implement validate-in-place + rollback
- Update compose files for new bind mount paths and 38XX port range
- Standardize all service ports: assistant=3800, chat=3820, admin=3880, admin-opencode=3881, scheduler=3897, memory=3898, guardian=3899
- Update healthchecks and test fixtures for new ports
- Update dev-setup.sh for new layout

### Phase 1: Addon System Core (Week 2-4)

- Addon type definitions in `@openpalm/lib`
- Instance lifecycle (create, configure, start, stop, delete)
- `enabled.json` persistence, compose overlay chain builder
- Admin API endpoints (`/api/components`, `/api/instances`) for addon discovery and instances
- CLI addon commands
- Registry/catalog alignment under `registry/components/`

### Phase 2: Secrets & Auth (Week 3-5, parallel with Phase 1)

- #300 Phase 0: File permissions hardening
- #300 Phase 1: ADMIN_TOKEN / ASSISTANT_TOKEN split
- #300 Phase 2-3: SecretBackend + PlaintextBackend + PassBackend
- #300 Phase 4: Secrets API routes
- Hot-reload file watcher for `vault/user.env`

### Phase 3: Admin UI + Features (Week 4-6)

- Addons tab (replaces Containers + Registry tabs)
- `.env.schema` form renderer with `@sensitive` handling
- Setup wizard addon selection step
- #304 Admin OpenCode instance (direct access at localhost:3881)

### Phase 4: Viking + Polish (Week 5-7)

- #298 Phase 1A-1D: Viking addon + assistant tools
- Registry CI validation for addon directories
- Addon testing (unit, E2E lifecycle)
- Documentation: breaking-change notes, addon developer guide, release notes

### Phase 5: Azure (parallel track)

- #315: ACA deployment script, Key Vault integration, docs

---

## Cross-Cutting: Shared Library Enforcement

All control-plane logic MUST live in `packages/lib/` (`@openpalm/lib`). This is not new — it's an existing rule — but 0.10.0 reinforces it as a hard constraint because the addon model, secrets backend, filesystem refactor, and validation/rollback pipeline all introduce substantial new functionality that CLI, admin, and scheduler must share.

**Rule:** When implementing any feature from this roadmap, place the logic in `@openpalm/lib` first. CLI and admin are thin consumers that call lib functions — CLI calls them directly, admin calls them from API route handlers. No independent control-plane logic in consumers.

See `docs/technical/core-principles.md` § "Shared control-plane library" for the full rule.

---

## Cross-Cutting: Port Standardization (38XX Range)

All services move to the **38XX port range** to avoid conflicts with common dev tools and other self-hosted services.

| Service | Old Port | New Port | Notes |
|---------|----------|----------|-------|
| Assistant (OpenCode) | 4096 | **3800** | Web UI + API |
| Voice channel | — | **3810** | New in 0.10.0 (default for #302 when it ships) |
| Chat channel | 8080 | **3820** | Channel adapter |
| Admin UI + API | 8100 | **3880** | SvelteKit server |
| Admin OpenCode | 4097 | **3881** | Admin OpenCode web UI (#304) |
| Scheduler | 8090 | **3897** | Internal only |
| Memory | 8080 | **3898** | Internal only |
| Guardian | 8080 | **3899** | HMAC verification |

**Implementation tasks:**
- Update `assets/docker-compose.yml` — all `PORT` env vars and host port binds
- Update admin/runtime overlays for host-only service access where needed
- Update `vault/system.env` template — `OP_INGRESS_PORT=3080`
- Update all healthcheck commands referencing old ports
- Update `packages/lib/` constants (if any hardcoded port references exist)
- Update addon compose overlays in `registry/components/`
- Update `CLAUDE.md` dev commands and key URLs
- Update test fixtures and E2E test URLs

This is a mechanical change with no architectural risk. It ships as part of Phase 0 (filesystem refactor) since compose files are being rewritten anyway.

---

## Breaking Changes

| Change | Impact | Migration |
|--------|--------|-----------|
| `~/.openpalm/` replaces 3 XDG directories | All existing installations | Clean break — manual reinstall/reseed into the 0.10.0 layout |
| `user.env` + `system.env` replace `secrets.env` + `stack.env` | Env file paths, compose `--env-file` args | Clean break — old env files are not upgraded in place |
| Staging tier eliminated | STATE_HOME no longer exists | Automatic (staging was system-internal) |
| Legacy channels removed | `CONFIG_HOME/channels/*.yml` no longer loaded | Reinstall as addons via admin UI or CLI |
| ADMIN_TOKEN / ASSISTANT_TOKEN split | Scripts using ADMIN_TOKEN for assistant calls | Update to ASSISTANT_TOKEN where appropriate |
| Service ports move to 38XX range | All port references (scripts, bookmarks, configs) | Assistant 4096→3800, Admin 8100→3880, Guardian 8080→3899 |

---

## Review Process

This roadmap was produced through a structured multi-agent review:

1. **5 specialist agents** (Architecture, Security, Feasibility, Product/UX, Tech Debt) independently reviewed all plan documents and GitHub issues
2. **71 distinct recommendations** were extracted and voted on
3. **24 changes** received majority approval (3+ of 5 agents) and were implemented
4. **Decision Q2** (preserve three-tier XDG) was unanimously reversed based on the fs-mounts-refactor proposal

**Agent reports:** [agent-reports/](agent-reports/)
**Voting results:** [agent-reports/voting-results.md](agent-reports/voting-results.md)
**Decision log:** [review-decisions.md](review-decisions.md)
**Cross-plan review:** [review-report.md](review-report.md)

---

## Plan Documents

| Document | Scope |
|----------|-------|
| [plans/issue-301-unified-component-system.md](plans/issue-301-unified-component-system.md) | Unified addon design, CLI integration, runtime overlay assembly, and clean-break rollout |
| [openpalm-unified-registry-plan.md](openpalm-unified-registry-plan.md) | Addon registry replacing gallery/community/npm-search |
| [openpalm-pass-impl-v3.md](openpalm-pass-impl-v3.md) | Secrets management: Varlock hardening, auth refactor, backend abstraction, pass provider |
| [fs-mounts-refactor.md](fs-mounts-refactor.md) | Filesystem simplification: single root, vault boundary, staging elimination, hot-reload, clean-break layout |
| [fs-layout.md](fs-layout.md) | Directory tree reference |
| [knowledge-system-roadmap.md](knowledge-system-roadmap.md) | OpenViking integration (Priority 1 only for 0.10.0) |
| [review-decisions.md](review-decisions.md) | 11 architectural decisions (Q1-Q11) from cross-plan alignment |
| [review-report.md](review-report.md) | Original cross-plan alignment review findings |
