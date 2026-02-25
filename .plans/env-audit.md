# OpenPalm Environment Variable Audit

**Date**: 2026-02-25
**Scope**: All `.ts`, `.js`, `.sh`, `.yml`, `.yaml`, `.env*`, `Dockerfile*` files (excluding `node_modules/`, `.svelte-kit/`, `build/`)

---

## Summary

The codebase defines a clean config system in `packages/ui/src/lib/server/config.ts` that derives paths from three root variables. However, several modules — particularly in `packages/lib/` — bypass this system by reading environment variables directly at module scope, creating side-effect coupling and making the configuration story harder to reason about.

**Totals**:
- **59 unique env vars** found across the codebase
- **NECESSARY**: 36
- **REDUNDANT** (derivable from roots): 5
- **SIDE-EFFECT COUPLING** (lib reads env at import/module scope): 8
- **VESTIGIAL**: 1
- **ARCHITECTURAL CONCERN** (propagation via `process.env.X = Y`): 1

---

## Complete Env Var Inventory

### Legend

| Category | Meaning |
|----------|---------|
| NECESSARY | Truly external config: secrets, API keys, feature flags, service URLs, ports |
| REDUNDANT | Derivable from DATA_ROOT, CONFIG_ROOT, or STATE_ROOT |
| VESTIGIAL | Set but never read, or read but value has no effect |
| SIDE-EFFECT | Module reads env var at import time or in a lib that should receive config via params |
| PROPAGATION | `process.env.X = Y` pattern used to pass config between modules |

---

### A. Root Configuration Variables (NECESSARY)

These are the three pillars. All paths should derive from them.

| Env Var | Set In | Read In | Category | Notes |
|---------|--------|---------|----------|-------|
| `OPENPALM_DATA_ROOT` | `.env`, docker-compose | `config.ts:21` | NECESSARY | Container-internal data root (default `/data`) |
| `OPENPALM_CONFIG_ROOT` | `.env`, docker-compose | `config.ts:22` | NECESSARY | Container-internal config root (default `/config`) |
| `OPENPALM_STATE_ROOT` | `.env`, docker-compose | `config.ts:23` | NECESSARY | Container-internal state root (default `/state`) |

### B. Host-side XDG Path Variables (NECESSARY — CLI/installer context)

| Env Var | Set In | Read In | Category | Notes |
|---------|--------|---------|----------|-------|
| `OPENPALM_DATA_HOME` | `.env.example`, installer | `packages/lib/src/paths.ts:15` | NECESSARY | Host-side data dir for CLI (XDG-style) |
| `OPENPALM_CONFIG_HOME` | `.env.example`, installer | `packages/lib/src/paths.ts:20` | NECESSARY | Host-side config dir for CLI |
| `OPENPALM_STATE_HOME` | `.env.example`, installer | `packages/lib/src/paths.ts:25` | NECESSARY | Host-side state dir for CLI |
| `OPENPALM_WORK_HOME` | — | `packages/lib/src/paths.ts:58` | NECESSARY | Work directory override |
| `XDG_DATA_HOME` | OS | `packages/lib/src/paths.ts:16` | NECESSARY | Standard XDG fallback |
| `XDG_CONFIG_HOME` | OS | `packages/lib/src/paths.ts:21` | NECESSARY | Standard XDG fallback |
| `XDG_STATE_HOME` | OS | `packages/lib/src/paths.ts:26` | NECESSARY | Standard XDG fallback |
| `LOCALAPPDATA` | Windows OS | `packages/lib/src/paths.ts:12` | NECESSARY | Windows path fallback |

### C. Secrets & Authentication (NECESSARY)

