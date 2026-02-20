# Simplification & Cleanup Review Checklist

This checklist captures follow-up areas to simplify architecture/implementation and reduce repo drift.

## 1) Admin API surface simplification

- Consolidate overlapping setup/system endpoints in `admin/src/server.ts` into fewer capability-focused routes.
- Move remaining server route logic into `packages/lib/admin` helper modules so `admin/src/server.ts` is a thin transport layer only.
- Standardize admin error responses to a single shape (`{ error, details?, code? }`) across all endpoints.

## 2) Stack-spec boundary hardening

- Keep `stack-spec.json` limited to user-managed intent only (channels, access, secret mappings, connections, automations).
- Audit for any derived/runtime fields accidentally reintroduced into stack-spec.
- Add a regression test that fails if non-intent fields are added to default spec output.

## 3) Secret manager UX/API consistency

- Add one canonical API contract doc for secret CRUD + mapping + connection reference flows.
- Ensure every secret selection UI uses live secret-key inventory from secret manager state.
- Add explicit tests for secret rename/migration workflows (if/when introduced).

## 4) Connections lifecycle completeness

- Add API/UI support to validate connection definitions without requiring value re-entry.
- Add tests for updating connection env-var target names while keeping same secret refs.
- Document service-specific conventions for common connection env var names (OpenAI, Anthropic, GitHub, etc.).

## 5) Compose/apply behavior parity

- Verify all direct service operations and stack apply operations use the same allowlist source.
- Add tests for edge cases where compose file changes but env files do not.
- Ensure service-level “reload” semantics are explicit per service (not inferred from restart behavior).

## 6) Docs drift prevention

- Continue pruning stale controller language and duplicate architecture explanations.
- Add a short “single source of truth” table mapping each concern to file/system of record.

## 7) Repo hygiene

- Remove outdated comments and stale TODOs that no longer match current architecture.
- Normalize documentation file naming (`reference` typo paths, duplicate concept sections).
- Add/refresh a lightweight contributor checklist for architecture-safe changes.
