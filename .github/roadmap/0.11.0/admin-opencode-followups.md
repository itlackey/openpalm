# OpenPalm 0.11.0 - Admin OpenCode Follow-up Work

## Purpose

This document carries forward follow-up work for the direct, host-only admin OpenCode instance shipped for `#304`.

The current 0.10.0 direction is:

- admin OpenCode runs inside the admin container
- it is exposed directly on `127.0.0.1:${OP_ADMIN_OPENCODE_PORT:-3881}`
- it is not brokered, proxied, or session-mediated through a separate runtime layer

## Source references

- `.github/roadmap/0.10.0/plans/issue-304-brokered-admin-opencode.md`
- `.github/roadmap/0.10.0/README.md`
- GitHub issue `#304`

## Follow-up areas for 0.11.0

### 1. Admin UI discoverability and status

Goal: make the admin-side OpenCode instance easier to find and verify from the admin app.

Carry-forward work:

- Add a dashboard/status card for admin OpenCode.
- Show whether the admin-side OpenCode web server is healthy.
- Link to the host-only port using the configured `OP_ADMIN_OPENCODE_PORT`.
- Surface clearer diagnostics when the bundled OpenCode process fails to start.

### 2. Hardening and operational resilience

Goal: make the direct admin OpenCode runtime more robust without changing the core architecture.

Carry-forward work:

- Harden startup and shutdown behavior in `core/admin/entrypoint.sh`.
- Improve degraded-health reporting for the admin container when SvelteKit and OpenCode diverge.
- Expand test coverage for host-only exposure, no public route, and admin-tools loading.
- Verify upgrade/restart behavior preserves the admin OpenCode config and expected port wiring.

### 3. Controlled remediation UX

Goal: let the admin OpenCode instance drive more guided repair flows while preserving existing admin API boundaries.

Carry-forward work:

- Add limited remediation tools mapped to existing admin/control-plane operations.
- Require explicit confirmation UX for state-changing actions.
- Keep remediation API-mediated rather than shell-mediated.
- Preserve auditability and clear actor attribution for admin OpenCode initiated actions.

## Explicitly not included by default

- no broker/session runtime
- no separate elevated proxy tier
- no public ingress for admin OpenCode
- no bypass of existing admin API auth and audit rules

## Suggested issue split for 0.11.0

- Admin OpenCode discoverability and health UX
- Admin OpenCode hardening
- Guided remediation tools for admin OpenCode