| Env Var | Set In | Read In | Category | Notes |
|---------|--------|---------|----------|-------|
| `ADMIN_TOKEN` | `.env`, docker-compose | `config.ts:18`, docker-compose | NECESSARY | Admin API auth token |
| `POSTGRES_PASSWORD` | `.env`, docker-compose | docker-compose | NECESSARY | Database credential |
| `POSTGRES_DB` | docker-compose | docker-compose | NECESSARY | Database name |
| `POSTGRES_USER` | docker-compose | docker-compose | NECESSARY | Database user |
| `CHANNEL_CHAT_SECRET` | `.env`, env_file | `channels/chat/server.ts:12` | NECESSARY | Channel HMAC secret |
| `CHANNEL_DISCORD_SECRET` | `.env`, env_file | `channels/discord/server.ts:209` | NECESSARY | Channel HMAC secret |
| `CHANNEL_VOICE_SECRET` | `.env`, env_file | `channels/voice/server.ts:12` | NECESSARY | Channel HMAC secret |
| `CHANNEL_TELEGRAM_SECRET` | `.env`, env_file | `channels/telegram/server.ts:12` | NECESSARY | Channel HMAC secret |
| `CHANNEL_API_SECRET` | `.env`, env_file | `channels/api/server.ts:12` | NECESSARY | Channel HMAC secret |
| `CHANNEL_MCP_SECRET` | env_file | `channels/mcp/server.ts:13` | NECESSARY | Channel HMAC secret |
| `CHANNEL_A2A_SECRET` | env_file | `channels/a2a/server.ts:13` | NECESSARY | Channel HMAC secret |
| `CHANNEL_WEBHOOK_SECRET` | env_file | `channels/webhook/server.ts:12` | NECESSARY | Channel HMAC secret |
| `OPENMEMORY_API_KEY` | env_file, docker-compose | `openmemory-client.ts:57` | NECESSARY | Memory service auth |
| `OPENAI_COMPAT_API_KEY` | env_file | `channels/api/server.ts:13` | NECESSARY | API channel auth key |
| `ANTHROPIC_COMPAT_API_KEY` | env_file | `channels/api/server.ts:14` | NECESSARY | API channel auth key |

### D. Service URLs & Ports (NECESSARY)

| Env Var | Set In | Read In | Category | Notes |
|---------|--------|---------|----------|-------|
| `PORT` | docker-compose env | All servers | NECESSARY | Per-service listen port |
| `GATEWAY_URL` | docker-compose env | All channels, `config.ts:27` | NECESSARY | Gateway endpoint |
| `OPENPALM_ASSISTANT_URL` | docker-compose env | `config.ts:31`, `gateway/server.ts:261` | NECESSARY | Assistant endpoint |
| `OPENMEMORY_URL` | `config.ts:35` | Admin UI | NECESSARY | Memory dashboard URL |
| `OPENMEMORY_BASE_URL` | docker-compose env | `openmemory-client.ts:56`, tools | NECESSARY | Memory API base URL |

### E. Container Runtime Config (NECESSARY)

| Env Var | Set In | Read In | Category | Notes |
|---------|--------|---------|----------|-------|
| `OPENPALM_CONTAINER_PLATFORM` | `.env.example` | installer scripts | NECESSARY | docker vs podman |
| `OPENPALM_COMPOSE_BIN` | `.env`, docker-compose | `compose-runner.ts:22` | NECESSARY | Compose binary name |
| `OPENPALM_COMPOSE_SUBCOMMAND` | `.env`, docker-compose | `compose-runner.ts:26` | NECESSARY | `compose` subcommand |
| `OPENPALM_CONTAINER_SOCKET_PATH` | `.env`, docker-compose | docker-compose volumes | NECESSARY | Host socket path |
| `OPENPALM_CONTAINER_SOCKET_IN_CONTAINER` | `.env`, docker-compose | docker-compose volumes | NECESSARY | Container socket path |
| `OPENPALM_CONTAINER_SOCKET_URI` | `.env`, docker-compose | `compose-runner.ts:34` | NECESSARY | Socket URI for DOCKER_HOST |
| `OPENPALM_IMAGE_NAMESPACE` | `.env` | docker-compose | NECESSARY | Image registry prefix |
| `OPENPALM_IMAGE_TAG` | `.env` | docker-compose | NECESSARY | Image version tag |
| `OPENPALM_UID` | `.env` | docker-compose `user:` | NECESSARY | Container user ID |
| `OPENPALM_GID` | `.env` | docker-compose `user:` | NECESSARY | Container group ID |

