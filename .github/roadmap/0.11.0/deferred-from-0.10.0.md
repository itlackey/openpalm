# OpenPalm 0.11.0 - Deferred Work Carried Forward from 0.10.0 Plans

## Purpose

This document collects the work that was explicitly moved out of the 0.10.0 plan set and into 0.11.0.

It is an aggregation layer over the original 0.10.0 roadmap, issue plans, and issue bodies so the deferred scope is visible in one place.

## Sources reviewed

- `.github/roadmap/0.10.0/README.md`
- `.github/roadmap/0.10.0/openpalm-pass-impl-v3.md`
- `.github/roadmap/0.10.0/knowledge-system-roadmap.md`
- `.github/roadmap/0.11.0/knowledge-system.md`
- `.plans/issue-300-password-manager.md`
- `.plans/issue-298-openviking-integration.md`
- `.plans/issue-304-brokered-admin-opencode.md`
- GitHub issues `#298`, `#300`, and `#304`

## Deferred scope summary

| Source | Deferred work now targeted at 0.11.0 | Primary source |
|--------|--------------------------------------|----------------|
| `#300` | Password Manager UI | `.github/roadmap/0.10.0/openpalm-pass-impl-v3.md:1246` |
| `#300` | Connections endpoint refactor onto `SecretBackend` | `.github/roadmap/0.10.0/openpalm-pass-impl-v3.md:1288` |
| `#300` | Pass-store migration tooling and CLI secrets commands | `.github/roadmap/0.10.0/openpalm-pass-impl-v3.md:1341` |
| `#298` | MCP server component | `.github/roadmap/0.11.0/knowledge-system.md:17` |
| `#298` | Eval framework | `.github/roadmap/0.11.0/knowledge-system.md:47` |
| `#298` | MemRL-inspired feedback loop | `.github/roadmap/0.11.0/knowledge-system.md:89` |
| `#304` | Admin-mediated remediation tools | `.plans/issue-304-brokered-admin-opencode.md:148` |
| `#304` | Hardening for the brokered admin runtime | `.plans/issue-304-brokered-admin-opencode.md:148` |

## 1. Password Manager work moved from 0.10.0 to 0.11.0

Source anchors:

- `.github/roadmap/0.10.0/README.md:45`
- `.github/roadmap/0.10.0/README.md:59`
- `.github/roadmap/0.10.0/openpalm-pass-impl-v3.md:1246`
- `.plans/issue-300-password-manager.md:126`
- GitHub issue `#300`: `https://github.com/itlackey/openpalm/issues/300`

### Phase 5 - Password Manager UI

This is the dedicated secrets-management UI that was intentionally cut from 0.10.0 once the backend, auth split, and admin secrets APIs became the shippable minimum.

Carry-forward work:

- Add `SecretsTab.svelte` as a first-class admin UI surface for secret management.
- Render provider-aware UI that adapts to backend capabilities returned by `GET /admin/secrets`.
- Show hierarchical secret namespaces such as `core/`, `component/`, and `custom/`.
- Expose provider-aware actions such as set, generate, and delete only when supported by the active backend.
- Show the active backend/provider in the tab header.
- Register the new tab in the admin tab bar after Connections.

### Phase 6 - Connections endpoint refactor

This is the cleanup pass that makes the existing connections APIs backend-aware instead of special-casing plaintext env-file mutation.

Carry-forward work:

- Refactor `patchConnections()` to write through `SecretBackend` instead of directly patching env files.
- Route secret and non-secret keys through the backend's routing layer.
- Reject secret writes from non-admin callers while preserving normal writes for permitted non-secret configuration.
- Switch the connections flow over to token-aware caller identification with `identifyCallerByToken()`.
- Make the endpoint backend-agnostic so plaintext and `pass` behave through the same API contract.

### Phase 7 - Migration tooling

This is the post-0.10 migration layer for moving existing plaintext vault installs into the encrypted `pass` provider model.

Carry-forward work:

- Add `scripts/migrate-to-pass.sh` for migrating `vault/user.env` and `vault/system.env` into the install-scoped pass store.
- Preserve the `~/.openpalm/data/secrets/pass-store/` convention introduced by the backend work.
- Add CLI commands for `openpalm secrets init`, `migrate`, `ls`, `set`, and `generate`.
- Ensure migration skips already-populated pass entries and archives migrated plaintext env files safely.
- Keep the migration compatible with the key-routing model used by `PlaintextBackend` and `PassBackend`.

## 2. Knowledge System work moved from 0.10.0 to 0.11.0

Source anchors:

- `.github/roadmap/0.10.0/README.md:88`
- `.github/roadmap/0.10.0/README.md:101`
- `.github/roadmap/0.10.0/knowledge-system-roadmap.md:287`
- `.github/roadmap/0.10.0/knowledge-system-roadmap.md:398`
- `.github/roadmap/0.10.0/knowledge-system-roadmap.md:503`
- `.github/roadmap/0.11.0/knowledge-system.md:1`
- `.plans/issue-298-openviking-integration.md:145`
- GitHub issue `#298`: `https://github.com/itlackey/openpalm/issues/298`

