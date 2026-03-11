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

cd packages/admin
bun install
bun run dev
```

Admin UI + API runs on `http://localhost:8100`.

From the repo root, convenience scripts are available:

```bash
bun run admin:dev        # packages/admin dev server
bun run admin:check      # svelte-check + TypeScript
bun run guardian:dev     # core/guardian server
bun run guardian:test    # guardian tests
bun run sdk:test         # packages/channels-sdk tests
bun run cli:test         # packages/cli tests
bun run channel:chat:dev    # chat channel dev server
bun run channel:api:dev     # api channel dev server
bun run channel:discord:dev # discord channel dev server
bun run dev:setup        # seed .dev/ dirs and configs
bun run dev:stack        # start dev stack (pull images)
bun run dev:build        # start dev stack (build from source)
bun run test             # all non-admin tests (sdk, guardian, channels, cli)
bun run check            # admin:check + sdk:test
```

`dev:stack` pulls pre-built images from the registry — use it for quick starts and testing admin apply flows. `dev:build` compiles all images from local source using `compose.dev.yaml` — use it when developing services or testing Dockerfile changes.

`dev-setup.sh --seed-env` seeds `.dev/config/secrets.env` from `assets/secrets.env` and sets the `OPENPALM_*_HOME` variables to absolute `.dev/` paths. The UI dev server picks these up automatically — no additional environment setup needed.

## 1. Clone and bootstrap

```bash
git clone https://github.com/itlackey/openpalm.git
cd openpalm
bun install            # Installs all workspace dependencies
bun run dev:setup      # Creates .dev/ dirs, seeds secrets.env and stack.env
```

`dev:setup` runs [`scripts/dev-setup.sh --seed-env`](scripts/dev-setup.sh), which:

- Creates the `.dev/config`, `.dev/data`, and `.dev/state` directories
- Seeds `.dev/config/secrets.env` from [`assets/secrets.env`](assets/secrets.env)
- Generates `.dev/state/artifacts/stack.env` with auto-detected host values

After setup, edit `.dev/config/secrets.env` to add your `ADMIN_TOKEN` and any LLM provider keys.

## 2. Run the admin UI (no Docker needed)

```bash
cd packages/admin && npm install && npm run dev
```

Admin UI + API starts on `http://localhost:8100`. The dev server reads `.env` (copy from [`.env.example`](.env.example)) and the seeded `.dev/` paths automatically.

## 3. Start the full stack

Two options depending on what you're working on:

| Script | What it does |
|--------|--------------|
| `bun run dev:stack` | Pulls pre-built images from the registry. Fast start for testing admin workflows. |
| `bun run dev:build` | Builds all images from local source via [`compose.dev.yaml`](compose.dev.yaml). Use when developing services or testing Dockerfile changes. |

Both scripts read env files from `.dev/state/artifacts/`.

## 4. Run tests and checks

```bash
# Type check the admin UI
bun run admin:check

# Validate setup wizard scope docs stay aligned
bun run docs:check:wizard-scope

# Non-admin tests (sdk, guardian, channels, cli)
bun run test

# Both of the above
bun run check

# Individual test suites
bun run guardian:test        # Guardian security tests
bun run sdk:test             # Channels SDK unit tests
bun run cli:test             # CLI tests
bun run admin:test:unit      # Admin Vitest (unit + browser components)
bun run admin:test:e2e       # Admin Playwright integration tests (no-skip enforced locally)
bun run admin:test:e2e:mocked # Admin Playwright mocked browser contract tests
```

> Admin uses Vitest and Playwright, not Bun's test runner. Use `bun run test` (not bare `bun test`) from the repo root — the script filters to non-admin directories.

## 5. Run individual services

```bash
bun run admin:dev            # Admin SvelteKit dev server (:8100)
bun run guardian:dev         # Guardian Bun server
bun run channel:chat:dev     # Chat channel
bun run channel:api:dev      # API channel
bun run channel:discord:dev  # Discord channel
```

## Convenience scripts (full list)

All scripts are defined in the root [`package.json`](package.json):

