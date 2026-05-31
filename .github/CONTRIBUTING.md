# Contributing to OpenPalm

Quick-start cheatsheet for getting a dev environment running and submitting changes.

Repo layout convention:
- `packages/*` = app/package source workspaces
- `core/*` = container/runtime assembly assets and image build contexts

## Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| [Docker](https://docs.docker.com/get-docker/) | 24+ (Compose V2) | Runs the full stack |
| [Bun](https://bun.sh/) | 1.1+ | Workspace manager, guardian/channel runtime, test runner |
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
bun run guardian:dev     # core/guardian server
bun run guardian:test    # guardian tests
bun run sdk:test         # packages/channels-sdk tests
bun run cli:test         # packages/cli tests
bun run channel:api:dev     # api channel dev server (also serves the chat addon when CHANNEL_ID=chat)
bun run channel:discord:dev # discord channel dev server
bun run dev:setup        # seed .dev/ dirs and configs
bun run dev:stack        # start dev stack (pull images)
bun run dev:build        # start dev stack (build from source)
bun run test             # all non-UI tests (sdk, guardian, channels, cli)
bun run check            # ui:check + sdk:test
```

`dev:stack` pulls pre-built images from the configured container registries — use it for quick starts and testing admin apply flows. `dev:build` compiles all images from local source using `compose.dev.yml` — use it when developing services or testing Dockerfile changes.

`dev-setup.sh --seed-env` seeds `.dev/knowledge/vaults/user.env` and `.dev/config/stack/stack.env` and sets the `OP_*_HOME` variables to absolute `.dev/` paths. The UI dev server picks these up automatically — no additional environment setup needed.

## 1. Clone and bootstrap

```bash
git clone https://github.com/itlackey/openpalm.git
cd openpalm
bun install            # Installs all workspace dependencies
bun run dev:setup      # Creates .dev/ dirs, seeds vault env files
```

`dev:setup` runs [`scripts/dev-setup.sh --seed-env`](../scripts/dev-setup.sh), which:

- Creates the `.dev/config`, `.dev/knowledge`, `.dev/state`, and `.dev/logs` directories
- Seeds `.dev/knowledge/vaults/user.env` and `.dev/config/stack/stack.env` with dev-safe defaults

After setup, edit `.dev/knowledge/vaults/user.env` to add your LLM provider keys.

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

Both scripts read env files from `.dev/config/stack/` and `.dev/knowledge/vaults/`.

## 4. Run tests and checks

```bash
# Type check the UI
bun run ui:check

# Non-UI tests (sdk, guardian, channels, cli)
bun run test

# Both of the above
bun run check

# Individual test suites
bun run guardian:test        # Guardian security tests
bun run sdk:test             # Channels SDK unit tests
bun run cli:test             # CLI tests
bun run ui:test:unit      # UI Vitest (unit + browser components)
bun run ui:test:e2e       # UI Playwright integration tests (no-skip enforced locally)
bun run ui:test:e2e:mocked # UI Playwright mocked browser contract tests
```

> UI uses Vitest and Playwright, not Bun's test runner. Use `bun run test` (not bare `bun test`) from the repo root — the script filters to non-UI directories.

## 5. Run individual services

```bash
bun run ui:dev         # UI SvelteKit dev server (:8100)
bun run guardian:dev         # Guardian Bun server
bun run channel:api:dev      # API channel (CHANNEL_ID=chat reuses this image to serve the chat addon)
bun run channel:discord:dev  # Discord channel
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
| `bun run ui:test:e2e:mocked` | Playwright mocked browser contracts |
| `bun run guardian:dev` | Guardian server |
| `bun run guardian:test` | Guardian tests |
| `bun run sdk:test` | Channels SDK tests |
| `bun run channel:api:dev` | API channel dev server (also serves chat addon via `CHANNEL_ID=chat`) |
| `bun run channel:discord:dev` | Discord channel dev server |
| `bun run cli:test` | CLI tests |
| `bun run dev:setup` | Seed `.dev/` dirs and configs |
| `bun run dev:stack` | Start dev stack (pull images) |
| `bun run dev:build` | Start dev stack (build from source) |
| `bun run test` | All non-UI tests |
| `bun run check` | ui:check + sdk:test |

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

3. **Docker builds** — Guardian and channel Dockerfiles must install `packages/channels-sdk` deps with `bun install --production` after copying sdk source (no symlink-based node_modules). UI is a host binary — no Docker build. The assistant **and guardian** images ship the OpenCode binary; keep `OPENCODE_VERSION` in lockstep between `core/assistant/Dockerfile` and `core/guardian/Dockerfile`.
4. **No secrets** in client bundles or logs.
5. **No new dependencies** that duplicate a built-in Bun or platform capability.

## npm Package Releases

OpenPalm publishes npm packages on an independent release cycle from Docker images and the platform. Each publishable package (`packages/channels-sdk`, `packages/assistant-tools`, `packages/channel-*`) has its own GitHub Actions workflow that publishes to npm when its version field changes on `main`. Platform packages (`packages/ui`, `core/guardian`, `packages/cli`) share a coordinated version managed by `scripts/release.sh`.

## Key docs for contributors

| Document | What you'll find |
|----------|-----------------|
| [docs/technical/core-principles.md](../docs/technical/core-principles.md) | **Must-read.** Security invariants, filesystem contract, architectural rules |
| [docs/technical/code-quality-principles.md](../docs/technical/code-quality-principles.md) | TypeScript strictness, module design, error handling |
| [docs/technical/api-spec.md](../docs/technical/api-spec.md) | API endpoint contract |
| [docs/technical/bunjs-rules.md](../docs/technical/bunjs-rules.md) | Bun-specific patterns (guardian, channels, SDK) |
| [docs/technical/sveltekit-rules.md](../docs/technical/sveltekit-rules.md) | SvelteKit patterns (UI) |
| [docs/community-channels.md](../docs/community-channels.md) | BaseChannel SDK for building custom channel adapters |
| [docs/technical/environment-and-mounts.md](../docs/technical/environment-and-mounts.md) | All environment variables and volume mounts |
