# OpenPalm v0.10.0 Roadmap

**Status:** Planning complete, ready for implementation
**Target:** 6-8 weeks with 1-2 developers
**Breaking changes:** Yes (filesystem layout, legacy channel removal, env file split)

---

## Overview

v0.10.0 is a structural release that rebuilds the extension model, filesystem layout, and secrets management. The three defining changes are:

1. **Unified Component System** — replaces the legacy channel/service distinction with a single "component" abstraction backed by compose overlays and `.env.schema` config forms
2. **Filesystem Simplification** — collapses three XDG directories into `~/.openpalm/` with a vault-based secrets boundary, eliminates the staging tier, adds validate-in-place with snapshot rollback
3. **Secrets Management** — splits secrets into `user.env` (hot-reloadable LLM keys) and `system.env` (admin-managed tokens), introduces ADMIN_TOKEN/ASSISTANT_TOKEN split, adds pluggable encrypted backend via `pass`

---

## Milestone Issues

### [#301 — Unified Component System](https://github.com/itlackey/openpalm/issues/301)

**Scope:** Full (Phases 1-5) | **Effort:** 20-26 days | **Priority:** Critical path

The cornerstone of v0.10.0. Every optional container — channels, services, infrastructure — becomes a "component" with a standardized directory structure: `compose.yml` + `.env.schema` + optional `.caddy`.

**Deliverables:**
- Component lifecycle: create, configure, start, stop, delete, archive
- Admin API: `/api/components`, `/api/instances`, config form generation from `.env.schema`
- Admin UI: Components tab replacing Containers + Registry
- CLI commands: `openpalm component list/add/configure/remove/start/stop`
- Registry: `registry/components/` directory structure with CI validation
- Multi-instance support (e.g., two Discord bots with different configs)
- `enabled.json` persistence, dynamic Docker allowlists, Caddy route staging
- Clean break from legacy `CONFIG_HOME/channels/*.yml` format
- Migration detection: admin UI banner + CLI warning for legacy channels

