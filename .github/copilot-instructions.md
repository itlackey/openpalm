# OpenPalm — AI Agent Instructions

## What this is

Self-hosted multi-channel AI assistant platform. Channels (Discord, Telegram, Voice, Chat, Webhook) send HMAC-signed messages → Caddy → Gateway → OpenCode agent → OpenMemory. All services are Docker containers orchestrated by Docker Compose.

**Core principle**: Simplicity above all. If a solution is complex, it's wrong.

## Architecture (non-obvious)

```
Channel adapters → Gateway (HMAC verify → rate limit → intake agent → forward) → Assistant/OpenCode → OpenMemory
                                                                                                          ↑
Admin (control plane, not in request path) ────────────────────────────────────────────────────────────┘
```

- **Channels never talk to anything except the Gateway** — enforced at the network level.
- The Gateway embeds a `channel-intake` OpenCode agent (`gateway/opencode/`) with all tools denied (`"*": false`). It validates/summarizes untrusted input before forwarding to the full agent. Extensions are baked into the image — no host volume.
- **Admin** manages Docker Compose lifecycle and config generation. It is not in the message path.
- `packages/lib` has three zones: `src/` (CLI/host), `src/shared/` (gateway+channels), `admin/` (admin service only). Never barrel-import `@openpalm/lib` in services — use zone-specific paths.

## Monorepo layout

Bun workspaces: `gateway`, `admin`, `channels/{chat,discord,voice,telegram,webhook}`, `packages/lib`, `packages/cli`, `packages/ui` (SvelteKit, replacing `admin/ui/`).

```
packages/lib/src/embedded/state/docker-compose.yml   — production compose base
dev/docker-compose.dev.yml        — dev overlay (local builds)
.dev/config/                      — secrets.env, caddy, opencode.jsonc  (OPENPALM_CONFIG_HOME)
.dev/data/                        — postgres, qdrant, assistant home      (OPENPALM_DATA_HOME)
.dev/state/                       — rendered artifacts, runtime state     (OPENPALM_STATE_HOME)
```

`--project-directory .` is required for compose commands so paths resolve from repo root.

## Dev commands

```bash
bun run dev:setup       # Create .env + seed .dev/
bun run dev:build       # Build images + start stack
bun run dev:up          # Start without rebuild
bun run dev:fresh       # Full clean rebuild
bun run dev:logs        # Tail all logs (-- <service> to filter)
bun run typecheck       # Type-check all workspaces
bun test                # All tests (unit + integration + contract + security)
bun run test:ui         # Playwright E2E (admin UI)
bun run test:workflows  # GitHub Actions workflows via act
```

Reset the admin setup wizard: `rm .dev/data/admin/setup-state.json`

## Import conventions

```ts
// Gateway and channels — shared zone only
import { buildChannelMessage, forwardChannelMessage } from "@openpalm/lib/shared/channel-sdk.ts";
import { json } from "@openpalm/lib/shared/http.ts";
import { signPayload, verifySignature } from "@openpalm/lib/shared/crypto.ts";

// Admin service — admin zone only
import { StackGenerator } from "@openpalm/lib/admin/stack-generator.ts";

// CLI — barrel or direct src/ imports
import { resolveXDGPaths, composeUp } from "@openpalm/lib";
```

Always use `.ts` extension in relative imports.

## Code conventions

- **Bun runtime**, ES modules (`"type": "module"`), TypeScript strict mode, ES2022 target.
- `Bun.env.VAR ?? "default"` — never `process.env`.
- Error codes are snake_case strings thrown as `Error`: `throw new Error("missing_summary_for_valid_intake")`.
- Catch clauses use `unknown`, narrowed with type guards.
- Tests use `bun:test` (`describe` / `it` / `expect`). No jest, no vitest.
- File names: kebab-case. Types/classes: PascalCase. Functions: camelCase.
- No linter/formatter configured — match existing style.

## Adding things

- **New channel**: add a channel entry to `packages/lib/assets/templates/openpalm.yaml`, run generator — no code changes needed.
- **New OpenCode extension**: edit `DATA/assistant/.config/opencode/opencode.json` (plugins) or drop files in `assistant/extensions/`.
- **Gateway intake changes**: edit `gateway/opencode/agents/channel-intake.md` or `gateway/opencode/skills/channel-intake/SKILL.md`.

## Key reference files

| Need to understand… | Read… |
|---|---|
| Full message flow | `dev/docs/architecture.md` |
| All API endpoints | `dev/docs/api-reference.md` |
| Stack spec format | `packages/lib/docs/specification.md` |
| Security model | `docs/security.md` |
| Admin control plane | `admin/README.md` |
| Gateway pipeline | `gateway/README.md` |
| `@openpalm/lib` zones | `packages/lib/README.md` |
