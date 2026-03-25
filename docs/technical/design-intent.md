# Design Intent

> Authoritative document. Do not edit without a specific request to do so, or direct approval.

This document explains the stable design intent behind OpenPalm.
It captures why the system is shaped the way it is and what must remain true as implementation details evolve.

## Primary goals

- The stack is manageable with Docker Compose and a file editor.
- Core runtime state is simple, visible, and host-owned under `OP_HOME` (default `~/.openpalm`).
- Tooling (CLI, admin, setup wizard, assistant tools) is convenience-only and must not become required hidden infrastructure.
- A technical user can always inspect, back up, and manually operate the stack through files and native Compose behavior.

## Core architecture intent

- OpenPalm is a file-assembly control plane over Docker Compose, not a template-rendering engine.
- Runtime behavior is composed from:
  - compose files (`stack/` core + addon overlays),
  - environment files (`vault/`),
  - service configuration files (`config/`).
- `stack.yml` is a metadata and coordination artifact for tooling, not a replacement for Compose or env files.
- All control-plane logic is implemented once in `@openpalm/lib`; CLI, admin, and scheduler are thin consumers.

## Filesystem and ownership model

- `config/` is user-owned, non-secret configuration and remains manually editable.
- `stack/` is the system-assembled live Compose runtime definition.
- `vault/` is the secrets boundary with strict mount and writer constraints.
- `data/` is durable service-managed state.
- `logs/` is consolidated audit and operational logging.
- Lifecycle operations must be non-destructive for user-owned config and user-managed vault content unless the user explicitly requests mutation.

## Security and boundary intent

- Host CLI or admin orchestrates Compose operations; Docker socket exposure is tightly constrained.
- Guardian is the only ingress path from channel networks to the assistant.
- Assistant is isolated: no Docker socket, bounded mounts, and stack-management access mediated through authenticated admin APIs when admin is present.
- Host-only by default: interfaces are local unless the user explicitly opts into broader exposure. The LAN-first threat model is a deliberate architectural choice — admin token storage (localStorage), admin filesystem access (full `OP_HOME` mount), and scheduler API access (`OP_ADMIN_TOKEN`) are all scoped for a localhost/LAN deployment where the network perimeter itself is the primary trust boundary.
- Secret handling follows least privilege by container and by scope.

## Extensibility intent

OpenPalm has three extension points:

1. Addons: compose overlays that add optional services.
2. Assistant extensions: standard OpenCode assets under user and core extension directories.
3. Automations: scheduler-driven recurring workflows.

Channels are a specialized addon class that use the channel image and SDK pattern and must ingress through guardian.

## Assistant intent

- The assistant is an OpenCode runtime for user-facing interaction and workflows.
- It can read and write only within its defined mounted boundaries (assistant data, stash, workspace, and allowed config/vault paths).
- User extensions are mounted from `config/assistant/`.
- Core OpenCode assets are baked into the image under `/etc/opencode` and provide the default baseline behavior.

## Operational intent

- Apply and upgrade flows validate before writing live runtime assembly.
- Rollback exists as a first-class safety mechanism for failed deploy transitions.
- Backup and restore remain straightforward because state is concentrated under `~/.openpalm/`.
- Manual-first and tooling-first operations should converge on the same runtime result.

## Non-goals for this document

- This is not the full mount/env/port reference.
- This is not a release roadmap or issue implementation plan.
- This is not a service-by-service runbook.

Those details belong in the other authoritative documents, especially `core-principles.md` and `foundations.md`.
