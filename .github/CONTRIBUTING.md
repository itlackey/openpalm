# Contributing to OpenPalm

Quick reference for local development, testing, and release-sensitive changes.

Repository layout:

- `packages/*`: application and package workspaces
- `containers/*`: image assembly and container entrypoints
- `packages/portal-*`: first-party protocol adapters

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| [Docker](https://docs.docker.com/get-docker/) | 24+ with Compose V2 | Live stack and Tier 5 |
| [Bun](https://bun.sh/) | 1.1+ | Workspace install, scripts, services, and tests |
| [Node.js](https://nodejs.org/) | 22+ | SvelteKit/Vite and packaging tooling |

## Quick Start

For the repository-isolated UI and API on port `3880`:

```bash
bun install
bun run dev:setup
bun run ui:dev:isolated
```

`ui:dev:isolated` sets `OP_HOME=$PWD/.dev` and starts at
`http://localhost:3880`.

For direct Vite development on its standard port `5173`:

```bash
bun run ui:dev

# Equivalent package command
cd packages/ui && npm run dev
```

Direct development does not force the isolated root command's port or
`OP_HOME`; choose the command that matches the surface being tested.

## Development Home

Seed the current development layout with:

```bash
bun run dev:setup
```

Important paths are:

```text
.dev/
|-- system/stack/                 managed core/services/portals compose files
|-- config/stack/custom.compose.yml
|                                  user-owned compose overlay
|-- state/stack.env               non-secret runtime record and enabled addons
|-- private/secrets/              delegated Guardian/portal/admin secret files
|-- knowledge/secrets/auth.json   shared OpenCode provider-auth exception
|-- knowledge/env/user.env        user-managed AKM env data
|-- data/                          service data, logs, backups, and rollback
`-- workspace/                     shared assistant work area
```

Do not put delegated service credentials in `knowledge/secrets/`: that tree is
assistant-reachable through `/stash`. Delegated secrets belong in
`private/secrets/`; `knowledge/secrets/auth.json` is the deliberate shared
provider-auth exception. Compose configuration comes from `state/stack.env`,
not `knowledge/env/user.env`.

## Full Development Stack

```bash
# Pull configured images
bun run dev:stack

# Build service images from the current source tree
bun run dev:build
```

Both commands assemble:

- `.dev/system/stack/core.compose.yml`
- `.dev/system/stack/services.compose.yml`
- `.dev/system/stack/portals.compose.yml`
- `.dev/config/stack/custom.compose.yml`
- `.dev/state/stack.env` as Compose's `--env-file`

`dev:build` additionally applies `compose.dev.yml`. Use it for Dockerfile,
Guardian, assistant, or portal changes; use `dev:stack` for quicker host-control
plane work against pulled images.

## Common Development Commands

```bash
bun run ui:dev                 # Direct UI dev server on :5173
bun run ui:dev:isolated        # Root isolated UI/API on :3880
bun run ui:build               # Production UI build
bun run ui:check               # UI Svelte/TypeScript checks
bun run guardian:dev           # Guardian Bun server
bun run guardian:api:dev       # Guardian OpenAI-compatible edge
bun run portal:discord:dev     # Discord adapter
bun run portal:slack:dev       # Slack adapter
bun run dev:setup              # Seed .dev/
bun run dev:stack              # Pull and start the dev stack
bun run dev:build              # Build and start the dev stack
```

## Test Tiers

OpenPalm has five test tiers. Run the smallest relevant set while iterating and
the complete set for release-sensitive changes.

| Tier | Command | Scope |
|---|---|---|
| 1 | `bun run test:t1` | UI type checks |
| 2 | `bun run test:t2` | Non-UI Bun tests |
| 3 | `bun run test:t3` | UI Vitest unit/component tests |
| 4 | `bun run test:t4` | Self-contained Playwright browser tests |
| 5 | `bun run test:t5` | Isolated current-layout Docker stack plus Playwright |

Additional browser lanes remain available:

```bash
bun run ui:test:e2e:mocked     # Tier 4 directly
bun run ui:test:pwa            # Production PWA/CDP checks, no stack
bun run ui:test:stack          # Stack tests against an existing seeded .dev stack
bun run ui:test:e2e            # Existing-stack Playwright with no-skip enforcement
```

Install the repository's Chromium build with:

```bash
bun run --cwd packages/ui test:browsers
```

Tier 5 delegates to `scripts/dev-e2e-test.sh --playwright`; it owns an isolated
`.dev-e2e` stack, enables the API profile so Guardian runs, checks current host
API/isolation boundaries, and runs `*.stack.ts`. It does not require model
inference, voice, or real external credentials.

See [Testing Workflow](../docs/technical/testing-workflow.md) and the
[UI E2E README](../packages/ui/e2e/README.md).

## Before Submitting A PR

1. Read [Core Principles](../docs/technical/core-principles.md), the authoritative
   architecture, security, and filesystem contract.
2. Run the relevant test tiers and `bun run lint`.
3. Run `bun run guardian:test` for Guardian security changes.
4. Run Tier 5 for compose, filesystem, auth-boundary, or live UI changes.
5. Run `bun run ui:test:pwa` for manifest, service-worker, cache, or PWA changes.
6. Confirm no secret value can enter client bundles, logs, `state/stack.env`, or
   broad container environment variables.
7. Prefer Bun/Web Platform capabilities over new dependencies.

Guardian and portal Dockerfiles must install their runtime dependencies inside
the image. The Assistant and Guardian OpenCode pins are the exact `opencode-ai`
dependencies in `containers/assistant/tools/package.json` and
`containers/guardian/tools/package.json`; keep them in lockstep. There is no
standalone UI image; the Assistant image bakes the candidate-local compiled UI,
while the CLI and Electron app each embed their own compiled UI and skeleton
at build time.

## Release Packaging

All supported releases use `.github/workflows/release.yml`; see
[Release Management](../docs/operations/release-management.md).

The product release publishes one npm convenience package:

- `openpalm`

The independent extension workflow may publish:

- `@openpalm/guardian`
- `@openpalm/portal-sdk`
- `@openpalm/discord-portal`
- `@openpalm/slack-portal`

`@openpalm/ui`, `@openpalm/skeleton`, and `@openpalm/lib` are private platform
workspaces. Portal SDK, Discord, and Slack move together in the extension unit.
Source dependencies using `"workspace:*"` are intentional; `bun pm pack`
resolves them only when assembling an image or a package that remains public.

Voice releases independently through `.github/workflows/publish-voice.yml`.

## Key Documentation

| Document | Scope |
|---|---|
| [Core Principles](../docs/technical/core-principles.md) | Security invariants, architecture, and filesystem contract |
| [Code Quality Principles](../docs/technical/code-quality-principles.md) | Engineering invariants and TypeScript quality |
| [Bun Rules](../docs/technical/bunjs-rules.md) | Bun/platform API preferences |
| [SvelteKit Rules](../docs/technical/sveltekit-rules.md) | Server/client boundaries and routing |
| [API Conventions](../docs/technical/api-spec.md) | Admin API security and route conventions |
| [Release Architecture](../docs/technical/release-architecture.md) | Candidate source and artifact DAG |
