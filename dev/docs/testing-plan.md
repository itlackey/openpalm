# Testing Plan (v0.3.0)

## Goals
- Protect gateway ingress security and intake correctness.
- Protect admin config/apply lifecycle behavior.
- Keep shared generation/validation logic deterministic.
- Catch channel adapter regressions in payload mapping and retries.
- **Ensure all tests pass on fresh CI runners** (no OpenPalm installed, no XDG state).

## Required checks before merge
```bash
bun run typecheck
bun test
```

## Pre-release checks
See `dev/docs/release-quality-gates.md` for the full pre-release checklist and
environment guard rules.

## Test tiers and when to run them

### Tier 1: Local + CI default (hermetic)
- **Scope:** unit tests, contract tests, and fast integration that do not require Docker or Playwright.
- **Command:** `bun run test:ci`
- **Guarantee:** No container, Docker daemon, or browser dependency.

### Tier 2: UI e2e (Bun runtime)
- **Scope:** SvelteKit UI flows + admin API contracts under a hermetic runtime.
- **Command:** `bun run test:ui`
- **Notes:** Runs the UI server under Bun with Playwright. Compose/apply orchestration is disabled in test mode.

### Tier 3: Docker stack integration (opt-in)
- **Scope:** Image build + compose stack health checks.
- **Command:** `bun run test:docker`
- **Notes:** Requires Docker daemon and builds images locally. Run only in dedicated Docker-capable environments. Docker tests live under `test/docker/*.docker.ts` and are excluded from `bun test` discovery.

If your change is scoped, run targeted suites too (workspace or file-level).

## Priority test areas

### 1) Core gateway
- Signature/auth validation
- Rate limiting behavior
- Intake parsing/decision handling
- Assistant client timeout and error paths

### 2) Core admin
- Setup state transitions
- Config render/apply behavior
- Compose allowlist enforcement
- Secrets + automations API behavior

### 3) Shared lib (`packages/lib`)
- YAML parsing and schema validation
- Secret interpolation and missing-secret failures
- Rendered compose/caddy/env output stability

### 4) Channels
- Provider payload parsing and normalization
- Retry/idempotency behavior for webhook-style inputs
- Correct forwarding to gateway contract

### 5) UI/CLI integration paths
- Auth/session handling for admin-backed actions
- Config editor save/apply roundtrips
- CLI command behavior and non-zero exit handling on failure

## Environment flags used by tests
- `OPENPALM_TEST_MODE=1` — disables compose/apply side effects in UI routes.

## Optional but recommended for risky changes
- `bun run dev:fresh` for end-to-end install + startup confidence.
- Container health checks after compose/routing changes.
- Focused integration tests under `test/integration` and `test/contracts`.

---

## Local install/setup reliability plan

Detailed implementation guidance has moved to `dev/docs/install-setup-reliability-implementation-guide.md` to keep this document focused on test tiers and merge-time checks.

For installer-focused end-to-end planning, scenario design, and rollout steps, use the dedicated guide.

For release-critical setup wizard strategy and prioritized e2e gates, see `dev/docs/setup-wizard-e2e-test-strategy.md`.
