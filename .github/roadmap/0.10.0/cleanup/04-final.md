# Cleanup Refactor Final Decision

Date: 2026-03-21

This document is the consensus outcome after reviewing:

- `.github/roadmap/0.10.0/cleanup/01.md`
- `.github/roadmap/0.10.0/cleanup/02.md`
- `.github/roadmap/0.10.0/cleanup/03.md`
- `docs/technical/core-principles.md`
- `docs/technical/code-quality-principles.md`
- current implementation under `.openpalm/stack/` and `packages/lib/src/control-plane/`

The goal of the 0.10.0 cleanup refactor is to reduce drift and operational ambiguity without changing the core filesystem contract, security model, or manual-first Docker Compose workflow.

## Consensus

We should keep the cleanup focused on removing real inconsistencies in the current system rather than introducing new abstractions.

The highest-value problems are:

1. Compose invocation behavior is not fully consistent across wrapper and library code.
2. Service discovery and management still rely on brittle filename conventions in some paths.
3. Env loading behavior is hard to reason about because it is under-documented.
4. Manual Compose operation is supported in principle, but the canonical preflight workflow is not documented strongly enough.

We should not turn this refactor into a platform redesign. In particular, we should not change the file-drop addon model, add new runtime truth surfaces, or rewrite the mount/security model as part of cleanup.

---

## Final Changes To Make In This Refactor

### 1) Unify the canonical Compose invocation contract

Keep and implement.

Make one shared Compose invocation contract in `@openpalm/lib` and align all orchestration entrypoints with it.

Required outcomes:

- use one resolved project-name path everywhere
- use one resolved compose file list path everywhere
- use one resolved env-file list path everywhere
- surface the resolved command and file set in diagnostics

Why this stays in scope:

- `.openpalm/stack/start.sh` supports `OP_PROJECT_NAME` and `--project-name`
- `packages/lib/src/control-plane/docker.ts` currently hardcodes `openpalm`
- this is a real correctness and parity issue, not a speculative cleanup

### 2) Make `docker compose config` the required preflight

Keep and implement.

Before apply/update style operations, run Compose render validation and use it as the canonical diagnostics path.

Required outcomes:

- preflight with `docker compose config`
- expose `docker compose config --services` where useful
- fail early on invalid merges, missing env inputs, or broken service definitions
- document the same workflow for manual operators

Why this stays in scope:

- it reduces wrapper/lib/manual drift
- it aligns with the compose-first architecture already documented
- it is low risk and high leverage

### 3) Replace filename-based service inference with explicit Compose-derived service discovery

Keep and implement.

Stop assuming overlay filename equals managed service name. Derive service names from Compose-resolved configuration or explicit metadata instead.

Required outcomes:

- remove filename-only service inference in control-plane lifecycle paths
- align admin/runtime service handling with actual Compose service names
- preserve current operator-visible compose behavior

Why this stays in scope:

- this is brittle today and can cause drift between overlays and managed-service logic
- it improves correctness without changing the architecture

### 4) Publish and enforce the env-loading contract

Keep and implement.

Document exactly how env values are sourced and used, and add tests around the agreed behavior.

Required outcomes:

- define precedence between process env, `--env-file`, service `env_file`, and inline `environment`
- distinguish substitution-time env from container runtime env
- keep service-level `env_file` where runtime injection is required
- remove only truly redundant env wiring after verification

Why this stays in scope:

- the current model is valid but too implicit
- the cleanup docs correctly identified operator confusion here
- this is mostly clarity and contract hardening, not redesign

### 5) Add a first-class manual operations runbook

Keep and implement.

Create a manual/no-tooling operations document that matches the exact supported Compose workflow.

Required outcomes:

- canonical `up`, `down`, `ps`, `logs`, and preflight examples
- addon file selection examples
- rollback and secret rotation guidance at the level already supported by current architecture
- explicit note that the compose file list remains deployment truth

Why this stays in scope:

- it reinforces the project's manual-first and tooling-optional contract
- it reduces operator error without adding implementation risk

### 6) Do a narrow compatibility cleanup only where it supports the items above

Keep, but keep it narrow.

Allowed cleanup:

- update stale comments and docs that still describe older runtime assembly behavior
- centralize remaining compatibility reads where they directly interfere with the Compose contract
- mark legacy paths clearly when they remain temporarily necessary

Why this stays in scope:

- this supports clarity
- it avoids turning cleanup into a broad migration project

---

## Changes To Defer

These are reasonable ideas, but they should not be part of the 0.10.0 cleanup refactor.

### 1) Full migration to `stack/` as the only implementation-time assembly path

Defer.

This is strategically attractive, but current lib/control-plane code still has deep `config/components` dependencies. Doing this partially would increase ambiguity instead of reducing it.

### 2) Narrowing the admin addon from full `${OP_HOME}` mount to subpath mounts

Defer.

This is a valid hardening project, but it touches rollback, setup, secret access, workspace behavior, and runtime assembly. It is too broad for cleanup-sized change.

### 3) Drift reports, env explainability reports, mount audits, and doctor-style tooling

Defer.

These would be useful after the canonical Compose contract is cleaned up, but they are secondary to fixing the core inconsistencies first.

### 4) Canonical env alias deprecation and migration telemetry

Defer.

This needs its own migration plan once the canonical namespace is finalized.

### 5) Optional Docker secrets profiles

Defer.

This is a later hardening/usability tradeoff discussion, not a cleanup refactor task.

---

## Changes To Deny

These proposals should not be part of this refactor, and some should not become the default model at all.

### 1) Make Compose profiles the primary addon-selection mechanism

Deny.

This conflicts with the file-drop overlay model and with the principle that the compose file list is deployment truth.

Profiles may be evaluated later as an optional convenience, but not as the primary activation model.

### 2) Remove service-level `env_file` entries just because global `--env-file` is present

Deny.

Those mechanisms do different jobs. Global `--env-file` supports Compose substitution. Service `env_file` also injects runtime env into containers. Removing runtime `env_file` blindly would break current services.

### 3) Add a generated single-file `compose.bundle.yml` as a new operational artifact

Deny.

This creates another truth surface and increases drift risk instead of simplifying the system.

### 4) Replace the current secret model with broad Docker `secrets:` adoption in this cleanup pass

Deny for this refactor.

The current vault/env model is part of the documented contract and supports current hot-reload and operator ergonomics. Changing the default secret transport now is out of scope.

### 5) Refactor addon overlays into hidden shared files if that weakens file-drop transparency

Deny as a default approach.

Reducing duplication is good only if each addon remains a self-contained, understandable drop-in compose overlay. Any anchor/base-file approach that makes addons depend on hidden shared runtime fragments should be rejected.

---

## What Must Stay Intact

The cleanup docs reviewed correctly did not challenge these fundamentals, and this final plan keeps them unchanged:

- guardian-only ingress
- assistant isolation from Docker socket and broad host control
- host-owned persistent filesystem contract
- non-destructive lifecycle behavior for user-owned config
- manual-first Docker Compose operation
- file-drop addon model

---

## Final Refactor Scope

The 0.10.0 cleanup refactor should ship the following concrete outcomes:

1. one canonical Compose invocation contract across wrapper/lib/admin paths
2. project-name handling fixed across all orchestration paths
3. `docker compose config` and `config --services` added as standard preflight/diagnostics
4. filename-derived service inference removed from managed-service logic
5. env-loading contract documented and tested
6. a manual operations runbook added for tooling-free workflows
7. stale compatibility comments/docs trimmed where they conflict with the cleaned-up contract

Anything larger than that should move to a follow-up roadmap item instead of being folded into this cleanup pass.