### F. Bind Address Config (NECESSARY)

| Env Var | Set In | Read In | Category | Notes |
|---------|--------|---------|----------|-------|
| `OPENPALM_INGRESS_BIND_ADDRESS` | `.env` | docker-compose | NECESSARY | Caddy bind address |
| `OPENPALM_INGRESS_PORT` | `.env` | docker-compose | NECESSARY | Caddy HTTP port |
| `OPENPALM_OPENMEMORY_BIND_ADDRESS` | — | docker-compose | NECESSARY | OpenMemory bind |
| `OPENPALM_OPENMEMORY_DASHBOARD_BIND_ADDRESS` | `.env` | docker-compose | NECESSARY | Dashboard bind |
| `OPENPALM_ASSISTANT_BIND_ADDRESS` | — | docker-compose | NECESSARY | Assistant bind |
| `OPENPALM_ASSISTANT_SSH_BIND_ADDRESS` | — | docker-compose | NECESSARY | SSH bind |
| `OPENPALM_ASSISTANT_SSH_PORT` | — | docker-compose | NECESSARY | SSH port |

### G. Feature Flags & Tuning (NECESSARY)

| Env Var | Set In | Read In | Category | Notes |
|---------|--------|---------|----------|-------|
| `DEBUG` | user | `logger.ts:40`, `extensions/lib/logger.ts:28` | NECESSARY | Enable debug logging |
| `LOG_LEVEL` | user | `logger.ts:41`, `extensions/lib/logger.ts:29` | NECESSARY | Log level filter |
| `NO_COLOR` | user/CI | `packages/lib/src/ui.ts:6` | NECESSARY | Standard no-color flag |
| `OPENCODE_ENABLE_SSH` | `.env` | docker-compose | NECESSARY | SSH toggle for assistant |
| `OPENCODE_TIMEOUT_MS` | docker-compose | `assistant-client.ts:22` | NECESSARY | Request timeout |
| `OPENPALM_MEMORY_MODE` | docker-compose env | `openmemory-client.ts:58` | NECESSARY | Memory feature toggle |
| `RECALL_LIMIT` | docker-compose env | `openmemory-client.ts:59` | NECESSARY | Memory recall limit |
| `RECALL_MAX_CHARS` | docker-compose env | `openmemory-client.ts:60` | NECESSARY | Memory recall char limit |
| `WRITEBACK_ENABLED` | docker-compose env | `openmemory-client.ts:61` | NECESSARY | Memory writeback toggle |
| `TEMPORAL_ENABLED` | docker-compose env | `openmemory-client.ts:62` | NECESSARY | Temporal KG toggle |
| `OPENPALM_ALLOW_INSECURE_ADMIN_HTTP` | user | `admin.ts:78` | NECESSARY | Dev safety override |
| `OPENPALM_ADMIN_TIMEOUT_MS` | user | `admin.ts:79` | NECESSARY | CLI admin timeout |
| `OPENPALM_RUN_DOCKER_STACK_TESTS` | CI | test files | NECESSARY | CI test gate |
| `OPENPALM_INTEGRATION` | CI | test files | NECESSARY | Integration test gate |

### H. Channel-Specific Config (NECESSARY)

