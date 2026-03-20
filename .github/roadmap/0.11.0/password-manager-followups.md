# OpenPalm 0.11.0 - Password Manager Follow-up Work

## Purpose

This document carries forward the password-manager work that was explicitly deferred out of the 0.10.0 implementation scope.

It is derived from the original 0.10.0 password-manager roadmap and the normalized issue plan for `#300`.

## Source references

- `.github/roadmap/0.10.0/README.md:45`
- `.github/roadmap/0.10.0/README.md:59`
- `.github/roadmap/0.10.0/openpalm-pass-impl-v3.md:1246`
- `.plans/issue-300-password-manager.md:126`

## Deferred phases from the original plan

### Phase 5 - Password Manager UI

Goal: add a first-class admin UI for secrets management once the backend, auth split, and admin secrets API surface from 0.10.0 are stable.

Carry-forward work:

- Add `SecretsTab.svelte` as a dedicated secrets-management UI.
- Show the active backend/provider in the UI.
- Render capability-aware actions from `GET /admin/secrets`, including set, generate, and delete where supported.
- Show hierarchical namespaces such as `core/`, `component/`, and `custom/`.
- Register the tab in the admin tab bar after Connections.

### Phase 6 - Connections endpoint refactor

Goal: make the existing connections patch flow backend-aware so it uses `SecretBackend` consistently instead of special-casing plaintext env-file mutation.

Carry-forward work:

- Refactor `patchConnections()` to write through `SecretBackend`.
- Route secret and non-secret keys through the backend routing layer.
- Reject secret writes from non-admin callers while preserving permitted non-secret writes.
- Use token-aware caller identification with `identifyCallerByToken()`.
- Keep the endpoint backend-agnostic so plaintext and `pass` use the same contract.

### Phase 7 - Migration tooling

Goal: provide a clean post-0.10 migration path from plaintext vault files into the encrypted `pass` provider.

Carry-forward work:

- Add `scripts/migrate-to-pass.sh`.
- Migrate `vault/user.env` and `vault/system.env` into `~/.openpalm/data/secrets/pass-store/`.
- Add CLI commands for `openpalm secrets init`, `migrate`, `ls`, `set`, and `generate`.
- Preserve safe skip behavior for pre-existing pass entries.
- Archive migrated plaintext env files after successful migration.

## Suggested issue split for 0.11.0

- Password Manager UI
- Connections SecretBackend refactor
- Pass migration tooling and CLI secrets commands
