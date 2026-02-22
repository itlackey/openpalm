# Cross-service tests

Shared test suites that validate behavior across service boundaries. These complement the unit tests inside each service's own directory.

## Test layers

| Directory | Layer | What it validates | Command |
|---|---|---|---|
| `contracts/` | Contract | Spec parity between services (API shapes, message formats) | `bun test --filter contract` |
| `integration/` | Integration | End-to-end flows across running containers | `bun test --filter integration` |
| `security/` | Security | HMAC validation, input bounds, auth edge cases | `bun test --filter security` |

## Test files

- **`contracts/admin-api.contract.test.ts`** — Validates admin API response shapes match expected contracts
- **`contracts/channel-message.contract.test.ts`** — Validates `ChannelMessage` format between channel adapters and gateway
- **`integration/channel-gateway.integration.test.ts`** — Tests the full message path from channel adapter through gateway
- **`security/hmac.security.test.ts`** — HMAC-SHA256 signing and verification edge cases
- **`security/input-bounds.security.test.ts`** — Input size limits, malformed payloads, boundary conditions

## Running

```bash
# All cross-service tests
bun test test/

# By layer
bun test --filter contract
bun test --filter integration
bun test --filter security

# Single file
bun test test/security/hmac.security.test.ts
```

## Naming convention

Test files follow the pattern `<name>.<layer>.test.ts` (e.g., `hmac.security.test.ts`). The layer tag in the filename enables `--filter` to select tests by layer.