| Env Var | Set In | Read In | Category | Notes |
|---------|--------|---------|----------|-------|
| `DISCORD_PUBLIC_KEY` | env_file | `channels/discord/server.ts:210` | NECESSARY | Ed25519 verification key |
| `DISCORD_APPLICATION_ID` | env_file | `channels/discord/server.ts:211` | NECESSARY | Discord app ID |
| `DISCORD_BOT_TOKEN` | env_file | `channels/discord/server.ts:212` | NECESSARY | Discord bot token |
| `DISCORD_CUSTOM_COMMANDS` | env_file | `channels/discord/server.ts:228` | NECESSARY | Custom slash commands |
| `DISCORD_REGISTER_COMMANDS` | env_file | `channels/discord/server.ts:232` | NECESSARY | Command registration toggle |
| `DISCORD_ALLOWED_GUILDS` | env_file | `channels/discord/permissions.ts:28` | NECESSARY | Guild allowlist |
| `DISCORD_ALLOWED_ROLES` | env_file | `channels/discord/permissions.ts:29` | NECESSARY | Role allowlist |
| `DISCORD_ALLOWED_USERS` | env_file | `channels/discord/permissions.ts:30` | NECESSARY | User allowlist |
| `DISCORD_BLOCKED_USERS` | env_file | `channels/discord/permissions.ts:31` | NECESSARY | User blocklist |
| `TELEGRAM_WEBHOOK_SECRET` | env_file | `channels/telegram/server.ts:13` | NECESSARY | Telegram webhook secret |
| `WEBHOOK_INBOUND_TOKEN` | env_file | `channels/webhook/server.ts:13` | NECESSARY | Webhook auth token |
| `CHAT_INBOUND_TOKEN` | env_file | `channels/chat/server.ts:13` | NECESSARY | Chat auth token |
| `MCP_BEARER_TOKEN` | env_file | `channels/mcp/channel.ts:3` | NECESSARY | MCP auth token |
| `A2A_BEARER_TOKEN` | env_file | `channels/a2a/channel.ts:3` | NECESSARY | A2A auth token |
| `A2A_PUBLIC_URL` | env_file | `channels/a2a/channel.ts:12` | NECESSARY | A2A agent card URL |
| `ANTHROPIC_API_KEY` | env/secrets | `packages/lib/src/detect-providers.ts:95` | NECESSARY | Provider detection |
| `OPENAI_API_KEY` | env/secrets | `packages/lib/src/detect-providers.ts:125` | NECESSARY | Provider detection |

---

## Chaos List: Problematic Environment Variables

### 1. REDUNDANT — Derivable from Root Variables

#### `CRON_DIR`
- **Read in**: `packages/lib/src/admin/automation-history.ts:5` (via `Bun.env.CRON_DIR`), `config.ts:44`
- **Set in**: `config.ts:44` (derives from STATE_ROOT as `${STATE_ROOT}/automations` with fallback), `init.ts:73` (propagated via `process.env.CRON_DIR = CRON_DIR`)
- **Value**: Always `${STATE_ROOT}/automations`
- **Verdict**: **REDUNDANT + SIDE-EFFECT COUPLING + PROPAGATION**
- **Cleanup**: Remove the env var entirely. `automation-history.ts` and `automations.ts` should accept `cronDir` as a parameter (automations.ts already does via its default parameter). `automation-history.ts` should be refactored to match.

#### `DATA_DIR`
- **Read in**: `config.ts:26` (via `env.DATA_DIR`)
- **Set in**: Not set anywhere in docker-compose or `.env`
- **Value**: Always `${DATA_ROOT}/admin`
- **Verdict**: **REDUNDANT** — the env var override is never used in practice
- **Cleanup**: Remove the `env.DATA_DIR ??` fallback; just compute `${DATA_ROOT}/admin` directly.

#### `OPENCODE_CONFIG_PATH`
- **Read in**: `config.ts:24-25` (via `env.OPENCODE_CONFIG_PATH`)
- **Set in**: Not set anywhere in docker-compose or `.env`
- **Value**: Always `${DATA_ROOT}/assistant/.config/opencode/opencode.json`
- **Verdict**: **REDUNDANT** — derivable from DATA_ROOT. The env var override is never used in production.
- **Cleanup**: Remove the `env.OPENCODE_CONFIG_PATH ??` fallback; compute from DATA_ROOT.

