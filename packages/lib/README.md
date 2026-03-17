# @openpalm/lib

Shared control-plane library consumed by both the CLI and the admin SvelteKit app. All portable logic for managing an OpenPalm stack lives here -- paths, secrets, staging, lifecycle, Docker Compose operations, channel/connection management, scheduling, and setup orchestration.

Admin is a thin UI layer that re-exports from this package. The CLI calls these functions directly.

## Modules

| Module | Purpose |
|---|---|
| `types` | Core type definitions -- `ControlPlaneState`, `CoreServiceName`, `ChannelInfo`, `CanonicalConnectionProfile`, etc. |
| `paths` | XDG directory resolution (`resolveConfigHome`, `resolveDataHome`, `resolveStateHome`, `ensureXdgDirs`) |
| `env` | `.env` file parsing and merging (`parseEnvContent`, `parseEnvFile`, `mergeEnvContent`) |
| `secrets` | Secrets management -- ensure, read, patch, mask `secrets.env` |
| `setup-status` | First-boot detection (`isSetupComplete`, `readSecretsKeys`, `detectUserId`) |
| `setup` | Setup wizard backend (`performSetup`, `detectProviders`, `validateSetupInput`) |
| `staging` | Artifact staging pipeline (`stageArtifacts`, `persistArtifacts`, `buildEnvFiles`) |
| `lifecycle` | Install/update/uninstall/upgrade orchestration (`applyInstall`, `applyUpdate`, `createState`) |
| `docker` | Docker Compose CLI wrapper (`composeUp`, `composeDown`, `composePs`, `composeLogs`, etc.) |
| `channels` | Channel discovery, install, uninstall from registry or filesystem |
| `connection-profiles` | CRUD for connection profiles (LLM providers, embedding, etc.) |
| `connection-mapping` | Build OpenCode and mem0 config from connection profiles |
| `memory-config` | Read/write memory service config, push to running memory container |
| `scheduler` | Automation YAML parsing, Croner-based scheduler, execution log |
| `model-runner` | Local provider detection (Ollama, Docker Model Runner, LM Studio) |
| `core-assets` | Seed and read core infrastructure files (compose, Caddyfile, schemas) |
| `connection-migration-flags` | Migration compatibility detection (`readConnectionMigrationFlags`, `detectConnectionCompatibilityMode`) |
| `audit` | Append to the audit log |
| `logger` | Structured logger factory (`createLogger`) |
| `provider-constants` | LLM provider metadata (`LLM_PROVIDERS`, `PROVIDER_DEFAULT_URLS`, `EMBEDDING_DIMS`) |

## Dependency Injection

Asset loading differs between CLI and admin. Two interfaces abstract this:

### CoreAssetProvider

Returns the content of bundled infrastructure files (compose, Caddyfile, schemas, automations). Functions that need these files accept a `CoreAssetProvider` parameter.

| Implementation | Consumer | Source |
|---|---|---|
| `FilesystemAssetProvider` | CLI | Reads from `DATA_HOME` on disk |
| `ViteAssetProvider` | Admin | Reads from Vite `$assets` imports (defined in `packages/admin`, not in lib) |

### RegistryProvider

Returns channel and automation definitions from the registry catalog.

| Implementation | Consumer | Source |
|---|---|---|
| `FilesystemRegistryProvider` | CLI | Reads from `registry/` directory |
| `ViteRegistryProvider` | Admin | Reads via `import.meta.glob` (defined in `packages/admin`, not in lib) |

## Usage

```ts
import {
  createState,
  stageArtifacts,
  persistArtifacts,
  applyInstall,
  FilesystemAssetProvider,
} from "@openpalm/lib";

const assets = new FilesystemAssetProvider(dataHome);
const state = createState(configHome, dataHome, stateHome);

stageArtifacts(state, assets);
persistArtifacts(state, assets);
await applyInstall(state, assets, "cli");
```

Sub-path imports are also available:

```ts
import { resolveConfigHome } from "@openpalm/lib/control-plane/paths";
import { createLogger } from "@openpalm/lib/shared/logger";
import { LLM_PROVIDERS } from "@openpalm/lib/provider-constants";
```

## Architecture

See [`docs/technical/core-principles.md`](../../docs/technical/core-principles.md) for the filesystem contract and security invariants that govern this library.
