# Contributing to OpenPalm

Quick-start cheatsheet for getting a dev environment running and submitting changes.

Repo layout convention:
- `packages/*` = app/package source workspaces
- `containers/*` = container/runtime assembly assets and image build contexts

## Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| [Docker](https://docs.docker.com/get-docker/) | 24+ (Compose V2) | Runs the full stack |
| [Bun](https://bun.sh/) | 1.1+ | Workspace manager, guardian/portal runtime, test runner |
| [Node](https://nodejs.org/) | 22+ | Admin (SvelteKit) build and dev server |

## Quick Start

```bash
./scripts/dev-setup.sh --seed-env

cd packages/ui
npm install
npm run dev
```

Admin UI + API runs on `http://localhost:8100`.

From the repo root, convenience scripts are available:

```bash
bun run ui:dev     # packages/ui dev server
bun run ui:check   # svelte-check + TypeScript
bun run guardian:dev     # containers/guardian server
bun run guardian:test    # guardian tests
bun run cli:test         # packages/cli tests
bun run guardian:api:dev    # guardian OpenAI-compatible API server (also serves the chat addon profile)
bun run portal:discord:dev # discord portal dev server
bun run dev:setup        # seed .dev/ dirs and configs
bun run dev:stack        # start dev stack (pull images)
bun run dev:build        # start dev stack (build from source)
bun run test             # all non-UI tests (guardian, portals, cli)
bun run check            # ui:check
```

`dev:stack` pulls pre-built images from the configured container registries — use it for quick starts and testing admin apply flows. `dev:build` compiles all images from local source using `compose.dev.yml` — use it when developing services or testing Dockerfile changes.

`dev-setup.sh --seed-env` seeds `.dev/knowledge/env/user.env` and `.dev/knowledge/env/stack.env` and sets the `OP_*_HOME` variables to absolute `.dev/` paths. The UI dev server picks these up automatically — no additional environment setup needed.

## 1. Clone and bootstrap

```bash
git clone https://github.com/itlackey/openpalm.git
cd openpalm
bun install            # Installs all workspace dependencies
bun run dev:setup      # Creates .dev/ dirs, seeds vault env files
```

`dev:setup` runs [`scripts/dev-setup.sh --seed-env`](../scripts/dev-setup.sh), which:

- Creates the `.dev/config`, `.dev/knowledge`, `.dev/state`, and `.dev/logs` directories
- Seeds `.dev/knowledge/env/user.env` and `.dev/knowledge/env/stack.env` with dev-safe defaults

After setup, edit `.dev/knowledge/env/user.env` to add your LLM provider keys.

## 2. Run the UI (no Docker needed)

```bash
cd packages/ui && npm install && npm run dev
```

UI + API starts on `http://localhost:8100`. The dev server reads `.env` and the seeded `.dev/` paths automatically.

## 3. Start the full stack

Two options depending on what you're working on:

| Script | What it does |
|--------|--------------|
| `bun run dev:stack` | Pulls pre-built images from the configured container registries. Fast start for testing admin workflows. |
| `bun run dev:build` | Builds all images from local source via [`compose.dev.yml`](../compose.dev.yml). Use when developing services or testing Dockerfile changes. |

Both scripts read env files from `.dev/config/stack/` and `.dev/knowledge/env/`.

## 4. Run tests and checks

```bash
# Type check the UI
bun run ui:check

# Non-UI tests (guardian, portals, cli)
bun run test

# Both of the above
bun run check

# Individual test suites
bun run guardian:test        # Guardian security tests
bun run cli:test             # CLI tests
bun run ui:test:unit      # UI Vitest (unit + browser components)
bun run ui:test:e2e       # UI Playwright integration tests (no-skip enforced locally)
```

> UI uses Vitest and Playwright, not Bun's test runner. Use `bun run test` (not bare `bun test`) from the repo root — the script filters to non-UI directories.

## 5. Run individual services

```bash
bun run ui:dev         # UI SvelteKit dev server (:8100)
bun run guardian:dev         # Guardian Bun server
bun run guardian:api:dev     # Guardian-hosted OpenAI-compatible API service
bun run portal:discord:dev  # Discord portal
```

## Convenience scripts (full list)

All scripts are defined in the root [`package.json`](../package.json):

| Script | Description |
|--------|-------------|
| `bun run ui:dev` | UI dev server (packages/ui) |
| `bun run ui:build` | UI production build |
| `bun run ui:check` | svelte-check + TypeScript |
| `bun run ui:test` | Vitest + Playwright (requires build) |
| `bun run ui:test:unit` | Vitest only (CI-friendly) |
| `bun run ui:test:e2e` | Playwright integration only (no browser route mocks) |
| `bun run guardian:dev` | Guardian server |
| `bun run guardian:test` | Guardian tests |
| `bun run guardian:api:dev` | Guardian-hosted OpenAI-compatible API service |
| `bun run portal:discord:dev` | Discord portal dev server |
| `bun run cli:test` | CLI tests |
| `bun run dev:setup` | Seed `.dev/` dirs and configs |
| `bun run dev:stack` | Start dev stack (pull images) |
| `bun run dev:build` | Start dev stack (build from source) |
| `bun run test` | All non-UI tests |
| `bun run check` | ui:check |

## Dev directory layout

Dev mode mirrors the production [filesystem contract](../docs/technical/foundations.md) under `.dev/`:

```
.dev/
├── config/          # User-editable, non-secret configuration
├── knowledge/           # AKM knowledge (skills, vaults, agents)
├── state/           # Service-managed persistent data
└── logs/            # Consolidated audit/debug output
```

See [docs/technical/foundations.md](../docs/technical/foundations.md) for the full filesystem contract.

## Before submitting a PR

1. **Read the rules.** [docs/technical/core-principles.md](../docs/technical/core-principles.md) is the authoritative source for architectural and security invariants. All changes must comply.
2. **Run the delivery checklist:**

   ```bash
   bun run check                   # Type check + SDK tests
   bun run guardian:test            # Guardian security tests
   ```

3. **Docker builds** — Guardian and portal Dockerfiles must install each service's own deps directly (no symlink-based node_modules). UI is a host binary — no Docker build. The assistant and guardian images ship the OpenCode binary; keep `OPENCODE_VERSION` in lockstep between `containers/assistant/Dockerfile` and `containers/guardian/Dockerfile`.
4. **No secrets** in client bundles or logs.
5. **No new dependencies** that duplicate a built-in Bun or platform capability.

## npm Package Releases

OpenPalm has two release tracks (see [docs/operations/release-management.md](../docs/operations/release-management.md) for the full guide):

- **Platform release (single coordinated version)** — guardian, portal image, baked portal adapters, CLI binaries, Electron installers, and other platform manifests ship together through `.github/workflows/platform-release.yml`.
- **UI release (independent npm)** — `packages/ui` remains independently published to npm.

## Key docs for contributors

| Document | What you'll find |
|----------|-----------------|
| [docs/technical/core-principles.md](../docs/technical/core-principles.md) | **Must-read.** Security invariants, filesystem contract, architectural rules |
| [docs/technical/code-quality-principles.md](../docs/technical/code-quality-principles.md) | TypeScript strictness, module design, error handling |
| [docs/technical/api-spec.md](../docs/technical/api-spec.md) | API endpoint contract |
| [docs/technical/bunjs-rules.md](../docs/technical/bunjs-rules.md) | Bun-specific patterns (guardian, channels, SDK) |
| [docs/technical/sveltekit-rules.md](../docs/technical/sveltekit-rules.md) | SvelteKit patterns (UI) |
| [docs/channels/community-channels.md](../docs/channels/community-channels.md) | Community portal adapter notes |
| [docs/technical/environment-and-mounts.md](../docs/technical/environment-and-mounts.md) | All environment variables and volume mounts |