#### `COMPOSE_PROJECT_PATH`
- **Read in**: `packages/lib/src/admin/compose-runner.ts:18` (via `envValue("COMPOSE_PROJECT_PATH")`)
- **Set in**: docker-compose admin env (`COMPOSE_PROJECT_PATH=/state`), test fixtures
- **Value**: Always `/state` in Docker (which IS STATE_ROOT)
- **Verdict**: **REDUNDANT** — this is just STATE_ROOT by another name inside the container
- **Cleanup**: The admin compose-runner should receive `stateRoot` as a constructor parameter instead of reading an env var. The docker-compose already mounts `${OPENPALM_STATE_HOME}:/state`.

#### `GATEWAY_NONCE_CACHE_PATH`
- **Read in**: `core/gateway/src/nonce-cache.ts:109` (module-scope singleton)
- **Set in**: Never set in any docker-compose or `.env` file
- **Value**: Always falls back to `/app/data/nonce-cache.json`
- **Verdict**: **REDUNDANT/VESTIGIAL** — the env var override is never used, and the path is within the gateway's data volume which is already at `${STATE_ROOT}/gateway`
- **Cleanup**: Remove the env var. Accept the path as a constructor parameter. The gateway server startup code should compute the path.

---

### 2. SIDE-EFFECT COUPLING — `packages/lib/` Reads Env Vars Directly

These are violations of the principle that `packages/lib/` should receive configuration via function parameters or constructor injection, not read `Bun.env`/`process.env` directly.

#### `Bun.env.CRON_DIR` in `packages/lib/src/admin/automation-history.ts:5`
```typescript
function logDir(): string { return join(Bun.env.CRON_DIR ?? "/state/automations", "log"); }
```
- **Problem**: Lib module reads env var at call time. The sister module `automations.ts` correctly uses a default parameter `cronDir = DEFAULT_CRON_DIR` — `automation-history.ts` does not.
- **Fix**: Add a `cronDir` parameter to `readHistory()` and `getLatestRun()`, matching the pattern in `automations.ts`.

#### `Bun.env.*` in `packages/lib/src/admin/compose-runner.ts:12-38`
```typescript
function envValue(name: string): string | undefined {
  const bunEnv = (globalThis as ...).Bun?.env;
  return bunEnv?.[name] ?? process.env[name];
}
```
- **Problem**: `composeProjectPath()`, `composeBin()`, `composeSubcommand()`, `composeFilePath()`, `containerSocketUri()`, and `extraServicesFromEnv()` all read env vars via `envValue()`. This is the single biggest source of env coupling in lib.
- **Fix**: `createComposeRunner()` should accept a config object `{ projectPath, bin, subcommand, composeFile, socketUri, extraServices }` instead of reading from env. The admin service (docker-compose) passes all these values — the lib shouldn't need to read them itself.

#### `Bun.env.*` in `packages/lib/src/paths.ts:12-58`
- **Problem**: Reads `OPENPALM_DATA_HOME`, `OPENPALM_CONFIG_HOME`, `OPENPALM_STATE_HOME`, `OPENPALM_WORK_HOME`, `XDG_*`, `LOCALAPPDATA` directly from `Bun.env`.
- **Mitigating context**: This is the CLI paths module — it is specifically designed to resolve host-side paths from env vars. This is **acceptable** for the CLI context because there is no higher-level config system available. The CLI IS the boundary.
- **Verdict**: Acceptable for CLI, but should be documented as CLI-only. If used from admin container, it would be wrong.

#### `Bun.env.ANTHROPIC_API_KEY` / `Bun.env.OPENAI_API_KEY` in `packages/lib/src/detect-providers.ts:95,125`
- **Problem**: Reads API keys directly from Bun.env.
- **Mitigating context**: This is CLI-only provider detection during `openpalm install`. Acceptable at boundary.
- **Verdict**: Acceptable for CLI boundary, but the functions should accept an env parameter for testability. Currently tests must mutate global `Bun.env`.

