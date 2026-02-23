# Core: Admin

## Rules
- Admin owns orchestration (setup, config apply, compose lifecycle), not channel logic.
- Preserve strict allowlists for any shell/compose operations.
- Keep generated runtime artifacts in STATE/DATA/CONFIG contracts.

## Patterns
- Put business rules in reusable lib helpers; keep HTTP handlers thin.
- Validate all API inputs and surface actionable error messages.
- Keep installer/setup flows resumable and idempotent.

## Gotchas
- Avoid writing derived runtime state back into intent config.
- Be careful with path handling for mounted host directories.
- Never relax auth/session checks for non-setup endpoints.
