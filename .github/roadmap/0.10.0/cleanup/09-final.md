# Cleanup Refactor Consolidated Final Decision

Date: 2026-03-21

This document consolidates and supersedes:

- `.github/roadmap/0.10.0/cleanup/04-final.md`
- `.github/roadmap/0.10.0/cleanup/05.md`
- `.github/roadmap/0.10.0/cleanup/06.md`
- `.github/roadmap/0.10.0/cleanup/07.md`
- `.github/roadmap/0.10.0/cleanup/08.md`

It is the canonical final recommendation for the 0.10.0 cleanup refactor.

## Non-Negotiable Directives

The following are required outcomes for this cleanup:

1. remove all active runtime/control-plane references to `config/components`
2. remove wrappers that provide no meaningful value beyond native Docker Compose behavior
3. support Compose `extends` as an optional pattern and document safe usage, without making it the common/default addon pattern
4. remove aliases, shims, backward-compatibility paths, and legacy support code

These directives must be implemented without violating `docs/technical/authoritative/core-principles.md` or `docs/technical/code-quality-principles.md`.

---

## Core Position

The cleanup should collapse OpenPalm onto one runtime model and one Compose orchestration contract.

The canonical runtime truth is:

- `~/.openpalm/stack/core.compose.yml`
- `~/.openpalm/stack/addons/*/compose.yml`

The canonical operator workflow is raw `docker compose` with explicit file lists. Any remaining wrapper must justify itself by adding OpenPalm-specific value such as preflight validation, diagnostics, or policy enforcement.

No part of this cleanup should introduce a new truth surface, rendered bundle, profile-first activation model, or fresh compatibility layer.

---

## Keep And Implement

### 1) Remove `config/components` from all active runtime/control-plane paths

Keep and implement.

This includes not just primary lifecycle code, but also all secondary and supporting paths.

Required outcomes:

- remove active reads/writes of compose artifacts under `config/components`
- standardize compose assembly on `stack/core.compose.yml` and `stack/addons/*/compose.yml`
- remove `config/components` assumptions from rollback, asset providers, bootstrap/setup, and tests
- stop creating `config/components` in steady-state home bootstrap
- update docs/comments so `config/components` is no longer described as part of the active runtime model

Notes:

- do not automatically delete user-owned directories during lifecycle operations
- if legacy directories remain on disk, they may be ignored and documented for optional manual cleanup

### 2) Unify the Compose invocation contract and remove no-value wrappers

Keep and implement.

There should be one canonical Compose resolution path for project name, compose file list, env-file list, and emitted diagnostics.

Required outcomes:

- one shared project-name resolver used everywhere
- one shared file-list resolver used everywhere
- one shared env-file resolution path used everywhere
- diagnostics always show resolved project name, compose files, and env files
- remove wrappers/scripts that only restate native Compose flags or passthrough behavior
- keep only thin wrappers that add real OpenPalm value such as preflight, guardrails, or diagnostics

### 3) Make `docker compose config` the authoritative preflight gate

Keep and implement.

Compose render validation must be part of code behavior, not just documentation.

Required outcomes:

- install/apply/update operations fail before mutation if `docker compose config` fails
- `docker compose config --services` is used where service discovery or diagnostics need resolved Compose truth
- preflight errors include the resolved command, file list, env files, and project name
- manual docs use the same preflight workflow

### 4) Replace filename-derived service inference with Compose-derived service discovery

Keep and implement.

Lifecycle-managed service lists, allowlists, and diagnostics must derive from resolved Compose output rather than overlay filenames.

Required outcomes:

- remove filename-based service inference in lifecycle helpers
- remove `channel-*.yml` assumptions from channel/service allowlist logic
- make service discovery compatible with multi-service overlays and optional `extends`
- keep any explicit metadata subordinate to resolved Compose truth

### 5) Fix the env/schema validation contract

Keep and implement.

The schema validation paths must match the actual documented and shipped vault layout.

Required outcomes:

- align validation with `vault/user/user.env.schema`
- align validation with `vault/stack/stack.env.schema`
- add tests proving schema validation fails when schema or values are invalid
- document precedence between process env, `--env-file`, service `env_file`, and inline `environment`
- clearly distinguish substitution-time env from runtime container env injection
- keep service-level `env_file` where runtime injection is required

### 6) Remove aliases, shims, deprecated exports, and legacy compatibility code

Keep and implement.

This removal must happen in active call sites and public exports, not just in comments.

