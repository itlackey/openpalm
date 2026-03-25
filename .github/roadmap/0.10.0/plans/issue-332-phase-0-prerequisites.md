# Issue #332 - Phase 0 prerequisites

## Scope

- Track the shared v0.10.0 prerequisite work that must land before the main #301 unified component system implementation.
- Cover the platform-level changes the roadmap places on the critical path: the `~/.openpalm/` home layout, validate-in-place plus rollback, vault-aware asset rewrites, and 38XX port standardization.
- Keep this issue focused on shared infrastructure that also unblocks #300 and later 0.10.0 work, rather than folding it into the component-system-specific checklist.

## Checklist

- Replace XDG path helpers with an `OP_HOME`-based home layout API in `packages/lib` and add legacy-layout detection for CLI and admin consumers.
- Remove the permanent staging pipeline, add validate-in-place with rollback snapshots, and expose a rollback command path through lib and CLI.
- Rewrite core compose, Caddy, env templates, and setup assets for the `~/.openpalm/` layout, vault boundary, and 38XX port standardization.

## Relevant files

- `.github/roadmap/0.10.0/README.md:169` - roadmap Phase 0 scope and port standardization tasks.
- `.plans/issue-301-unified-component-system.md:13` - original shared-prerequisite split from #301.
- `docs/technical/core-principles.md:30` - authoritative filesystem, vault, and rollback contract.
- `packages/lib/src/control-plane/paths.ts:1` - current XDG path helper entry point to replace.
- `packages/lib/src/control-plane/staging.ts:1` - current staging implementation to retire.
- `assets/docker-compose.yml:1` - core asset rewrite entry point for paths, mounts, and ports.