| Script | Description |
|--------|-------------|
| `bun run admin:dev` | Admin dev server (packages/admin) |
| `bun run admin:build` | Admin production build |
| `bun run admin:check` | svelte-check + TypeScript |
| `bun run admin:test` | Vitest + Playwright (requires build) |
| `bun run admin:test:unit` | Vitest only (CI-friendly) |
| `bun run admin:test:e2e` | Playwright integration only (no browser route mocks) |
| `bun run admin:test:e2e:mocked` | Playwright mocked browser contracts |
| `bun run guardian:dev` | Guardian server |
| `bun run guardian:test` | Guardian tests |
| `bun run sdk:test` | Channels SDK tests |
| `bun run channel:chat:dev` | Chat channel dev server |
| `bun run channel:api:dev` | API channel dev server |
| `bun run channel:discord:dev` | Discord channel dev server |
| `bun run cli:test` | CLI tests |
| `bun run dev:setup` | Seed `.dev/` dirs and configs |
| `bun run dev:stack` | Start dev stack (pull images) |
| `bun run dev:build` | Start dev stack (build from source) |
| `bun run docs:check:wizard-scope` | Validate wizard scope/copy docs consistency |
| `bun run test` | All non-admin tests |
| `bun run check` | admin:check + sdk:test |

## Dev directory layout

Dev mode mirrors the production [XDG three-tier layout](docs/technical/directory-structure.md) under `.dev/`:

```
.dev/
├── config/          # CONFIG_HOME — secrets.env, channels/, assistant/
├── data/            # DATA_HOME  — memory, assistant, guardian data
└── state/           # STATE_HOME — assembled runtime artifacts
    └── artifacts/   # stack.env, secrets.env, docker-compose.yml
```

See [docs/technical/directory-structure.md](docs/technical/directory-structure.md) for the full tree.

## Before submitting a PR

1. **Read the rules.** [docs/technical/core-principles.md](docs/technical/core-principles.md) is the authoritative source for architectural and security invariants. All changes must comply.
2. **Run the delivery checklist:**

   ```bash
   bun run check                   # Type check + SDK tests
   bun run guardian:test            # Guardian security tests
   ```

3. **Docker builds** must follow the patterns in [docs/technical/docker-dependency-resolution.md](docs/technical/docker-dependency-resolution.md) (no Bun in admin Docker, no symlink-based node_modules).
4. **No secrets** in client bundles or logs.
5. **No new dependencies** that duplicate a built-in Bun or platform capability.

## npm Package Releases

OpenPalm publishes npm packages on an independent release cycle from Docker images and the platform. Each publishable package (`packages/channels-sdk`, `packages/assistant-tools`, `packages/channel-*`) has its own GitHub Actions workflow that publishes to npm when its version field changes on `main`. Platform packages (`packages/admin`, `core/guardian`, `packages/cli`) share a coordinated version managed by `scripts/release.sh`.

## Key docs for contributors

| Document | What you'll find |
|----------|-----------------|
| [docs/technical/core-principles.md](docs/technical/core-principles.md) | **Must-read.** Security invariants, filesystem contract, architectural rules |
| [docs/technical/code-quality-principles.md](docs/technical/code-quality-principles.md) | TypeScript strictness, module design, error handling |
| [docs/technical/docker-dependency-resolution.md](docs/technical/docker-dependency-resolution.md) | **Mandatory.** How Docker builds resolve deps across the monorepo |
| [docs/technical/directory-structure.md](docs/technical/directory-structure.md) | XDG tiers, volume mounts, dev vs. production paths |
| [docs/technical/api-spec.md](docs/technical/api-spec.md) | Admin API endpoint contract |
| [docs/technical/bunjs-rules.md](docs/technical/bunjs-rules.md) | Bun-specific patterns (guardian, channels, SDK) |
| [docs/technical/sveltekit-rules.md](docs/technical/sveltekit-rules.md) | SvelteKit patterns (admin UI) |
| [docs/community-channels.md](docs/community-channels.md) | BaseChannel SDK for building custom channel adapters |
| [docs/technical/environment-and-mounts.md](docs/technical/environment-and-mounts.md) | All environment variables and volume mounts |
