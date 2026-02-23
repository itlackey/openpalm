# Contributor Checklist (Architecture-Safe Changes)

Use this checklist before merging admin/gateway stack changes.

- [ ] Keep `openpalm.yaml` intent-only (channels, access, channel config, automations).
- [ ] Route-level code stays thin: validation + orchestration live in `packages/lib/src/admin/*` when possible.
- [ ] Admin errors return consistent shape: `{ error, details?, code? }`.
- [ ] Any new secret or connection flow is documented in `dev/docs/api-reference.md`.
- [ ] Any new compose service behavior uses `compose-runner` allowlist helpers (no duplicated allowlists).
- [ ] If reload/restart semantics change, update `/compose/capabilities` behavior and docs.
- [ ] Run targeted tests for changed packages (`bun test <path>`), plus `bun run typecheck` when touching TS APIs.
- [ ] Run `bun run test:workflows` to verify all GitHub Actions workflows pass locally before pushing.
- [ ] Remove stale TODOs/comments related to replaced architecture decisions.
