# OpenPalm 0.11.0 - Brokered Admin OpenCode Follow-up Work

## Purpose

This document carries forward the brokered admin OpenCode work that was explicitly deferred after the 0.10.0 baseline for `#304`.

The 0.10.0 scope keeps only the brokered foundations, session flow, diagnostics, and auth/audit path. The items below remain for 0.11.0.

## Source references

- `.plans/issue-304-brokered-admin-opencode.md:148`
- `.github/roadmap/0.10.0/README.md:108`
- GitHub issue `#304`

## Deferred phases from the normalized plan

### Phase 3 - Admin-mediated remediation

Goal: let the brokered admin runtime move beyond diagnostics/configuration help into controlled repair flows without becoming a system-level escape hatch.

Carry-forward work:

- Add a limited remediation toolset mapped to existing admin control-plane operations.
- Require explicit confirmation UX for state-changing actions.
- Keep remediation API-mediated rather than shell-mediated.
- Expand into guided repair flows while preserving admin attribution and auditability.

### Phase 4 - Hardening

Goal: harden the broker/session model after the 0.10.0 baseline proves out in practice.

Carry-forward work:

- Add session TTLs.
- Add one-shot grants or similarly narrow delegation semantics.
- Improve abuse resistance and session-boundary enforcement.
- Harden restart and upgrade behavior.
- Improve degraded-health reporting.
- Add deeper authz/isolation/audit/no-public-route test coverage.

## Explicitly not included by default

Direct exposure of a separate elevated OpenCode UI remains deferred indefinitely unless a fresh architecture review approves it.

## Suggested issue split for 0.11.0

- Admin-mediated remediation for the brokered runtime
- Brokered admin runtime hardening
