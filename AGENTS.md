# OpenPalm Agent Guidelines

## Project Overview

OpenPalm is a multi-channel AI assistant platform with a microservices architecture. It connects various communication channels (Discord, Telegram, Voice, Chat, Webhook) to an OpenCode agent runtime.

## Core Concepts

The platform is built around six concepts:
- **Extensions** -- capabilities added to the assistant (skills, commands, agents, tools, plugins), managed via the config directory
- **Connections** -- named credential sets for external services (AI providers, platforms, APIs), stored in secrets.env
- **Channels** -- adapter services for user-facing platforms (Discord, Telegram, Voice, Web Chat); placed on `channel_net`, exposed externally with configurable access scope
- **Services** -- internal add-on containers placed on `assistant_net` only; no Caddy routing, no external exposure, accessible only by admin and assistant
- **Automations** -- scheduled prompts that run on a cron schedule without user interaction
- **Gateway** -- security and routing layer between channels and the assistant

## Project Requirements

- Simplicity as a primary goal, for UX, DX, and architecture. If it is complex, you are doing it wrong.
- The openpalm tools (CLI, Admin, etc) exist to manage configuration for known technologies. They should not be complicated. Their primary goal is to take a simple spec and convert it to the necessary configuration and file system resources.
- Clarity, simplicity, and security should be central to all decisions and implementations.

## Thin Wrapper Principle

OpenPalm is an **integration and management tool**, not a deployment platform. It translates user intent into configuration files for existing tools (Docker Compose, Caddy, etc.) and then calls those tools. The execution layer must stay thin.

### Core domain logic (the product — keep and improve)

These components ARE the product. They translate user intent into configuration:

- **Stack spec parsing** (`packages/lib/src/admin/stack-spec.ts`) — Defines the configuration model. Validates user and snippet input at the boundary.
- **Stack generator** (`packages/lib/src/admin/stack-generator.ts`) — Translates spec into compose YAML, env files, and Caddy JSON. This is the core transformation.
- **Caddy JSON builder** (inside `stack-generator.ts`) — Programmatic generation of proxy config. Caddy JSON was chosen over Caddyfile to avoid regex/replace string manipulation for dynamic routes. This is intentional.
- **Snippet discovery** (`packages/lib/src/admin/snippet-discovery.ts`) — Helps non-technical users find compatible add-ons. Core product feature.
- **Setup manager** (`packages/lib/src/admin/setup-manager.ts`) — Wizard state tracking for first-boot UX.

### Execution layer (must be thin — delegate to Docker Compose)

Calling `docker compose` should be a passthrough, not an orchestration system. The CLI commands (`packages/lib/src/compose.ts` — `composeUp`, `composeDown`, `composeRestart`, etc.) are the model for how all compose interaction should work: simple wrappers that build args and call the tool.

**Critical rules for the execution layer:**