The detailed 0.11.0 plan for this area already lives in `.github/roadmap/0.11.0/knowledge-system.md`. The deferred scope carried forward from the original 0.10.0 plan is:

### Priority 2 - MCP server as a component

Carry-forward work:

- Create `packages/mcp/` for MCP server runtime, HTTP transport, and tool/resource registration.
- Add tool wrappers for admin, memory, Viking, and channel/component operations.
- Add a component definition at `registry/components/mcp/` with `.env.schema` and optional Caddy snippet.
- Add admin-generated client configuration such as `GET /admin/mcp/config` for MCP consumers like Claude Desktop or Cursor.

Detailed source: `.github/roadmap/0.11.0/knowledge-system.md:17`

### Priority 3 - Eval framework

Carry-forward work:

- Create `packages/eval/` for eval types, graders, runner, regression clustering, and CLI entrypoints.
- Add eval suites for assistant tools, memory retrieval, Viking retrieval, channel pipeline behavior, and security regression checks.
- Support shell-automation execution for scheduled eval runs.
- Add admin-facing results and regression endpoints.

Detailed source: `.github/roadmap/0.11.0/knowledge-system.md:47`

### Priority 4 - MemRL-inspired feedback loop

Carry-forward work:

- Add Q-value tracking to memory metadata.
- Implement two-phase retrieval with graceful degradation.
- Add automated maintenance scripts for knowledge cleanup and scoring.
- Add admin visibility for knowledge stats and system behavior.

Detailed source: `.github/roadmap/0.11.0/knowledge-system.md:89`

### Related knowledge work that stays with the 0.11.0 knowledge track

These items were also explicitly marked out of 0.10.0 in the 0.10 knowledge plan and should stay attached to the 0.11 knowledge track rather than being pulled back into #298:

- knowledge maintenance automations
- Viking retrieval eval suites and grading infrastructure
- MemRL/Q-value reranking and maintenance logic
- any generic `packages/mcp/` work beyond the shipped Viking component and assistant tools

## 3. Brokered Admin OpenCode work moved from 0.10.0 to 0.11.0

Source anchors:

- `.plans/issue-304-brokered-admin-opencode.md:148`
- GitHub issue `#304`: `https://github.com/itlackey/openpalm/issues/304`

0.10.0 keeps #304 scoped to phases 1-2: foundations, brokered session flow, diagnostics, configuration help, and audit/auth integration. The remaining work moved forward is:

### Phase 3 - Admin-mediated remediation

Carry-forward work:

- Add a limited remediation toolset mapped to existing admin control-plane operations.
- Add explicit confirmation UX for state-changing actions.
- Keep remediation API-mediated rather than turning the admin runtime into a shell-level privileged interface.
- Expand beyond diagnostics/configuration help into controlled repair flows.

### Phase 4 - Hardening

Carry-forward work:

- Add session TTLs and one-shot grants.
- Strengthen delegation semantics and abuse resistance.
- Harden restart and upgrade behavior for the brokered runtime.
- Improve degraded-health reporting for the broker/runtime pair.
- Add deeper test coverage for authz, isolation, auditability, and no-public-route guarantees.

### Explicit exclusion

The brokered-runtime plan also notes that direct exposure of a separate elevated OpenCode UI remains deferred indefinitely unless there is a fresh architecture review. That item is not counted here as 0.11.0 committed scope.

Source: `.plans/issue-304-brokered-admin-opencode.md:152`

## Not currently carried forward from the reviewed 0.10.0 plans

Based on the reviewed roadmap and issue plans, these areas do not currently have explicit 0.11.0 carry-forward scope defined in the accepted planning set:

- `#332` / shared Phase 0 filesystem, rollback, and port work - planned for 0.10.0, not deferred
- `#301` unified component system - planned for 0.10.0, not split into a separate accepted 0.11.0 follow-on plan
- `#315` Azure Container Apps deployment - still tracked as an additive 0.10.0 parallel track in the accepted roadmap and issue plan

## Recommended 0.11.0 execution order

1. Finish the knowledge-track deferred work in `.github/roadmap/0.11.0/knowledge-system.md`.
2. Land #300 deferred Phase 5-7 work after the 0.10.0 secrets backend and API surface are stable.
3. Land #304 deferred remediation and hardening after the 0.10.0 brokered runtime baseline is proven in production/dev use.

## Cross-links

- `.github/roadmap/0.11.0/knowledge-system.md` - detailed 0.11.0 knowledge-system plan already split out from 0.10.0
- `.github/roadmap/0.10.0/README.md` - original milestone summary with deferred markers
- `.plans/issue-300-password-manager.md` - normalized implementation framing for the 0.10/0.11 split on #300
- `.plans/issue-298-openviking-integration.md` - normalized implementation framing for the 0.10/0.11 split on #298
- `.plans/issue-304-brokered-admin-opencode.md` - normalized implementation framing for the 0.10/0.11 split on #304
