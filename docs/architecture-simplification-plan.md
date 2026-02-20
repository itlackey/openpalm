# Architecture Simplification Plan

This plan reviews the current implementation against the simplification direction and defines the remaining work to finish the remaining simplification work.

## Scope and guiding rule

OpenPalm should remain a configuration-first UX over existing technologies (Docker Compose, Caddy, OpenCode config, env files), with minimal bespoke orchestration.

## What is already in place

- **Admin container path is removed from runtime compose** and Admin already runs Compose commands through an allowlisted helper.
- **Stack Spec + generator path exists** in Admin (`stack-spec`, `stack-generator`, `stack-manager`) and currently generates:
  - `docker-compose.yml`
  - `caddy/Caddyfile`
  - channel config env files
  - channel/gateway HMAC env files
  - OpenCode plugin list overlay
- **`opencode-core` healthcheck mismatch is fixed** in `assets/state/docker-compose.yml` (health probe now points at `:4096`).
- **Secret management already integrates with Stack Spec** (available secrets, channel mappings, validation APIs).

## Gap analysis (current state vs target)

### 1) Atomic generation/apply is not complete

Current behavior writes generated artifacts directly, then runs service restarts separately. There is no full `generate -> validate -> apply` transaction with rollback.

**Missing:**
- stage artifacts into a temp dir
- run `docker compose config` and `caddy validate`
- apply only when all validations pass
- rollback if any apply step fails

### 2) Caddy is still generated as one monolithic file

Generator currently renders one `Caddyfile` string. This keeps diff/review and partial updates harder than needed.

**Missing:**
- static skeleton Caddyfile + generated imports/snippets
- per-channel route snippet files
- optional user override snippet

### 3) Least-privilege secret wiring is partial

Channel and gateway secret files are split, but some core services still consume broad `secrets.env` and validations can be stricter.

**Missing:**
- keep current secret manager + Stack Spec model, but expand it to support scoped env-file rendering for non-channel domains
- enforce env-file attachment policy in generator validation
- validate enabled channels have both sides of HMAC wiring
- validate all mapped secrets have at least one consumer
- add rotation metadata and usage annotations to existing secret manager API output (no separate secret-map artifact)

### 4) Compose operation contract is incomplete

Compose actions are allowlisted, but currently limited and not fully aligned to target operational set.

**Missing:**
- explicit allowlisted support for `ps`, `logs --tail N`, and optional `pull`
- optional `up`/`restart` multi-service batching with validated service names from generated compose
- tighter validation against generated manifest (not only static allowlist)

### 5) Restart impact graph is not centralized

Restart/reload calls are scattered in route handlers.

**Missing:**
- one impact planner that maps changed artifact classes to exact actions
- apply preview response: restart set, reload set, and no-op status
- reuse by all mutating endpoints

### 6) Shared library code is fragmented

Reusable runtime/compose/path/env/provider-detection/CLI UI helpers lived under the CLI workspace, making reuse from other workspaces harder.

**Missing:**
- central package for reusable helpers in `packages/lib`
- consumers import from one package (`@openpalm/lib`) instead of local duplicated lib trees

## Implementation plan (phased)

## Phase 1 — Safety baseline and transactionality

1. Add `StackApplyEngine` in `packages/lib/admin`:
   - render into temp workspace
   - validate compose (`compose config`) and caddy (`caddy validate`)
   - atomically replace managed files
   - execute planned reload/restart actions
2. Add rollback behavior on failed apply action.
3. Replace direct `stackManager.renderArtifacts()` write paths with apply engine entrypoints.
4. Add tests for validation failure and rollback scenarios.

## Phase 2 — Caddy decomposition

1. Change generator outputs to:
   - `caddy/Caddyfile` skeleton
   - `caddy/routes/admin.caddy`
   - `caddy/routes/channels/<channel>.caddy`
   - `caddy/routes/extra-user-overrides.caddy` (preserved if present)
2. Update Caddyfile skeleton to import routes.
3. Add deterministic channel route rendering tests.

## Phase 3 — Expand current secret manager + Stack Spec integration

1. Keep the existing stack-spec secret model (`available`, channel mappings) and existing admin secret-manager endpoints.
2. Extend generator output to scoped env files for non-channel domains while preserving backward compatibility:
   - `secrets/gateway/channels.env` (existing)
   - `secrets/channels/<channel>.env` (existing)
   - `secrets/gateway/gateway.env`
   - `secrets/openmemory/openmemory.env`
   - `secrets/db/postgres.env`
   - optional `secrets/opencode/providers.env`
3. Extend `listSecretManagerState()` to include purpose, constraints, consumer services, and rotation metadata in the same API payload.
4. Add a compatibility routine that reads existing `secrets.env` values and materializes scoped files without requiring a new manifest file.
5. Enforce least-privilege env-file attachments in compose generation tests.

## Phase 4 — Compose command surface + impact planner

1. Extend compose runner to add allowlisted operations (`ps`, `logs`, optional `pull`) with strict argument validation.
2. Validate service names against generated compose services.
3. Introduce `impact-plan.ts` to compute reload/restart actions from artifact diffs.
4. Update Admin API responses to include apply impact preview before execution.

## Phase 5 — Shared library package + cleanup/hardening

1. Move reusable helper modules into `packages/lib` and consume via `@openpalm/lib`.
2. Remove obsolete duplicated helper code paths.
3. Expand integration tests around:
   - channel enable/disable
   - channel exposure LAN/public
   - secret rotation and remapping
   - compose apply and partial-failure rollback
4. Add a dry-run endpoint for CI and troubleshooting.

## Documentation updates required

These docs should be updated as part of the simplification work (or immediately where already stale):

1. `docs/architecture.md`
   - Remove admin-centric flow and diagrams.
   - Document Stack Spec + generator + Admin apply engine architecture.
   - Replace admin section with direct compose allowlist behavior.

2. `docs/admin-guide.md`
   - Update operations model from “Admin -> Admin” to direct compose allowlist.
   - Document apply transaction flow and impact preview.
   - Document scoped secret env files as an extension of existing secret manager behavior.

3. `docs/admin-concepts.md`
   - Update channel lifecycle and secret management concepts to current stack-spec + secret-manager model.
   - Remove admin-specific references.

4. `docs/docker-compose-guide.md`
   - Remove admin service from inventory and examples.
   - Describe generated compose contract and managed vs user-managed sections.

5. `docs/api-reference.md`
   - Remove/deprecate admin endpoints.
   - Add/refresh Admin endpoints for stack spec, secret-manager state, and apply preview/apply.

6. `docs/security.md`
   - Update threat model for direct Docker socket mount in Admin.
   - Document compose action allowlist and service-name validation controls.
   - Document scoped env-file exposure model and validation checks.

7. `docs/implementation-guide.md`
   - Reflect stack-spec + generator ownership model and apply validation gates.
   - Document rollback behavior and scoped secret rendering.

8. `docs/README.md`
   - Update guide descriptions that still mention admin APIs.
   - Keep links to stack-spec operational docs.

## Suggested delivery order (shortest path)

1. Phase 1 (transactional apply)
2. Phase 3 (expand existing secret manager + scoped files)
3. Phase 2 (Caddy snippets)
4. Phase 4 (impact planner + compose surface)
5. Phase 5 (shared lib consolidation, cleanup, docs, and test expansion)

This order minimizes risk by first establishing safe apply semantics, then hardening secret handling before larger config-layout changes.