Required outcomes:

- migrate callers from deprecated path helpers to canonical `home.ts` APIs
- remove deprecated compatibility exports from public barrels once callers are migrated
- remove alias write-paths and deprecated fallback behavior from active orchestration code
- delete stale comments/docs that preserve old assembly or env/path models
- leave one canonical code path rather than layered fallback logic

### 7) Support Compose `extends` optionally, with guidance and verification

Keep and implement.

OpenPalm should support addons that use Compose `extends`, but this should remain an advanced optional pattern rather than the standard addon authoring approach.

Required outcomes:

- ensure canonical compose resolution/preflight works when an addon uses `extends`
- provide guidance on when `extends` is appropriate and when a self-contained addon file is better
- keep the normal addon model simple, transparent, and file-drop friendly
- add at least one narrow validation fixture or smoke check proving optional `extends` support works

### 8) Publish one canonical manual operations runbook

Keep and implement.

Operator docs should teach the same workflow that the code now enforces.

Required outcomes:

- one manual runbook covering `config`, `config --services`, `up`, `down`, `ps`, and `logs`
- explicit examples using the real compose file list
- explicit statement that the compose file list is deployment truth
- docs updated in one pass if wrapper guidance changes
- legacy runtime-path references in operator docs treated as release blockers

### 9) Add narrow regression guardrails for the cleaned-up contract

Keep and implement.

The cleanup should be protected by a small set of durable tests/checks.

Required outcomes:

- test or check that banned runtime `config/components` references are not reintroduced
- test or check that hardcoded compose project names are not reintroduced in orchestration code
- test that lifecycle preflight runs `docker compose config` before mutation/apply
- test that managed service discovery is Compose-derived, not filename-derived

---

## Defer

These are valid ideas, but they are not required to complete the 0.10.0 cleanup.

### 1) Narrowing the admin addon away from full `${OP_HOME}` mount

Defer.

This is a larger hardening project touching rollback, setup, secrets, workspace behavior, and runtime assembly.

### 2) Larger doctor/drift/explainability tooling

Defer.

Helpful, but secondary to removing the underlying contract drift first.

### 3) Broad Docker `secrets:` adoption or secret-model redesign

Defer.

This cleanup should not replace the current documented vault/env contract.

### 4) Broader component-instance/data-components redesign

Defer unless directly required to keep core stack lifecycle off legacy runtime compose paths.

The cleanup should be strict about core stack orchestration, but should not silently expand into a wider platform redesign.

---

## Deny

These should not be part of the cleanup plan.

### 1) Make Compose profiles the primary addon activation model

Deny.

This conflicts with the file-drop overlay model and with the principle that the compose file list is deployment truth.

### 2) Remove service-level `env_file` just because global `--env-file` exists

Deny.

Those mechanisms serve different purposes. Removing runtime `env_file` blindly would break services.

### 3) Add a generated `compose.bundle.yml` or other rendered truth surface

Deny.

This would add another assembly artifact and increase drift.

### 4) Reintroduce new compatibility fallbacks after cleanup

Deny.

The point of the cleanup is to converge onto one supported contract, not create a new compatibility layer.

### 5) Make `extends` the default/common addon authoring style

Deny.

`extends` is supported as an option only. The normal addon model should remain transparent and self-contained.

### 6) Auto-delete user-owned legacy directories during lifecycle operations

Deny.

That conflicts with the non-destructive user-owned config contract.

---

## Release Gates

Cleanup should not be considered complete unless all of the following are true:

1. no active runtime/control-plane compose path uses `config/components`
2. `ensureHomeDirs()` no longer creates legacy runtime compose directories
3. rollback snapshots/restores use canonical stack compose assets, not legacy component paths
4. all orchestration paths resolve project name, compose files, and env files from one canonical code path
5. lifecycle mutation paths run `docker compose config` before mutation/apply
6. managed services are derived from resolved Compose output, not filenames
7. deprecated path/env aliases are removed from active callers and public exports
8. schema validation paths match the canonical nested vault schema layout
9. manual docs teach the same workflow the code now uses
10. optional `extends` support is verified without making it the common addon pattern

---

## Status Of Prior Docs

- `04-final.md` is the baseline that established the right direction.
- `05.md`, `06.md`, and `08.md` add concrete repo-sweep findings that should be folded into implementation.
- `07.md` should be treated as superseded by this document rather than kept as a second competing final decision.

This file is now the single final recommendation for the cleanup refactor.
