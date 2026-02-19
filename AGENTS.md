# OpenPalm Agent Guidelines

## Project Overview

OpenPalm is a multi-channel AI agent gateway with a microservices architecture. It connects various communication channels (Discord, Telegram, Voice, Chat, Webhook) to an OpenCode agent runtime.

## Directory Structure

```
/home/founder3/code/github/itlackey/openpalm
├── admin/              # Admin UI service
├── controller/        # Docker compose controller
├── gateway/           # Main API gateway (entry point)
├── channels/          # Channel adapters
│   ├── chat/
│   ├── discord/
│   ├── telegram/
│   ├── voice/
│   └── webhook/
├── opencode/          # OpenCode extensions and skills
└── assets/            # Config templates, scripts, state
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
bun test ./gateway/src/opencode-client.test.ts

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

# Controller
cd controller && bun run start
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

- **Files**: camelCase (e.g., `channel-intake.ts`, `opencode-client.ts`)
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

- Service names must be in the ALLOWED set in controller
- Allowed services: `opencode-core`, `gateway`, `openmemory`, `admin`, `channel-chat`, `channel-discord`, `channel-voice`, `channel-telegram`, `caddy`