#### `Bun.env.NO_COLOR` in `packages/lib/src/ui.ts:6`
- **Problem**: Module-level env read.
- **Verdict**: Acceptable — `NO_COLOR` is a standard convention and this is a terminal utility.

#### `Bun.env.DEBUG` / `Bun.env.LOG_LEVEL` in `packages/lib/src/shared/logger.ts:40-41`
- **Problem**: Read at every log call via `getMinLevel()`.
- **Verdict**: Acceptable — logger must be globally configurable. Re-reading on each call allows runtime changes.

---

### 3. PROPAGATION — `process.env.X = Y` Anti-pattern

#### `process.env.CRON_DIR = CRON_DIR` in `packages/ui/src/lib/server/init.ts:73`
```typescript
// Propagate CRON_DIR so @openpalm/lib/admin/automations reads it at module scope
process.env.CRON_DIR = CRON_DIR;
```
- **Problem**: The admin UI startup sets an env var so that a downstream lib module (`automation-history.ts`) will find it when called. This is implicit coupling via the global environment. It exists BECAUSE `automation-history.ts` reads `Bun.env.CRON_DIR` instead of accepting a parameter.
- **Fix**: Once `automation-history.ts` accepts `cronDir` as a parameter, remove this propagation line.

---

### 4. VESTIGIAL — Potentially Unused

#### `OPENPALM_EXTRA_SERVICES`
- **Read in**: `packages/lib/src/admin/compose-runner.ts:38`
- **Set in**: Never set in any docker-compose or `.env` file. Only tested in `compose-runner.test.ts:73`.
- **Verdict**: Partially vestigial — the env var exists for extensibility but is undocumented and not exposed through any config surface. Should be documented or removed.

---

### 5. Architectural Concerns — Cross-Module Env Reading

#### `core/assistant/extensions/lib/openmemory-client.ts:54-63`
```typescript
export function loadConfig() {
  return {
    baseUrl: process.env.OPENMEMORY_BASE_URL ?? "http://openmemory:8765",
    ...
  };
}
```
- **Context**: The assistant extensions run inside the OpenCode runtime which has no `@openpalm/lib` available. Reading env directly is the only option here.
- **Verdict**: **Acceptable** — this is a runtime boundary. The docker-compose correctly injects these via `environment:` block.

#### `core/assistant/extensions/tools/memory-save.ts:10` and `memory-query.ts:11`
```typescript
const baseUrl = Bun.env.OPENMEMORY_BASE_URL ?? "http://openmemory:8765";
```
- **Problem**: These tools read `OPENMEMORY_BASE_URL` directly instead of using the shared `loadConfig()` from `openmemory-client.ts`.
- **Fix**: Import `loadConfig()` and use `loadConfig().baseUrl`.

#### `core/gateway/src/nonce-cache.ts:109` — Module-scope singleton with env read
```typescript
export const nonceCache = new NonceCache(Bun.env.GATEWAY_NONCE_CACHE_PATH ?? "/app/data/nonce-cache.json");
```
- **Problem**: The singleton is created at module import time with an env var read. Cannot be overridden without mutating `Bun.env` before import.
- **Fix**: Export a factory function or lazy getter instead of a pre-built singleton.

#### `core/gateway/src/assistant-client.ts:22` — Module-scope timeout
```typescript
const DEFAULT_TIMEOUT_MS = Number(Bun.env.OPENCODE_TIMEOUT_MS ?? 15_000);
```
- **Problem**: Reads env at module scope. Cannot be overridden after import.
- **Verdict**: Minor concern. The gateway is a standalone service; this is acceptable for service-level configuration.

---

## Docker Compose Env Var Flow

The `docker-compose.yml` correctly uses compose-variable substitution from the host `.env` file:

| Compose Variable | Source | Purpose |
|-----------------|--------|---------|
| `${OPENPALM_STATE_HOME}` | Host .env | Volume mounts & env_file paths |
| `${OPENPALM_DATA_HOME}` | Host .env | Volume mounts |
| `${OPENPALM_CONFIG_HOME}` | Host .env | Volume mounts |
| `${ADMIN_TOKEN}` | Host .env | Injected into admin + assistant containers |
| `${POSTGRES_PASSWORD}` | Host .env | Required secret |
| `${OPENPALM_IMAGE_NAMESPACE}` | Host .env | Image registry |
| `${OPENPALM_IMAGE_TAG}` | Host .env | Image version |
| `${OPENPALM_UID}` / `${OPENPALM_GID}` | Host .env | Container user |
| `${OPENPALM_COMPOSE_BIN}` etc. | Host .env | Compose runtime |

**Note**: Container-internal env vars like `COMPOSE_PROJECT_PATH=/state`, `GATEWAY_URL=http://gateway:8080`, and `PORT=8100` are hardcoded in the compose file. This is correct — they are container-internal constants.

---

## Recommended Cleanup Actions

### Priority 1: Fix `packages/lib/` Side-Effect Coupling

1. **`automation-history.ts`**: Add `cronDir` parameter to `readHistory()` and `getLatestRun()` with default `"/state/automations"`. Remove `Bun.env.CRON_DIR` read.

2. **Remove `process.env.CRON_DIR = CRON_DIR`** from `packages/ui/src/lib/server/init.ts:73` once step 1 is done.

3. **Remove `CRON_DIR` from `config.ts`**. Compute inline as `${STATE_ROOT}/automations` where needed.

4. **`compose-runner.ts`**: Accept a config struct in `createComposeRunner()`:
   ```typescript
   type ComposeConfig = {
     projectPath: string;      // was COMPOSE_PROJECT_PATH
     bin: string;              // was OPENPALM_COMPOSE_BIN
     subcommand: string;       // was OPENPALM_COMPOSE_SUBCOMMAND
     composeFile: string;      // was OPENPALM_COMPOSE_FILE
     socketUri: string;        // was OPENPALM_CONTAINER_SOCKET_URI
     extraServices?: string[]; // was OPENPALM_EXTRA_SERVICES
   };
   ```
   The admin UI's `init.ts` already passes these via the `StackManager` constructor — extend the pattern to compose-runner.

### Priority 2: Remove Redundant Config Variables

5. **Remove `DATA_DIR`** env var override from `config.ts:26`. Replace with:
   ```typescript
   export const DATA_DIR = `${DATA_ROOT}/admin`;
   ```

6. **Remove `OPENCODE_CONFIG_PATH`** env var override from `config.ts:24-25`. Replace with:
   ```typescript
   export const OPENCODE_CONFIG_PATH = `${DATA_ROOT}/assistant/.config/opencode/opencode.json`;
   ```

7. **Remove `GATEWAY_NONCE_CACHE_PATH`** from `nonce-cache.ts`. Accept path in constructor; compute at server startup.

### Priority 3: Consolidate Duplicate Env Reads

8. **`memory-save.ts` and `memory-query.ts`**: Use `loadConfig().baseUrl` from `openmemory-client.ts` instead of directly reading `Bun.env.OPENMEMORY_BASE_URL`.

### Priority 4: Documentation

9. **Document `OPENPALM_EXTRA_SERVICES`** or remove it. Currently undocumented and only tested.

---

## Clean Architecture: How Env Vars SHOULD Flow

