# @openpalm/lib

Shared control-plane library for OpenPalm.
CLI, admin, and scheduler use this package so stack behavior stays consistent.

> **Bun required.** This package ships TypeScript source and relies on Bun's native TS execution. It does not compile to JavaScript and is not compatible with Node.js.

The current model is direct-write over `~/.openpalm/` plus native Docker Compose.
Compose files in `stack/` and env files in `vault/` are the live runtime inputs.

## What lives here

- OpenPalm home/path helpers
- Env parsing and secret management
- Addon install/uninstall and registry helpers
- Compose lifecycle wrappers
- Memory and connection profile helpers
- Automation parsing used by the scheduler
- Shared structured logging

## Important context

- Some filenames still use legacy names like `staging`; those modules now support the direct-write compose model
- `config/` is user-owned, `knowledge/env/stack.env` is system-managed, `registry/` is catalog-only, and `stack/addons/` contains enabled runtime overlays
- New reusable control-plane logic belongs here, not duplicated in consumers

## Main module areas

| Module area | Purpose |
|---|---|
| `control-plane/home` and `control-plane/paths` | Resolve the OpenPalm home layout |
| `control-plane/env` and `control-plane/secrets` | Read, merge, and patch env files |
| `control-plane/lifecycle` and `control-plane/docker` | Compose operations and stack lifecycle helpers |
| `control-plane/portals` and `control-plane/components` | Addon discovery and install/uninstall logic |
| `control-plane/provider-models` | Provider model discovery helpers |
| `control-plane/scheduler` | Automation parsing and scheduler helpers |
| `logger` | Shared structured logger |

## Consumer model

- CLI: direct host-side orchestrator
- Admin: optional UI/API wrapper
- Scheduler: automation runner without Docker socket access

See `docs/technical/core-principles.md` for the authoritative filesystem contract and security rules.
