# Design Intent

This document explains OpenPalm's stable design philosophy. The enforceable
architecture, security invariants, and filesystem contract live in
[`core-principles.md`](core-principles.md).

## Goals

- Keep the runtime operable with Docker Compose and ordinary files.
- Keep all durable state visible under `OP_HOME` (normally `~/.openpalm`).
- Make the host CLI self-sufficient; the optional admin UI uses the same shared
  control-plane library.
- Avoid hidden infrastructure, generated templates, and duplicated lifecycle
  implementations.

## Runtime Shape

OpenPalm is a file-assembly control plane over Docker Compose:

- `system/` contains release-managed files and is replaced on reconcile.
- `config/` contains user-owned non-secret configuration and is seeded only
  when a default is missing.
- `state/stack.env` contains non-secret app-written runtime state.
- `knowledge/secrets/auth.json` contains assistant-readable OpenCode provider
  authentication.
- `private/secrets/` contains delegated UI, OpenCode-server, Guardian, API,
  portal, and bot credentials outside assistant `/stash`.
- `data/`, `cache/`, `knowledge/`, and `workspace/` have the ownership and
  backup behavior defined in `core-principles.md`.

Whole files are assembled from shipped assets. The control plane does not
render Compose templates or merge arbitrary fragments into managed files.

## Trust Boundaries

- The host CLI or an admin-capable host UI is the orchestrator.
- The assistant has no Docker socket, admin credential, or network path to the
  loopback-only admin process.
- Guardian is profile-gated. Every portal request reaches the assistant through
  Guardian's authenticated `/oc/*` proxy.
- All host publications default to loopback. Broader binds require an explicit
  service-specific access toggle.
- Containers receive delegated credentials as named files, not broad secret
  directories or environment files. The sole exception is Paperclip's audited,
  exact-key `private/env/paperclip.env`, required by its digest-pinned upstream
  image.

## Extensibility

OpenPalm has three deliberate extension points:

1. Compose addons, including custom services in `config/stack/custom.compose.yml`.
2. Standard OpenCode configuration, tools, plugins, skills, and agents.
3. AKM task files under `knowledge/tasks/`, executed by `crond` in the assistant.

Portal-style addons are a specialized Compose addon and must use Guardian
ingress. New host orchestration behavior belongs in `@openpalm/lib`, not in a
consumer-specific implementation.

## Operations

- Install and update overwrite managed assets, preserve user-owned files, and
  validate the assembled Compose configuration before mutation.
- Rollback and backups cover durable state, including `private/`, but exclude
  regenerable caches.
- A native Electron harness changes only when its native contract changes. The
  UI and shared control plane update independently through the installed UI
  package.
- Manual and tool-driven operations must converge on the same files and Compose
  behavior.

Detailed mounts, variables, routes, and release mechanics belong in their
domain references; they are intentionally not duplicated here.