```
┌──────────────────────────────────────────────────────────────┐
│                    HOST ENVIRONMENT                          │
│                                                              │
│  .env file (installer-generated)                             │
│  ├── OPENPALM_DATA_HOME=/home/user/.local/share/openpalm    │
│  ├── OPENPALM_CONFIG_HOME=/home/user/.config/openpalm       │
│  ├── OPENPALM_STATE_HOME=/home/user/.local/state/openpalm   │
│  ├── ADMIN_TOKEN=<secret>                                    │
│  ├── POSTGRES_PASSWORD=<secret>                              │
│  └── CHANNEL_*_SECRET=<secrets>                              │
│                                                              │
│  docker compose --env-file .env ─── interpolates ${} vars    │
└──────────────┬───────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│                DOCKER COMPOSE (orchestration boundary)        │
│                                                              │
│  Mounts:                                                     │
│    ${OPENPALM_DATA_HOME}  → /data     (DATA_ROOT)            │
│    ${OPENPALM_CONFIG_HOME}→ /config   (CONFIG_ROOT)          │
│    ${OPENPALM_STATE_HOME} → /state    (STATE_ROOT)           │
│                                                              │
│  Container env (hardcoded constants, NOT env vars):          │
│    PORT=8100  GATEWAY_URL=http://gateway:8080  etc.          │
│                                                              │
│  Container env (pass-through secrets from .env):             │
│    ADMIN_TOKEN=${ADMIN_TOKEN}                                │
│    CHANNEL_*_SECRET (via env_file)                           │
└──────────────┬───────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│           CONTAINER: Admin Service (packages/ui)             │
│                                                              │
│  config.ts (SINGLE source of truth inside container):        │
│  ├── DATA_ROOT   = env.OPENPALM_DATA_ROOT   ?? "/data"      │
│  ├── CONFIG_ROOT = env.OPENPALM_CONFIG_ROOT ?? "/config"     │
│  ├── STATE_ROOT  = env.OPENPALM_STATE_ROOT  ?? "/state"      │
│  │                                                           │
│  │   ALL paths derived from roots:                           │
│  ├── RUNTIME_ENV_PATH  = `${STATE_ROOT}/.env`               │
│  ├── SECRETS_ENV_PATH  = `${CONFIG_ROOT}/secrets.env`        │
│  ├── STACK_SPEC_PATH   = `${CONFIG_ROOT}/openpalm.yaml`     │
│  ├── COMPOSE_FILE_PATH = `${STATE_ROOT}/docker-compose.yml`  │
│  └── CRON_DIR          = `${STATE_ROOT}/automations`  ← NEW │
│                                                              │
│  init.ts (startup):                                          │
│  ├── Creates StackManager({ stateRootPath, ... })            │
│  ├── Creates ComposeRunner({ projectPath: STATE_ROOT, ... }) │
│  └── Passes cronDir to automation functions as parameter     │
│                                                              │
│  NO process.env propagation                                  │
│  NO Bun.env reads in packages/lib/ modules                   │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│          CONTAINER: Gateway, Channels, Assistant             │
│                                                              │
│  Each reads its OWN env vars at startup (service boundary):  │
│  ├── PORT, GATEWAY_URL, CHANNEL_*_SECRET                     │
│  ├── DISCORD_*, TELEGRAM_*, etc.                             │
│  └── Service-specific config                                 │
│                                                              │
│  This is correct — each container is a process boundary.     │
│  Env vars are the standard config mechanism for containers.  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│          HOST: CLI (packages/cli)                            │
│                                                              │
│  paths.ts reads XDG env vars (CLI IS the boundary).          │
│  detect-providers.ts reads API keys (boundary detection).    │
│  admin.ts merges state .env + Bun.env for admin commands.    │
│                                                              │
│  This is correct — the CLI has no higher-level config.       │
└──────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Three roots, everything derived**: `DATA_ROOT`, `CONFIG_ROOT`, `STATE_ROOT` are the only path env vars. Everything else is computed.

2. **Env reads at boundaries only**: Env vars are read at process startup (container `main`, CLI `main`). Library modules receive config via parameters.

3. **No propagation**: Never set `process.env.X = Y` to pass config to downstream modules. Use function parameters or constructor injection.

4. **Docker-compose is the container config surface**: Container-internal constants (`PORT=8100`, `GATEWAY_URL=http://gateway:8080`) are set in docker-compose, not read from the host.

5. **Secrets in env, paths in code**: Secrets (tokens, passwords, API keys) are the primary legitimate env vars. Paths are derived from the three roots.
