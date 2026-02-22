# @openpalm/lib

Shared library used by all OpenPalm services. Published as a Bun workspace package (`workspace:*`).

## Exports

The package exposes three entry points:

| Import path | Contents |
|---|---|
| `@openpalm/lib` | Core utilities: channel types, crypto (HMAC), HTTP helpers, compose generation, config management, env/path resolution, preflight checks, runtime detection, token parsing, UI helpers |
| `@openpalm/lib/shared/*.ts` | Channel SDK and shared crypto/HTTP utilities for channel adapters |
| `@openpalm/lib/admin/*.ts` | Admin-specific modules: stack generator, stack spec, stack manager, compose runner, setup manager, automations, cron scheduling, extensions, impact planning, JSONC parsing, runtime env |

## Key modules

- **`channel.ts` / `types.ts`** — `ChannelMessage` type and channel-related types used across all services
- **`crypto.ts`** — HMAC-SHA256 signing and verification for channel-gateway communication
- **`compose.ts`** — Docker Compose file generation from stack specs
- **`config.ts`** — Configuration management (reading/writing opencode.jsonc, secrets.env)
- **`paths.ts`** — XDG-compliant path resolution (data, config, state homes)
- **`runtime.ts`** — Container runtime detection (Docker, Podman, OrbStack)
- **`preflight.ts`** — Environment validation checks
- **`admin/stack-spec.ts`** — Stack specification schema and validation
- **`admin/stack-generator.ts`** — Generates Docker Compose and Caddyfile from a stack spec
- **`admin/setup-manager.ts`** — First-boot setup wizard state machine
- **`admin/automations.ts`** — Cron-based automation definitions

## Usage

```typescript
import { type ChannelMessage } from "@openpalm/lib";
import { verifyHmac } from "@openpalm/lib/crypto.ts";
import { StackGenerator } from "@openpalm/lib/admin/stack-generator.ts";
```

## Tests

```bash
cd packages/lib && bun test
# or from repo root:
bun test packages/lib/
```