**Plan:** [openpalm-components-plan.md](openpalm-components-plan.md)
**Registry:** [openpalm-unified-registry-plan.md](openpalm-unified-registry-plan.md)
**Supersedes:** [#13](https://github.com/itlackey/openpalm/issues/13) (closed)

---

### [#300 — Password Manager (Phases 0-4)](https://github.com/itlackey/openpalm/issues/300)

**Scope:** Phases 0-4 | **Effort:** 15-17 days | **Priority:** High (auth refactor is prerequisite for #304)

Introduces a provider-agnostic secrets backend with `PlaintextBackend` as default and `pass` (GPG-encrypted) as opt-in.

**Deliverables:**
- **Phase 0:** Varlock hardening — file permissions (`0o600`), redact schema for log safety
- **Phase 1:** Auth refactor — ADMIN_TOKEN / ASSISTANT_TOKEN split across all admin routes, guardian, and scheduler
- **Phase 2:** Secret backend abstraction — `SecretBackend` interface + `PlaintextBackend` handling `vault/user.env` + `vault/system.env`
- **Phase 3:** `pass` provider — GPG integration, `pass` CLI shelling, `validateEntryName()`, setup wizard opt-in
- **Phase 4:** Secrets API routes — `GET/POST/DELETE /admin/secrets`, audit logging, component secret lifecycle

**Deferred to 0.11.0:** Phase 5 (Password Manager UI), Phase 6 (Connections refactor), Phase 7 (Migration tooling)

**Plan:** [openpalm-pass-impl-v3.md](openpalm-pass-impl-v3.md)

---

### Filesystem & Mounts Refactor (no dedicated issue — embedded in #301 scope)

**Scope:** Full | **Effort:** 12-18 days (8-12 net new, rest overlaps with #301) | **Priority:** High (Phase 0 — lands before component system)

Replaces the three-tier XDG layout with a single `~/.openpalm/` root. Unanimously approved by all 5 review agents.

**Deliverables:**
- **Single root:** `~/.openpalm/` with `config/`, `vault/`, `data/`, `logs/`
- **Vault boundary:** `vault/user.env` (user-editable LLM keys) + `vault/system.env` (system-managed tokens). Admin mounts full vault rw; assistant mounts only `user.env` ro; no other container mounts vault
- **Staging elimination:** replace CONFIG→STATE copy pipeline with validate-in-place + `~/.cache/openpalm/rollback/` snapshot
- **Hot-reload:** assistant file watcher on `vault/user.env` — LLM key changes apply in seconds, no restart
- **Two-file env model:** `--env-file vault/system.env --env-file vault/user.env` for compose substitution
- **Rollback:** `openpalm rollback` as first-class CLI command, automated on deploy failure
- **Migration tool:** `openpalm migrate` for XDG-to-`~/.openpalm/` transition (env file splitting, directory relocation, validation)
- **Backup simplification:** `tar czf backup.tar.gz ~/.openpalm` — one directory, one command

**Plan:** [fs-mounts-refactor.md](fs-mounts-refactor.md)
**Layout reference:** [fs-layout.md](fs-layout.md)
**Decision reversal:** Q2 in [review-decisions.md](review-decisions.md) (three-tier XDG → single root, 5/5 unanimous)

---

### [#298 — OpenViking Integration (Phases 1A-1D)](https://github.com/itlackey/openpalm/issues/298)

**Scope:** Viking component + assistant tools only | **Effort:** 6-8 days | **Priority:** Medium (depends on #301)

Adds OpenViking as an optional knowledge component with assistant tool integration.

**Deliverables:**
- **Phase 1A:** Viking component directory — `registry/components/openviking/compose.yml` + `.env.schema`
- **Phase 1B:** Viking assistant tools — `vikingFetch()` + 6 tool wrappers (add-resource, search, get-resource, list-resources, add-session-memory, search-sessions)
- **Phase 1C:** Session memory extraction — conditional hooks in `MemoryContextPlugin` for Viking session commit
- **Phase 1D:** Token budget utilities — ported from Hyphn for context assembly

**Deferred to 0.11.0:** MCP server component, eval framework, MemRL Q-value feedback loop

**Plan:** [knowledge-system-roadmap.md](knowledge-system-roadmap.md) (Priority 1 only)
**Deferred plan:** [../0.11.0/knowledge-system.md](../0.11.0/knowledge-system.md)

---

### [#304 — Brokered Admin OpenCode Instance (Phases 1-2)](https://github.com/itlackey/openpalm/issues/304)

**Scope:** Phase 1-2 | **Effort:** 8-10 days | **Priority:** Medium (benefits from #300 Phase 1 auth refactor)

Embeds an admin-authorized OpenCode instance inside the admin container for diagnostics and configuration help.

**Deliverables:**
- **Phase 1:** Foundations — path helpers, config seeding, supervisor/broker module, status/start APIs, OpenCode/Bun installation in admin Dockerfile (runtime only, not build tool)
- **Phase 2:** Admin-authorized diagnostics — user and assistant sessions, message proxying via `POST /admin/elevated/session/:id/message`, diagnostics and configuration help

**Deferred to 0.11.0:** Phase 3 (Admin-mediated remediation), Phase 4 (Hardening — session TTL, one-shot grants)

**Key design decisions:**
- Uses ADMIN_TOKEN (full admin-level agent, not assistant) — [review-decisions.md Q4](review-decisions.md)
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
    ├──▶ #301 Components (Phases 1-5)  ◀── critical path
    │       │
    │       ├──▶ #298 Viking (Phases 1A-1D)
    │       │
    │       └──▶ #13 (closed — satisfied by #301)
    │
    └──▶ #300 Secrets (Phases 0-4)
            │
            └──▶ #304 Brokered Instance (Phases 1-2)

#315 Azure  ── independent, parallel track
```

**Critical path:** FS Refactor → #301 Phases 1-3 → everything else

---

## Phasing

### Phase 0: Filesystem Refactor (Week 1-2)
- Implement `~/.openpalm/` directory structure
- Implement vault boundary and two-file env model
- Rewrite `paths.ts` → `home.ts`, eliminate `staging.ts`
- Implement validate-in-place + rollback
- Implement `openpalm migrate` tool
- Update compose files for new bind mount paths
- Update dev-setup.sh for new layout

### Phase 1: Component System Core (Week 2-4)
- Component type definitions in `@openpalm/lib`
- Instance lifecycle (create, configure, start, stop, delete)
- `enabled.json` persistence, compose overlay chain builder
- Admin API endpoints (`/api/components`, `/api/instances`)
- CLI component commands
- Registry migration (`registry/channels/` → `registry/components/`)

### Phase 2: Secrets & Auth (Week 3-5, parallel with Phase 1)
- #300 Phase 0: File permissions hardening
- #300 Phase 1: ADMIN_TOKEN / ASSISTANT_TOKEN split
- #300 Phase 2-3: SecretBackend + PlaintextBackend + PassBackend
- #300 Phase 4: Secrets API routes
- Hot-reload file watcher for `vault/user.env`

### Phase 3: Admin UI + Features (Week 4-6)
- Components tab (replaces Containers + Registry tabs)
- `.env.schema` form renderer with `@sensitive` handling
- Setup wizard component selection step
- Migration detection banner
- #304 Phase 1-2: Brokered admin OpenCode instance

### Phase 4: Viking + Polish (Week 5-7)
- #298 Phase 1A-1D: Viking component + assistant tools
- Registry CI validation for component directories
- Component testing (unit, E2E lifecycle, migration regression)
- Documentation: upgrade guide, component developer guide, release notes

### Phase 5: Azure (parallel track)
- #315: ACA deployment script, Key Vault integration, docs

---

## Breaking Changes

| Change | Impact | Migration |
|--------|--------|-----------|
| `~/.openpalm/` replaces 3 XDG directories | All existing installations | `openpalm migrate` (automated) |
| `user.env` + `system.env` replace `secrets.env` + `stack.env` | Env file paths, compose `--env-file` args | Handled by `openpalm migrate` |
| Staging tier eliminated | STATE_HOME no longer exists | Automatic (staging was system-internal) |
| Legacy channels removed | `CONFIG_HOME/channels/*.yml` no longer loaded | Reinstall as components via admin UI or CLI |
| ADMIN_TOKEN / ASSISTANT_TOKEN split | Scripts using ADMIN_TOKEN for assistant calls | Update to ASSISTANT_TOKEN where appropriate |

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
| [openpalm-components-plan.md](openpalm-components-plan.md) | Unified component system design, CLI integration, cross-component env injection, upgrade path, testing strategy |
| [openpalm-unified-registry-plan.md](openpalm-unified-registry-plan.md) | Component registry replacing gallery/community/npm-search |
| [openpalm-pass-impl-v3.md](openpalm-pass-impl-v3.md) | Secrets management: Varlock hardening, auth refactor, backend abstraction, pass provider |
| [fs-mounts-refactor.md](fs-mounts-refactor.md) | Filesystem simplification: single root, vault boundary, staging elimination, hot-reload, migration |
| [fs-layout.md](fs-layout.md) | Directory tree reference |
| [knowledge-system-roadmap.md](knowledge-system-roadmap.md) | OpenViking integration (Priority 1 only for 0.10.0) |
| [review-decisions.md](review-decisions.md) | 11 architectural decisions (Q1-Q11) from cross-plan alignment |
| [review-report.md](review-report.md) | Original cross-plan alignment review findings |
