# Complete OpenPalm Testing Workflow

OpenPalm has five ordered test tiers plus a separate production PWA browser
lane. The tier scripts are defined in `scripts/test-tier.sh`.

## Prerequisites

- Run `bun install --frozen-lockfile` after dependency changes.
- Tiers 4 and 5 and the PWA lane require Playwright Chromium. Install it with
  `bun run --cwd packages/ui test:browsers`.
- Tier 5 requires Docker with Compose V2.
- Tier 5 seeds its own isolated home and credentials. It does not require
  `scripts/dev-setup.sh`, Ollama, voice hardware, or external service keys.

## Quick Reference

| Tier | Command | Coverage |
|---|---|---|
| 1 | `bun run test:t1` | Svelte/TypeScript checks for UI and UI kit |
| 2 | `bun run test:t2` | Non-UI Bun suites, including lib, CLI, Guardian, portal SDK/adapters, Electron tools, and scripts |
| 3 | `bun run test:t3` | UI Vitest server and browser-component tests |
| 4 | `bun run test:t4` | Self-contained Playwright browser contracts (`*.pw.ts`) |
| 5 | `bun run test:t5` | Isolated live-stack smoke plus stack Playwright (`*.stack.ts`) |
| PWA | `bun run ui:test:pwa` | Production manifest, installability, standalone mode, persistence, and cache boundaries |

## Tier 1: Type Checking

```bash
bun run test:t1
```

Runs the root `check` script: SvelteKit/Svelte type checking for
`@openpalm/ui` and `@openpalm/ui-kit`.

## Tier 2: Non-UI Tests

```bash
bun run test:t2
```

Runs the isolated root Bun suite. UI Vitest and Playwright files are not part of
this command.

## Tier 3: UI Unit And Component Tests

```bash
bun run test:t3
```

Runs `bun run ui:test:unit`, covering SvelteKit server modules and browser
components with Vitest.

## Tier 4: Self-Contained Browser Tests

```bash
bun run test:t4
```

Runs `bun run ui:test:e2e:mocked`. Playwright builds and serves the UI against a
throwaway setup-complete home, with a fixed login password and admin capability.
It collects `*.pw.ts` and requires no Docker stack.

## PWA Browser Lane

```bash
bun run ui:test:pwa
```

Builds the production adapter-node UI and runs the isolated PWA suite without
Docker. It checks the emitted manifest with Chromium DevTools Protocol, requires
zero installability errors, waits for service-worker control, relaunches the
same profile in Chromium app mode, verifies standalone display and IndexedDB
persistence, and enforces the asset-only cache boundary.

An operating-system browser install-menu check remains manual release evidence;
the automated lane does not pretend to click native browser chrome.

## Tier 5: Isolated Live-Stack Integration

```bash
bun run test:t5
```

Tier 5 delegates directly to:

```bash
./scripts/dev-e2e-test.sh --playwright
```

The script performs the following current contract:

1. Seeds `.dev-e2e/` from the current skeleton and records the current home
   schema.
2. Uses managed compose files under `.dev-e2e/system/stack/`, the user overlay
   `.dev-e2e/config/stack/custom.compose.yml`, and
   `.dev-e2e/state/stack.env`.
3. Seeds delegated service secrets under `.dev-e2e/private/secrets/`; the shared
   OpenCode provider file remains `.dev-e2e/knowledge/secrets/auth.json`.
4. Enables the `api` addon and Compose profile `addon.api`, which includes the
   profile-gated Guardian without Discord, Slack, or cloud credentials.
5. Builds the UI and assistant/Guardian images, then recreates the isolated
   services.
6. Checks assistant, container UI, and API health; verifies disabled Guardian
   direct ingress returns 404; logs in through `/api/auth/login`; checks current
   `/api/host/containers/list` and `/api/host/health` auth behavior.
7. Verifies the assistant has neither the Docker socket nor the delegated
   `private/` secret tree mounted.
8. Runs Playwright with `RUN_DOCKER_STACK_TESTS=1`. The stack configuration
   collects `*.stack.ts` and also reuses the common `auth-flow.pw.ts` contract.

Subsequent runs may reuse existing builds:

```bash
./scripts/dev-e2e-test.sh --skip-build --playwright
```

Tier 5 validates HTTP, UI, auth, compose, and isolation behavior. It does not
send a model-backed chat message, start the voice service, or use real external
credentials. There are no LLM-specific Playwright files.

## Browser Commands

| Command | Environment | Purpose |
|---|---|---|
| `bun run ui:test:e2e:mocked` | No stack | Collect `*.pw.ts` only |
| `bun run ui:test:pwa` | No stack | Production PWA lane |
| `bun run ui:test:stack` | Existing seeded `.dev` stack | Collect stack integration tests |
| `bun run ui:test:e2e` | Existing seeded `.dev` stack | Stack integration with no-skip enforcement |
| `./scripts/dev-e2e-test.sh --playwright` | Self-managed `.dev-e2e` stack | Canonical clean isolated run |

Use the root scripts rather than invoking a different Playwright installation;
they select the repository's configured version and environment.

## Development And Test Ports

| Surface | Port |
|---|---|
| Direct UI Vite development (`bun run ui:dev` or package `npm run dev`) | `5173` |
| Root isolated UI development (`bun run ui:dev:isolated`) | `3880` |
| Tier 5 host admin | `3890` |
| Tier 5 assistant OpenCode | `3891` |
| Tier 5 assistant-container UI | `3892` |
| Tier 5 Guardian direct/admin | `3893` / `3894` |
| Tier 5 API edge / inactive chat reservation | `3895` / `3896` |

## Manual Playwright Files

`packages/ui/e2e/navbar-visual.manual.ts` is the only current manual Playwright
file. It is intentionally outside both automated `testMatch` patterns. The old
voice, scheduler, and AKM-config manual files were removed because they were
stale and were never collected by the automated suite.

## Recommended Workflow

```bash
# Fast checks
bun run test:t1
bun run test:t2
bun run test:t3

# Browser contracts
bun run test:t4

# Stack or release changes
bun run test:t5

# PWA/service-worker changes and release candidates
bun run ui:test:pwa
```
