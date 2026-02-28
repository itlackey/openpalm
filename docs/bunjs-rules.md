## BunJS implementation rules

This document defines Bun-specific implementation rules for OpenPalm's **Bun
services only**: `core/guardian/`, `channels/*`, `packages/lib/`, and any
Bun-based utilities. It does **not** apply to the admin service (`core/admin/`),
which is a SvelteKit/Node.js app and follows Node.js and SvelteKit conventions
(see `docs/sveltekit-rules.md`).

It complements `docs/core-principles.md` and `docs/code-quality-principles.md`.

### 1) Core Bun design rules

1. Prefer Bun and Web Platform built-ins before adding third-party runtime dependencies.
2. Keep server entrypoints thin: parse request, validate/auth, call domain logic, return structured response.
3. Fail closed on auth/signature/timestamp errors and return explicit HTTP status codes.
4. Keep side effects explicit and isolated (disk writes, shell-outs, network calls).
5. Use strict TypeScript with `unknown` at untrusted boundaries and narrow before use.

### 2) Dependency policy

Before adding any dependency, confirm there is no Bun or platform-native API that already solves the problem.
New dependencies must be justified by a concrete gap (capability, compatibility, or maintenance).

### 3) Built-in APIs to use first (before adding dependencies)

#### A) HTTP server and routing

* `Bun.serve(...)` for HTTP service entrypoints and request handling.
* Web standard `Request`, `Response`, `Headers`, `URL`, and `URLPattern` for transport concerns.
* Built-in upgrade flow in `Bun.serve` for WebSockets when needed.

Use these instead of adding Express/Fastify/Koa-style frameworks unless there is a demonstrated requirement.

#### B) HTTP client, JSON, and payload handling

* `fetch(...)` for outbound HTTP calls.
* `JSON.parse(...)` / `JSON.stringify(...)` for JSON serialization.
* `Request.json()`, `Request.text()`, and `Request.formData()` for request payload parsing.

Use these before adding axios/superagent/request-style client dependencies or extra JSON utility packages.

#### C) YAML and config parsing

* `Bun.YAML.parse(...)` and `Bun.YAML.stringify(...)` for YAML read/write operations.

Use this before adding separate YAML parser/stringifier dependencies when basic YAML support is sufficient.

#### D) Filesystem and streams

* `Bun.file(path)` for efficient file reads.
* `Bun.write(path, data)` for file writes.
* Web Streams APIs (`ReadableStream`, `WritableStream`, `TransformStream`) for stream transforms.

Use these before adding fs wrapper libraries for common read/write/streaming operations.

#### E) Globbing and path discovery

* `new Bun.Glob(pattern)` for file matching and directory traversal patterns.

Use this before adding globbing dependencies for straightforward file discovery.

#### F) Process and shell execution

* `Bun.spawn(...)` for subprocess control.
* `Bun.$\`...\`` for concise shell scripting in trusted/internal tooling.

Use these before adding execa/shelljs-like wrappers unless advanced behavior is required.

#### G) Cryptography and security primitives

* Web Crypto (`crypto.subtle`, `crypto.getRandomValues`, `crypto.randomUUID`).
* `Bun.password.hash(...)` / `Bun.password.verify(...)` for password hashing flows.

Use these before adding crypto helper packages for hashing, random IDs, or password verification.

#### H) SQLite and persistence utilities

* `bun:sqlite` (`Database`) for local SQLite-backed metadata/utility storage.

Use this before introducing ORM/query-builder dependencies for simple local persistence needs.

#### I) Testing and mocks

* `bun:test` (`test`, `describe`, `expect`, `mock`, lifecycle hooks) for unit/integration tests.

Use this before adding parallel test frameworks unless a missing feature is proven.

### 4) Structured logging

All Bun services must use `createLogger` from `packages/lib/src/shared/logger.ts`
for structured JSON output. Do not use bare `console.log` for operational events.

```typescript
import { createLogger } from "@openpalm/lib/shared/logger.js";
const logger = createLogger("guardian"); // or "channel-chat", etc.

logger.info("Request accepted", { requestId, actor });
logger.warn("Replay detected", { requestId });
logger.error("Signature invalid", { requestId, reason });
```

Each log entry is a JSON object with fields: `ts`, `level`, `service`, `msg`,
and an optional `extra` bag for structured context. `error` and `warn` entries
go to `stderr`; `info` and `debug` go to `stdout`.

### 5) Bun service checklist

* `bun test` passes for changed Bun modules.
* Security-sensitive branches (auth, replay/rate checks, malformed input) are covered.
* No new dependency duplicates built-in Bun/platform capabilities listed above.
* All operational log events use `createLogger` (not bare `console.log`).
* Errors and logs are structured and include request identifiers where available.
* No behavior violates `docs/core-principles.md` security and architecture constraints.
