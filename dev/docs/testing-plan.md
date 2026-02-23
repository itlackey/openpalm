# Testing Plan (v0.3.0)

## Goals
- Protect gateway ingress security and intake correctness.
- Protect admin config/apply lifecycle behavior.
- Keep shared generation/validation logic deterministic.
- Catch channel adapter regressions in payload mapping and retries.

## Required checks before merge
```bash
bun run typecheck
bun test
```

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

## Optional but recommended for risky changes
- `bun run dev:fresh` for end-to-end install + startup confidence.
- Container health checks after compose/routing changes.
- Focused integration tests under `test/integration` and `test/contracts`.
