# @openpalm/lib

Shared library package used across OpenPalm services. This package is never
published — it is consumed via Bun workspace resolution (local dev) or copied
directly into Docker images (production builds).

## Module Zones

The library is organized into three zones, each with a distinct audience:

### 1. `src/` — CLI modules

**Consumers**: `packages/cli` (the `openpalm` CLI tool)

Contains modules for host-level operations: XDG path resolution, Docker Compose
orchestration, environment file management, terminal UI helpers, and preflight
checks. These modules often depend on the host filesystem layout and are not
suitable for use inside containerized services.

**Files**: `assets.ts`, `compose.ts`, `config.ts`, `env.ts`, `paths.ts`,
`preflight.ts`, `runtime.ts`, `tokens.ts`, `types.ts`, `ui.ts`

### 2. `src/shared/` — Cross-service shared code

**Consumers**: Gateway, channel adapters (chat)

Contains the primitives that services running inside Docker need: HMAC
cryptography, HTTP response helpers, channel message types, and the channel SDK
for building and forwarding messages to the gateway.

**Files**: `crypto.ts`, `http.ts`, `channel.ts`, `channel-sdk.ts`, `channel-simple-text.ts`, `channel-adapter-http-server.ts`, `channel-http.ts`, `metadata.ts`, `logger.ts`, `shutdown.ts`, `yaml.ts`

### 3. `admin/` — Admin service modules

**Consumers**: The `admin` service exclusively

Contains the admin control-plane logic: Docker Compose runner, stack spec
parsing and generation, stack apply engine, runtime environment management,
and JSONC parsing.

**Files**: `compose-runner.ts`, `compose-spec.ts`,
`core-services.ts`, `runtime-env.ts`,
`stack-apply-engine.ts`, `stack-generator.ts`, `stack-manager.ts`,
`stack-spec.ts`

## Import Paths

The `package.json` `exports` field defines four entry points:

```jsonc
{
  "./*.ts":         "./src/*.ts",            // direct file imports from src/
  "./admin/*.ts":   "./src/admin/*.ts",      // admin zone
  "./shared/*.ts":  "./src/shared/*.ts"      // shared zone
}
```

### Pattern 1: Direct `src/` file import (CLI)

When the CLI needs a single module, direct imports are also fine:

```ts
import { composeDown } from "@openpalm/lib/compose.ts";
import { resolveXDGPaths } from "@openpalm/lib/paths.ts";
import { log, info, warn } from "@openpalm/lib/ui.ts";
```

### Pattern 3: Shared imports (gateway, channels)

Gateway and channel adapters import from the `shared` zone:

```ts
import { signPayload, verifySignature } from "@openpalm/lib/shared/crypto.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import { buildChannelMessage, forwardChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import type { ChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
```

### Pattern 4: Admin imports (admin service)

The admin service imports from the `admin` zone:

```ts
import { StackManager } from "@openpalm/lib/admin/stack-manager.ts";
import { parseStackSpec } from "@openpalm/lib/admin/stack-spec.ts";
```

## Where Should New Code Go?

| Question | Zone |
|----------|------|
| Used only by the CLI on the host machine? | `src/` |
| Shared between gateway and/or channels (runs in Docker)? | `src/shared/` |
| Used only by the admin service? | `admin/` |
| Used by both admin and another service? | `src/shared/` (move it there) |
| Used by both CLI and a service? | `src/shared/` |

## Docker Build

### Why the COPY workaround exists

Bun workspaces resolve `@openpalm/lib` via the monorepo `node_modules` symlink
on the host. Inside a Docker build, each service is built with the repo root as
the build context but installs its own `node_modules` from its `package.json`
alone — the workspace symlink is not available.

To make `@openpalm/lib` available inside the container, every Dockerfile that
imports from this package includes:

```dockerfile
COPY packages/lib /app/node_modules/@openpalm/lib
```

This copies the raw TypeScript source into the location where Bun's module
resolver expects it. Because Bun can run TypeScript directly, no build step is
needed.

### Affected Dockerfiles

All service Dockerfiles that import from `@openpalm/lib` must include the COPY
line. Currently:

- `core/admin/Dockerfile`
- `core/gateway/Dockerfile`
- `channels/chat/Dockerfile`

The `core/assistant/` service does not import from `@openpalm/lib` and does not need
this line.

### If the lib structure changes

Because the COPY line copies the entire `packages/lib/` directory, internal
restructuring (adding/removing/renaming files within the existing zones) does
not require Dockerfile changes. However, if the package name or the
`packages/lib` directory path changes, all affected Dockerfiles must be updated.

## Tests

```bash
cd packages/lib && bun test
# or from repo root:
bun test packages/lib/
```
