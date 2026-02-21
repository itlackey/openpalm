# Contributor Checklist (Architecture-Safe Changes)

Use this checklist before merging admin/gateway stack changes.

- [ ] Keep `stack-spec.json` intent-only (channels, access, secrets mappings, connections, automations).
- [ ] Route-level code stays thin: validation + orchestration live in `packages/lib/admin/*` when possible.
- [ ] Admin errors return consistent shape: `{ error, details?, code? }`.
- [ ] Any new secret or connection flow is documented in `docs/development/api-reference.md`.
- [ ] Any new compose service behavior uses `compose-runner` allowlist helpers (no duplicated allowlists).
- [ ] If reload/restart semantics change, update `/admin/compose/capabilities` behavior and docs.
- [ ] Run targeted tests for changed packages (`bun test <path>`), plus `bun run typecheck` when touching TS APIs.
- [ ] Remove stale TODOs/comments related to replaced architecture decisions.