1. **One compose runner** — There must be a single shared implementation for running compose commands, used by both CLI and admin. Do not create parallel implementations.
2. **Do not reimplement Docker Compose** — Docker Compose already handles: service change detection, startup ordering (`depends_on`), health checking (`condition: service_healthy`), and removing orphaned services (`--remove-orphans`). Do not build custom equivalents.
3. **No custom deployment orchestration** — Applying a stack is: render artifacts → write files → `docker compose up -d --remove-orphans`. Handle Caddy reload as a small special case. No phased rollout, no apply locks, no impact planning.
4. **No multi-tier recovery** — The admin container is already running when apply is called (it's processing the request). If compose-up fails, return the error to the UI. The user retries from the admin panel.
5. **No artifact hashing or drift detection** — Do not SHA-256 hash files the tool just wrote. Container health status (`docker compose ps` formatted for the UI) is sufficient for showing users what's running.
6. **Surface Docker's own errors** — Docker produces clear, well-documented error messages. Pass them through to the user instead of wrapping them in custom error chains.
7. **Validate at boundaries only** — Validate user/snippet input once with `parseStackSpec()`. Validate generated output once with `docker compose config`. Do not add intermediate validation layers for artifacts the tool itself produced.
8. **Dependency injection over module globals** — Use a passed `runCompose` function or interface for testability. Do not use module-level mutable override registries.

### Anti-patterns to avoid

When working on compose/container management code, do NOT:

- Create separate compose runner implementations for CLI vs admin
- Build custom orchestration on top of `docker compose up`
- Add rollback systems, fallback bundles, or recovery cascades
- Implement change detection / impact planning (Docker Compose does this)
- Hash or checksum artifacts the tool generated
- Add per-apply preflight checks (Docker reports its own errors)
- Validate compose files the generator just produced in multiple ways
- Add speculative fields (rotation tracking, constraints) for features that don't exist yet
- Write hand-rolled YAML/compose parsers when `docker compose config` works

## Architecture Rules

These rules define how the system is structured. Follow them exactly when writing code or configuration.

### Mounts and directories

- Admin mounts all four known host directories: `DATA`, `STATE`, `CONFIG`, and workspace.
- Each container has its own data directory under `DATA/<container>`.
- Each container has its own state directory under `STATE/<container>` that contains the container's `.env` file.
- The OpenCode container home directory mounts to `DATA/assistant`.
- The generator writes all cron files to `STATE/automations` (mounted by Admin).
- Channels and services can specify additional mount paths relative to their `DATA` directory. For example, a container path of `/var/lib/example-data` mounts to `DATA/<container>/example`.

### Networking

- Channels are placed on `channel_net` and communicate only with the Gateway — never directly with OpenCode, OpenMemory, Admin, or any other service.
- Services are placed on `assistant_net` only — no Caddy routes, no external exposure.
- Core containers (Admin, Gateway, OpenCode, OpenMemory) are host or LAN only (not public).

### Secrets and environment

- The generator finds all secret references in a channel's config and produces a scoped `.env` for that container containing only those secrets sourced from `secrets.env`.

### Compose and Caddy generation

- Core containers have predefined Compose config that is always included in the generated Compose file.
- Channels and services both generate Docker Compose entries. Channels additionally generate Caddy JSON route entries.
- The Caddy config always includes routes to reach: Admin, OpenCode web UI, and OpenMemory UI.
- The generator produces a valid `caddy.json` file. Caddy JSON is used (not Caddyfile) to enable programmatic route generation without regex/replace string manipulation.
- Adding a channel or service is done by adding a YAML snippet to the spec and running the generator — no other code changes required.

### Plugins

- Adding OpenCode plugins is done by editing `DATA/assistant/.config/opencode/opencode.json`.

## Documentation Structure

Documentation is organized by audience and proximity to code. Start at the top level and drill down.

| Location | What's there | When to read it |
|---|---|---|
| `docs/` | User-facing guides: `cli.md`, `concepts.md`, `security.md`, `maintenance.md`, `troubleshooting.md`, `host-system-reference.md` | Understanding what OpenPalm is; install, CLI usage, security, maintenance |
| `core/admin/docs/` | Admin and operations: admin-guide, admin-concepts | Setting up and understanding the admin service |
| `dev/docs/` | Developer references: architecture, API reference, testing plan, versioning | Building features, understanding internals, API integration |
| `core/admin/README.md` | Admin service implementation: installer flow, cron jobs, compose lifecycle, directory layout | Changing or understanding the admin container itself |
| `core/gateway/README.md` | Gateway service: message pipeline, HMAC verification, channel intake agent | Changing or understanding the gateway container |
| `core/assistant/README.md` | Assistant service: extension architecture, built-in plugins/skills/tools, SSH access | Changing or understanding the assistant container |
| `channels/<name>/README.md` | Per-channel: endpoints, env vars, setup instructions | Setting up or modifying a specific channel adapter |

**Finding information quickly:**
- *How does a message flow from Discord to the assistant?* → `dev/docs/architecture.md`
- *What admin API endpoints exist?* → `dev/docs/api-reference.md`
- *How do I set up a Discord bot token?* → `channels/discord/README.md`
- *How do I back up or upgrade?* → `docs/maintenance.md`
- *What security controls are in place?* → `docs/security.md`
- *How do I add an extension?* → `core/assistant/README.md`

## Directory Structure

```
./openpalm
├── core/
│   ├── admin/      # Admin UI service
│   ├── assistant/  # OpenCode extensions
│   └── gateway/    # Main API gateway (entry point)
├── channels/       # Channel adapters
│   ├── chat/
│   ├── discord/
│   ├── telegram/
│   ├── voice/
│   └── webhook/
└── packages/       # Shared library, CLI, UI
```

## Build, Test, and Development Commands

### Running Tests

```bash
# Run all tests across all workspaces
bun test

# Run tests in a specific workspace
cd core/gateway && bun test
cd core/admin && bun test
cd channels/discord && bun test

# Run a single test file
bun test core/gateway/src/channel-intake.test.ts
bun test ./core/gateway/src/assistant-client.test.ts

# Run tests matching a pattern
bun test --match "channel intake"
```

### Type Checking

```bash
# Type-check all workspaces
bun run typecheck
```

### Development Scripts

```bash
bun run dev:setup       # Create .env and seed .dev/ directories
bun run dev:build       # Build images and start the stack
bun run dev:up          # Start the stack without rebuilding
bun run dev:down        # Stop and remove all containers
bun run dev:restart     # Restart containers
bun run dev:logs        # Tail logs
bun run dev:ps          # Show container status
bun run dev:fresh       # Full fresh-install test
```

### Running Individual Services

```bash
# Gateway
cd core/gateway && bun run start

# Admin
cd core/admin && bun run start
```

## Code Style Guidelines

### General Conventions

- **Runtime**: Bun (ES modules)
- **Language**: TypeScript with strict mode enabled
- **Module System**: ES modules (`"type": "module"` in package.json)
- **No linter/formatter**: Follow TypeScript and project conventions

### TypeScript Configuration

From `tsconfig.json`:
- Target: ES2022
- Module: ESNext
- ModuleResolution: Bundler
- Strict mode: enabled
- Types: bun

### Imports

- Use `import { ... } from "..."` for named imports
- Use `import type { ... }` for type-only imports to avoid runtime overhead
- Use full relative paths (e.g., `import { Foo } from "./foo.ts"` not `import { Foo } from "./foo"`)

```typescript
// Good
import { describe, expect, it } from "bun:test";
import type { ChannelMessage } from "./types.ts";
import { buildIntakeCommand } from "./channel-intake.ts";

// Avoid
import * as foo from "./foo";
```

### Naming Conventions

- **Files**: kebab-case (e.g., `channel-intake.ts`, `assistant-client.ts`)
- **Types/Interfaces**: PascalCase (e.g., `ChannelMessage`, `IntakeDecision`)
- **Functions**: camelCase (e.g., `buildIntakeCommand`, `parseIntakeDecision`)
- **Classes**: PascalCase (e.g., `OpenCodeClient`, `SetupManager`)
- **Constants**: PascalCase for exported, camelCase for local (e.g., `DEFAULT_TIMEOUT_MS`)

### Type Definitions

- Use explicit types for function parameters and return values
- Use `Record<string, unknown>` for generic object maps
- Use `unknown` for catch clause errors, then narrow with type guards

```typescript
// Good
export type ChannelMessage = {
  userId: string;
  channel: string;
  text: string;
  attachments?: string[];
  metadata?: Record<string, unknown>;
  nonce: string;
  timestamp: number;
};

function parseIntakeDecision(raw: string): IntakeDecision {
  // ...
}

// Error handling
catch (error) {
  if (error instanceof DOMException && error.name === "AbortError") {
    throw new Error(`opencode timeout after ${DEFAULT_TIMEOUT_MS}ms`);
  }
  throw error;
}
```

### Error Handling

- Throw descriptive errors with specific codes/messages
- Use error codes in snake_case (e.g., `"missing_summary_for_valid_intake"`)
- Validate inputs at boundaries
- Use try/catch/finally for async operations with cleanup

```typescript
// Good examples
if (start === -1 || end === -1 || end < start) throw new Error("missing_json_object");
if (typeof parsed.valid !== "boolean") throw new Error("invalid_valid_flag");
if (parsed.valid && !summary) throw new Error("missing_summary_for_valid_intake");
```

### Testing Conventions

- Use `bun:test` framework (import from "bun:test")
- Use `describe` blocks for test suites
- Use `it` for individual test cases
- Use descriptive test names explaining what is being tested
- **All tests must pass on fresh CI runners** (no OpenPalm installed, no XDG state).
  Use `skipIf` guards for environment-dependent tests — see `dev/docs/release-quality-gates.md`.
- Tests that call `docker compose` with file arguments must guard on `openpalmInstalled`
  (Docker available AND compose file + env file exist), not just `dockerAvailable`.
- Separate command routing tests (does the CLI recognize the command?) from execution
  tests (does the underlying compose call succeed?).

```typescript
import { describe, expect, it } from "bun:test";

describe("channel intake", () => {
  it("builds an intake command with strict json instructions", () => {
    const command = buildIntakeCommand({...});
    expect(command).toContain("strict JSON");
  });
});
```

### Release & CI

- All code changes to `main` must go through a PR. Direct pushes bypass CI and risk
  breaking the release pipeline.
- The Release workflow (`release.yml`) runs unit tests, integration, contract, security,
  UI, and Docker build gates before creating a tag. Do not remove or weaken these gates.
- The `publish-cli` workflow runs CLI tests again as a safety net, but the release
  workflow gates are the primary defense.
- See `dev/docs/release-quality-gates.md` for the full pre-release checklist.

### Adding a new channel, package, or core container

Whenever a new channel (`channels/<name>/`), package (`packages/<name>/`), or core
container (`core/<name>/`) is introduced, update **all four** of the following assets in
the same PR — missing any one will cause the version bump or Docker publish to silently
skip the new component:

1. **`dev/version.ts`** — Add an entry to the `COMPONENTS` record:
   - `image: true` for anything that has a `Dockerfile` (channels, core containers)
   - `image: false` for npm-only packages (`cli`, `lib`, `ui`)
   - The `packageJson` path must point to the component's own `package.json`

2. **`.github/workflows/publish-images.yml`** (image-bearing components only):
   - Add `"<name>/v*"` to the `on.push.tags` list
   - Add `"<name>"` to the `workflow_dispatch.inputs.component.options` list
   - Add a JSON object to the `ALL_IMAGES` array in the `Build matrix` step
     (use root context `"."` if the Dockerfile copies from `packages/lib`)

3. **`.github/workflows/release.yml`**:
   - Add `"<name>"` to the `inputs.component.options` list
   - Add a `case` entry inside the `docker-build` job's shell script (image-bearing only)
   - Add the Dockerfile to the `platform` DOCKERFILES line (image-bearing only)

4. **`.github/workflows/version-bump-pr.yml`**:
   - Add `"<name>"` to the `inputs.component.options` list

### Environment Variables

- Use `Bun.env` with defaults: `const PORT = Number(Bun.env.PORT ?? 8090);`
- Use uppercase with underscores: `Bun.env.OPENCODE_TIMEOUT_MS`

### Response Formatting

```typescript
// For HTTP responses in Bun
function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}
```

### Docker/Compose

- Core services are always allowed: `assistant`, `gateway`, `openmemory`, `admin`, `channel-chat`, `channel-discord`, `channel-voice`, `channel-telegram`, `caddy`
- Additional services can be allowed via `OPENPALM_EXTRA_SERVICES` env var (comma-separated list)
