# @openpalm/lib

Shared OpenPalm control-plane library. The CLI and host UI import this package
so lifecycle, Compose, filesystem, addon, secret, and validation behavior has
one implementation.

The package ships TypeScript source and requires Bun.

## Runtime Contract

`@openpalm/lib` operates on the current `OP_HOME` layout:

- managed Compose files in `system/stack/`
- one user overlay at `config/stack/custom.compose.yml`
- one non-secret Compose env file at `state/stack.env`
- delegated service credentials in `state/secrets/`
- assistant-readable provider auth at `knowledge/secrets/auth.json`
- AKM user env and tasks under `knowledge/`
- durable service data under `data/`
- regenerable caches under `cache/`

OpenPalm records first-party addons in `OP_ENABLED_ADDONS` and resolves them to
Compose profiles in the control plane. Raw Docker Compose must pass profiles
itself.

## Responsibilities

- Resolve and create the complete OpenPalm home layout
- Seed user assets and reconcile managed release assets
- Build canonical Compose file, env-file, and profile arguments
- Validate Compose and secret-grant boundaries before mutation
- Install, update, rollback, backup, and recovery workflows
- Enable/disable first-party addons and select hardware profiles
- Route delegated secrets to `state/secrets/`
- Manage OpenCode provider `auth.json`
- Parse AKM task files and expose automation state to host consumers
- Provide host UI asset, supervisor, endpoint, and release helpers
- Emit structured control-plane logs

## Main Areas

| Module | Purpose |
|---|---|
| `control-plane/home` and `paths` | Filesystem contract and path resolution |
| `control-plane/lifecycle` and `deploy` | Install/update/apply/rollback orchestration |
| `control-plane/docker` and `compose-args` | Shell-free Docker Compose invocation and profile resolution |
| `control-plane/secrets*` | Non-secret env, private delegated secrets, and provider auth |
| `control-plane/addons` | Built-in addon activation and hardware profiles |
| `control-plane/setup*` | Version 2 setup spec validation and persistence |
| `control-plane/markdown-task` and `scheduler` | AKM task parsing and host-facing automation adapters |
| `control-plane/ui-*` | Host UI assets, runtime config, and supervision |
| `logger` | Structured logging |

## Consumer Boundaries

| Consumer | Authority |
|---|---|
| CLI | Host-side Compose orchestrator |
| Host admin UI/API | Host-side control-plane surface using the same library |
| Assistant scheduler | In-container AKM task execution only; no Docker or host lifecycle authority |

Portable control-plane behavior belongs here, not duplicated in CLI or UI
routes. The assistant cannot call this package to gain host authority simply
because task parsing types are shared.

## Development

```bash
cd packages/lib
bun test
```

See [Core Principles](../../docs/technical/core-principles.md) for the
authoritative architecture and security invariants.
