# OpenPalm Agent Guidelines

## Project Overview

OpenPalm is a multi-channel AI assistant platform with a microservices architecture. It connects various communication channels (Discord, Telegram, Voice, Chat, Webhook) to an OpenCode agent runtime.

## Core Concepts

The platform is built around five concepts:
- **Extensions** -- capabilities added to the assistant (skills, commands, agents, tools, plugins), managed via the config directory
- **Connections** -- named credential sets for external services (AI providers, platforms, APIs), stored in secrets.env
- **Channels** -- adapter services for user-facing platforms (Discord, Telegram, Voice, Web Chat)
- **Automations** -- scheduled prompts that run on a cron schedule without user interaction
- **Gateway** -- security and routing layer between channels and the assistant

## Project Requirements

- Simplicity as a primary goal, for UX, DX, and architecture. If it is complex, you are doing it wrong.
- The openpalm tools (CLI, Admin, etc) exist to manage configuration for known technologies. They should not be complicated. Their primary goal is to take a simple spec and convert it to the necessary configuration and file system resources.
- Clarity, simplicity, and security should be central to all decisions and implementations.

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

- Channels communicate only with the gateway — never directly with OpenCode, OpenMemory, Admin, or any other service.
- Core containers (Admin, Gateway, OpenCode, OpenMemory) and service containers are host or LAN only (not public).

### Secrets and environment

- The generator finds all secret references in a channel's config and produces a scoped `.env` for that container containing only those secrets sourced from `secrets.env`.

### Compose and Caddy generation

- Core containers have predefined Compose config that is always included in the generated Compose file.
- Channels and services both generate Docker Compose entries. Channels additionally generate Caddyfile entries.
- The Caddyfile always includes rules to reach: Admin, OpenCode web UI, and OpenMemory UI.
- The generator produces a valid `caddy.json` file.
- Adding a channel or service is done by adding a JSON snippet to the spec and running the generator — no other code changes required.

### Plugins

- Adding OpenCode plugins is done by editing `DATA/assistant/.config/opencode/opencode.json`.

## Documentation Structure

Documentation is organized by audience and proximity to code. Start at the top level and drill down.

| Location | What's there | When to read it |
|---|---|---|
| `docs/` | User-facing guides: `cli.md`, `concepts.md`, `security.md`, `maintenance.md`, `troubleshooting.md`, `host-system-reference.md` | Understanding what OpenPalm is; install, CLI usage, security, maintenance |
| `admin/docs/` | Admin and operations: admin-guide, admin-concepts | Setting up and understanding the admin service |
| `dev/docs/` | Developer references: architecture, API reference, testing plan, versioning | Building features, understanding internals, API integration |
| `admin/README.md` | Admin service implementation: installer flow, cron jobs, compose lifecycle, directory layout | Changing or understanding the admin container itself |
| `gateway/README.md` | Gateway service: message pipeline, HMAC verification, channel intake agent | Changing or understanding the gateway container |
| `assistant/README.md` | Assistant service: extension architecture, built-in plugins/skills/tools, SSH access | Changing or understanding the assistant container |
| `channels/<name>/README.md` | Per-channel: endpoints, env vars, setup instructions | Setting up or modifying a specific channel adapter |

**Finding information quickly:**
- *How does a message flow from Discord to the assistant?* → `dev/docs/architecture.md`
- *What admin API endpoints exist?* → `dev/docs/api-reference.md`
- *How do I set up a Discord bot token?* → `channels/discord/README.md`
- *How do I back up or upgrade?* → `docs/maintenance.md`
- *What security controls are in place?* → `docs/security.md`
- *How do I add an extension?* → `assistant/README.md`

## Directory Structure

```
./openpalm
├── admin/          # Admin UI service
├── channels/       # Channel adapters
│   ├── chat/
│   ├── discord/
│   ├── telegram/
│   ├── voice/
│   └── webhook/
├── gateway/       # Main API gateway (entry point)
├── assistant/      # OpenCode extensions
└── assets/        # Templates, scripts, state
```

## Build, Test, and Development Commands

### Running Tests

```bash
# Run all tests across all workspaces
bun test

# Run tests in a specific workspace
cd gateway && bun test
cd admin && bun test
cd channels/discord && bun test

# Run a single test file
bun test gateway/src/channel-intake.test.ts
bun test ./gateway/src/assistant-client.test.ts

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
cd gateway && bun run start

# Admin
cd admin && bun run start
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

```typescript
import { describe, expect, it } from "bun:test";

describe("channel intake", () => {
  it("builds an intake command with strict json instructions", () => {
    const command = buildIntakeCommand({...});
    expect(command).toContain("strict JSON");
  });
});
```

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
