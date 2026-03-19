# OpenPalm — Secrets Management Integration

Implementation guide for migrating OpenPalm's secrets from plaintext `.env` files to encrypted-at-rest storage, with a provider-agnostic design that supports `pass`, Azure Key Vault, AWS Secrets Manager, 1Password, Bitwarden, Google Secret Manager, and Infisical — swappable via schema/config without code changes.

**Default provider:** `PlaintextBackend` (existing `secrets.env` behavior). Encrypted storage via `pass` (passwordstore.org) + `@varlock/pass-plugin` is opt-in through the setup wizard.
**Read path (all providers):** Varlock resolves secrets via provider-specific schema — swap the `.env.schema` file to swap the provider
**Write path:** `SecretBackend` interface with pluggable driver — selected automatically from the schema

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Phase 0 — Varlock Hardening](#phase-0--varlock-hardening)
- [Phase 1 — Auth Refactor: ADMIN_TOKEN / ASSISTANT_TOKEN Split](#phase-1--auth-refactor)
- [Phase 2 — Secret Backend Abstraction](#phase-2--secret-backend-abstraction)
- [Phase 3 — pass Provider (Default)](#phase-3--pass-provider-default)
- [Phase 4 — Secrets API Routes](#phase-4--secrets-api-routes)
- [Phase 5 — Password Manager UI](#phase-5--password-manager-ui)
- [Phase 6 — Connections Endpoint Refactor](#phase-6--connections-endpoint-refactor)
- [Phase 7 — Migration Tooling](#phase-7--migration-tooling)
- [Appendix A — Provider Swap Guide](#appendix-a--provider-swap-guide)
- [Appendix B — Security Model](#appendix-b--security-model)
- [Appendix C — Token Refactor Migration Checklist](#appendix-c--token-refactor-migration-checklist)

---

## Architecture Overview

### Unified Secret Manager

The secret manager is the single system through which ALL secrets are resolved, stored, and lifecycle-managed. It wraps Varlock (for boot-time resolution) and the configured `SecretBackend` (for runtime write operations). Three categories of secrets flow through this system:

**Core secrets** — Global secrets for the OpenPalm stack itself: `ADMIN_TOKEN`, `ASSISTANT_TOKEN`, LLM API keys, `MEMORY_AUTH_TOKEN`, etc. These are declared in the top-level `secrets.env.schema` and mapped in `ENV_TO_SECRET_KEY`.

**Component secrets** — Per-instance secrets for installed components (e.g., `DISCORD_BOT_TOKEN` for a Discord channel instance). Each component's `.env.schema` file declares `@sensitive` fields. When a component instance is created, the secret manager initializes entries for its sensitive fields. When an instance is deleted, the secret manager cleans up its entries. Component secrets use the prefix convention `openpalm/component/<instance-id>/`.

**Ad-hoc secrets** — Secrets the user or assistant discovers and wants to store (e.g., an API key for a custom tool). These use the prefix `openpalm/custom/` and are managed through the secrets API.

The `ENV_TO_SECRET_KEY` map is dynamic: it includes static core mappings plus per-component mappings derived from `.env.schema` files at runtime. When a component is installed, its `@sensitive` fields are registered; when removed, they are deregistered.

### Two independent paths

**Read path** (boot-time, all providers): Varlock resolves secrets from the `.env.schema` file using whichever provider plugin is declared. Changing the provider is a schema-file swap — no code changes.

**Write path** (runtime, admin UI): The `SecretBackend` interface abstracts list/write/generate/delete operations. The admin auto-detects which backend to use by parsing the `@plugin()` declaration from the active schema. Adding a new provider requires only a new driver file implementing the interface. The `PlaintextBackend` is the default when no encrypted provider is configured.

```
┌──────────────────────────────────────────────────────────────────┐
│  READ PATH (boot-time) — provider-agnostic via varlock           │
│                                                                  │
│  .env.schema declares @plugin + resolver function:               │
│                                                                  │
│  plaintext: (no @plugin)                      → literal values   │
│  pass:    @plugin(@varlock/pass-plugin)     → pass("entry")      │
│  Azure:   @plugin(@varlock/azure-key-vault) → azureSecret()      │
│  AWS:     @plugin(@varlock/aws-secrets)     → awsSecret()        │
│  1Pass:   @plugin(@varlock/1password)       → op()               │
│  Bitwarden: @plugin(@varlock/bitwarden)     → bw()               │
│  GCP:     @plugin(@varlock/google-secret)   → gcpSecret()        │
│  Infisical: @plugin(@varlock/infisical)     → infisical()        │
│                                                                  │
│  varlock run → resolves all → injects into process.env           │
│  (identical behavior regardless of provider)                     │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  WRITE PATH (runtime) — SecretBackend interface                  │
│                                                                  │
│  Admin detects @plugin from schema → selects matching driver     │
│  No @plugin detected → PlaintextBackend (default)                │
│                                                                  │
│  SecretBackend {                                                 │
│    list(prefix): string[]                                        │
│    write(key, value): void                                       │
│    generate(key, length): void                                   │
│    remove(key): void                                             │
│    exists(key): boolean                                          │
│    readonly capabilities: { generate, remove, rename }           │
│  }                                                               │
│                                                                  │
│  Drivers:                                                        │
│    PlaintextBackend → reads/writes traditional secrets.env       │
│    PassBackend      → shells out to `pass` CLI                   │
│    AzureKvBackend   → REST API (az login / managed identity)     │
│    AwsSmBackend     → AWS CLI / SDK                              │
│    (future providers follow same pattern)                        │
└──────────────────────────────────────────────────────────────────┘
```

### Component secret lifecycle

When the component lifecycle creates an instance:

1. Parse the component's `.env.schema` for `@sensitive` fields
2. For each sensitive field, register a mapping in the dynamic `ENV_TO_SECRET_KEY` (e.g., `DISCORD_BOT_TOKEN` → `openpalm/component/discord-main/discord-bot-token`)
3. Call `backend.write()` or prompt the user for initial values via the UI
4. Generate the component's resolved `.env` file for Docker Compose injection

When a component instance is deleted:

1. Call `backend.remove()` for each of the instance's secret entries
2. Deregister the dynamic mappings

### Secret store location

All provider-specific data lives under `OPENPALM_DATA_HOME/secrets/`:

```
~/.local/share/openpalm/secrets/
├── provider.json          ← backend config (which provider, init params)
├── pass-store/            ← PASSWORD_STORE_DIR for pass backend
│   ├── .gpg-id
│   └── openpalm/
│       ├── admin-token.gpg
│       ├── assistant-token.gpg
│       ├── llm/
│       │   └── ...
│       ├── component/
│       │   └── discord-main/
│       │       └── discord-bot-token.gpg
│       └── custom/
│           └── ...
└── (future: azure-kv/, aws-sm/, etc. — provider-specific cache/state)
```

This follows the existing data model where `DATA_HOME` holds opaque service data. The pass store is no longer at `~/.password-store` — it's scoped to the OpenPalm install, making multi-instance setups possible and keeping secrets co-located with their stack for backup/restore.

### Container topology

```
┌─────────────────────────────────────────────────────────────────┐
│ ADMIN CONTAINER                                                 │
│  Auth: ADMIN_TOKEN (user-chosen)                                │
│  Mounts: DATA_HOME/secrets/ (rw), GPG agent socket (ro)         │
│  Can: list, write, generate, delete secrets                     │
│  Cannot: read/decrypt secret values into HTTP responses          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ ADMIN OPENCODE INSTANCE (brokered, #304)                        │
│  Auth: ADMIN_TOKEN (full admin-level access)                    │
│  Embedded inside admin container — NOT a separate service        │
│  Can: call ALL admin API endpoints including /admin/secrets      │
│  Can: accept requests from the assistant for privileged ops      │
│  Note: This is an admin agent, not the assistant. Assistant      │
│        isolation is preserved — the brokered instance bridges    │
│        the gap when the assistant needs admin operations.        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ ASSISTANT CONTAINER                                             │
│  Auth: ASSISTANT_TOKEN (auto-generated)                         │
│  Mounts: (no secrets access)                                    │
│  Can: call operational admin endpoints (containers, channels)   │
│  Cannot: call /admin/secrets, write API keys                    │
│  Note: The assistant is isolated. It does NOT have ADMIN_TOKEN. │
│        For privileged operations, it requests them through the  │
│        brokered admin OpenCode instance.                        │
└─────────────────────────────────────────────────────────────────┘
```

### CONFIG_HOME contract note

After migration to an encrypted backend, `CONFIG_HOME` holds `secrets.env.schema` (resolver declarations pointing to the secret store) rather than the plaintext `secrets.env` file with raw values. The `secrets.env.schema` is still user-owned and user-editable — it declares which secrets exist and how they resolve, but contains no secret values. `core-principles.md` should be updated to reflect this change in what CONFIG_HOME contains for secrets.

---

## Phase 0 — Varlock Hardening

No `pass` or auth changes. Ship independently.

### 0.1 — Fix staged secrets file permissions

**File:** `packages/admin/src/lib/server/staging.ts` — `stageSecretsEnv()`

```typescript
writeFileSync(`${artifactDir}/secrets.env`, content, { mode: 0o600 });
```

Also apply `mode: 0o600` to `DATA_HOME/stack.env` — it may contain interpolated secret references and should not be world-readable:

```typescript
writeFileSync(`${dataHome}/stack.env`, content, { mode: 0o600 });
```

### 0.2 — Add varlock to guardian and memory Dockerfiles

Same pattern as admin/assistant: varlock-fetch stage, bake in `redact.env.schema`, wrap CMD with `varlock run --path /app/ --`.

### 0.3 — Auto-generate `redact.env.schema` from `secrets.env.schema`

New build script extracts `@sensitive` keys. Run before `docker build`.

---

## Phase 1 — Auth Refactor

**Goal:** `ADMIN_TOKEN` is the user's credential. `ASSISTANT_TOKEN` is the assistant's credential. Secrets endpoints accept only `ADMIN_TOKEN`.

### 1.1 — State and secrets changes

**`types.ts`** — add `assistantToken: string` to `ControlPlaneState`

**`secrets.ts`** — `ensureSecrets()` generates `ASSISTANT_TOKEN=<randomBytes(32).hex>` alongside `MEMORY_AUTH_TOKEN`

**`lifecycle.ts`** — `createState()` loads `assistantToken` from `fileEnv.ASSISTANT_TOKEN ?? process.env.ASSISTANT_TOKEN`

### 1.2 — New auth middleware

**File:** `packages/admin/src/lib/server/helpers.ts`

```typescript
/** Identify caller by which token they presented. */
export function identifyCallerByToken(
  event: RequestEvent
): "admin" | "assistant" | null {
  const state = getState();
  const token = event.request.headers.get("x-admin-token") ?? "";
  if (state.adminToken && safeTokenCompare(token, state.adminToken)) return "admin";
  if (state.assistantToken && safeTokenCompare(token, state.assistantToken)) return "assistant";
  return null;
}

/** Require ADMIN_TOKEN specifically. For: secrets, setup, lifecycle. */
export function requireAdmin(event: RequestEvent, requestId: string): Response | null {
  const state = getState();
  if (!state.adminToken) {
    return jsonResponse(503, { error: "admin_not_configured", message: "Complete setup first." });
  }
  const token = event.request.headers.get("x-admin-token") ?? "";
  if (!safeTokenCompare(token, state.adminToken)) {
    return errorResponse(401, "unauthorized", "Requires admin token", {}, requestId);
  }
  return null;
}

/** Require either ADMIN_TOKEN or ASSISTANT_TOKEN. For: operational endpoints. */
export function requireAuth(event: RequestEvent, requestId: string): Response | null {
  const state = getState();
  if (!state.adminToken) {
    return jsonResponse(503, { error: "admin_not_configured", message: "Complete setup first." });
  }
  if (!identifyCallerByToken(event)) {
    return errorResponse(401, "unauthorized", "Missing or invalid token", {}, requestId);
  }
  return null;
}

/** Deterministic actor from token — no self-reported headers. */
export function getActor(event: RequestEvent): string {
  return identifyCallerByToken(event) ?? "unauthenticated";
}
```

### 1.3 — Route migration

**Change `requireAdmin` → `requireAuth`** on all operational routes (containers, channels, connections, artifacts, audit, automations, registry, update, memory, config, access-scope, providers, installed).

**Keep `requireAdmin`** on: setup, install, uninstall, upgrade, and all new `/admin/secrets` routes.

See [Appendix C](#appendix-c--token-refactor-migration-checklist) for the complete file list.

### 1.4 — Docker Compose changes

```yaml
assistant:
  environment:
    # BEFORE: OPENPALM_ADMIN_TOKEN: ${ADMIN_TOKEN:-}
    OPENPALM_ASSISTANT_TOKEN: ${ASSISTANT_TOKEN:-}   # NEW

admin:
  environment:
    ADMIN_TOKEN: ${ADMIN_TOKEN:-}
    ASSISTANT_TOKEN: ${ASSISTANT_TOKEN:-}             # NEW — for verification

guardian:
  environment:
    # REMOVE: ADMIN_TOKEN: ${ADMIN_TOKEN:-}          # guardian never used it
```

### 1.5 — Assistant tools

**File:** `packages/assistant-tools/opencode/tools/lib.ts`

```typescript
const ASSISTANT_TOKEN = process.env.OPENPALM_ASSISTANT_TOKEN || "";
// header name stays x-admin-token for backward compat
headers: { "x-admin-token": ASSISTANT_TOKEN, ... }
```

### 1.6 — Upgrade migration

In `hooks.server.ts`, after `ensureSecrets()`:

```typescript
const fileEnv = loadSecretsEnvFile(state.configDir);
if (!fileEnv.ASSISTANT_TOKEN) {
  patchSecretsEnvFile(state.configDir, {
    ASSISTANT_TOKEN: randomBytes(32).toString("hex"),
  });
  state.assistantToken = loadSecretsEnvFile(state.configDir).ASSISTANT_TOKEN ?? "";
}
```

---

## Phase 2 — Secret Backend Abstraction

The core abstraction that makes provider swap possible.

### 2.1 — `SecretBackend` interface

**File:** `packages/admin/src/lib/server/secret-backend.ts`

```typescript
/**
 * Provider-agnostic interface for secret store operations.
 *
 * CRITICAL CONSTRAINT: No method returns decrypted secret values.
 * The read path goes through varlock (process.env at boot).
 * This interface is write-only + metadata.
 */
export interface SecretBackend {
  /** Provider identifier (e.g., "plaintext", "pass", "azure-key-vault"). */
  readonly provider: string;

  /** What this backend can do — UI disables unsupported actions. */
  readonly capabilities: {
    /** Can generate random secrets server-side. */
    generate: boolean;
    /** Can delete individual entries. */
    remove: boolean;
    /** Can rename/move entries. */
    rename: boolean;
    /** Can list entries without decryption. */
    list: boolean;
  };

  /** List entry names/keys under a prefix. No decryption. */
  list(prefix: string): Promise<string[]>;

  /** Check if an entry exists without decrypting. */
  exists(key: string): Promise<boolean>;

  /** Write a secret value. The value is encrypted by the provider. */
  write(key: string, value: string): Promise<void>;

  /** Generate a random secret and store it. No value returned. */
  generate(key: string, length: number): Promise<void>;

  /** Delete an entry. */
  remove(key: string): Promise<void>;

  /** Rename/move an entry. */
  rename(from: string, to: string): Promise<void>;
}

/**
 * Static core mappings from env var names to provider-specific entry identifiers.
 * These are always present. Component mappings are added dynamically at runtime
 * via registerComponentSecrets() / deregisterComponentSecrets().
 */
export const CORE_ENV_TO_SECRET_KEY: Record<string, string> = {
  ADMIN_TOKEN:              "openpalm/admin-token",
  ASSISTANT_TOKEN:          "openpalm/assistant-token",
  OPENAI_API_KEY:           "openpalm/llm/openai-api-key",
  OPENAI_BASE_URL:          "openpalm/llm/openai-base-url",
  ANTHROPIC_API_KEY:        "openpalm/llm/anthropic-api-key",
  GROQ_API_KEY:             "openpalm/llm/groq-api-key",
  MISTRAL_API_KEY:          "openpalm/llm/mistral-api-key",
  GOOGLE_API_KEY:           "openpalm/llm/google-api-key",
  OPENVIKING_API_KEY:       "openpalm/openviking/api-key",
  MCP_API_KEY:              "openpalm/mcp/api-key",
  EMBEDDING_API_KEY:        "openpalm/embedding/api-key",
  MEMORY_AUTH_TOKEN:        "openpalm/memory/auth-token",
  MEMORY_USER_ID:           "openpalm/memory/user-id",
  OWNER_NAME:               "openpalm/owner/name",
  OWNER_EMAIL:              "openpalm/owner/email",
  OPENCODE_SERVER_PASSWORD: "openpalm/opencode-server-password",
};

/**
 * Dynamic map — starts with core mappings, extended at runtime
 * as components are installed/removed.
 */
export const ENV_TO_SECRET_KEY: Record<string, string> = { ...CORE_ENV_TO_SECRET_KEY };

/** Keys that hold actual secrets — writes require admin token. */
export const SECRET_KEYS = new Set([
  "ADMIN_TOKEN", "ASSISTANT_TOKEN",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY",
  "MISTRAL_API_KEY", "GOOGLE_API_KEY",
  "OPENVIKING_API_KEY", "MCP_API_KEY", "EMBEDDING_API_KEY",
  "MEMORY_AUTH_TOKEN", "OPENCODE_SERVER_PASSWORD",
]);

/**
 * Register component secrets from a parsed .env.schema.
 * Called when a component instance is created.
 *
 * @param instanceId - Component instance identifier (e.g., "discord-main")
 * @param sensitiveFields - Field names marked @sensitive in the component's .env.schema
 */
export function registerComponentSecrets(
  instanceId: string,
  sensitiveFields: string[],
): void {
  for (const field of sensitiveFields) {
    const secretKey = `openpalm/component/${instanceId}/${toEntryName(field)}`;
    ENV_TO_SECRET_KEY[field] = secretKey;
    SECRET_KEYS.add(field);
  }
}

/**
 * Deregister component secrets when an instance is deleted.
 */
export function deregisterComponentSecrets(
  instanceId: string,
  sensitiveFields: string[],
): void {
  for (const field of sensitiveFields) {
    delete ENV_TO_SECRET_KEY[field];
    SECRET_KEYS.delete(field);
  }
}

/** Convert an env var name to a pass entry name: DISCORD_BOT_TOKEN → discord-bot-token */
function toEntryName(envVar: string): string {
  return envVar.toLowerCase().replace(/_/g, "-");
}
```

### 2.2 — `PlaintextBackend` implementation

**File:** `packages/admin/src/lib/server/backends/plaintext-backend.ts`

The `PlaintextBackend` is the DEFAULT backend when no encrypted provider is configured. It reads and writes to the traditional plaintext `secrets.env` file in CONFIG_HOME, providing full backward compatibility.

```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { SecretBackend } from "../secret-backend.js";
import { createLogger } from "../logger.js";

const logger = createLogger("plaintext-backend");

/**
 * Plaintext secret backend — reads/writes to the traditional secrets.env file.
 *
 * This is the default backend when no encrypted provider (pass, Azure, etc.)
 * is configured. It preserves full backward compatibility with existing
 * OpenPalm installations. Users can opt into encrypted storage through the
 * setup wizard at any time.
 *
 * Security note: secrets are stored in plaintext on disk, protected only
 * by filesystem permissions (0o600). This is the same security model as
 * all OpenPalm versions prior to 0.10.0.
 */
export class PlaintextBackend implements SecretBackend {
  readonly provider = "plaintext";
  readonly capabilities = {
    generate: true,
    remove: true,
    rename: false,   // rename is complex with key=value format
    list: true,
  };

  private readonly secretsEnvPath: string;

  constructor(configHome: string) {
    this.secretsEnvPath = `${configHome}/secrets.env`;
    logger.info("plaintext backend initialized", { path: this.secretsEnvPath });
  }

  /** Parse secrets.env into a key-value map. */
  private parseEnv(): Record<string, string> {
    if (!existsSync(this.secretsEnvPath)) return {};
    const content = readFileSync(this.secretsEnvPath, "utf-8");
    const result: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key) result[key] = value;
    }
    return result;
  }

  /** Write the full env map back to disk. */
  private writeEnv(env: Record<string, string>): void {
    const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    writeFileSync(this.secretsEnvPath, lines.join("\n") + "\n", { mode: 0o600 });
  }

  async list(prefix: string): Promise<string[]> {
    const env = this.parseEnv();
    // For plaintext, "list" returns env var names — no hierarchical prefix
    return Object.keys(env).filter((k) => k.length > 0);
  }

  async exists(key: string): Promise<boolean> {
    const env = this.parseEnv();
    // Key could be env var name or pass-style path — check both
    return key in env || Object.values(env).length > 0;
  }

  async write(key: string, value: string): Promise<void> {
    logger.info("write", { key });
    const env = this.parseEnv();
    // If key is a pass-style path like "openpalm/llm/openai-api-key",
    // reverse-map it to the env var name
    const envKey = this.resolveEnvKey(key);
    env[envKey] = value;
    this.writeEnv(env);
  }

  async generate(key: string, length = 64): Promise<void> {
    if (length < 8 || length > 1024) throw new Error(`Invalid length: ${length}`);
    const value = randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
    await this.write(key, value);
  }

  async remove(key: string): Promise<void> {
    logger.info("remove", { key });
    const env = this.parseEnv();
    const envKey = this.resolveEnvKey(key);
    delete env[envKey];
    this.writeEnv(env);
  }

  async rename(_from: string, _to: string): Promise<void> {
    throw new Error("PlaintextBackend does not support rename");
  }

  /** Resolve a pass-style key path back to an env var name. */
  private resolveEnvKey(key: string): string {
    // If it looks like an env var already (UPPER_CASE), use as-is
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) return key;
    // Otherwise reverse-lookup from ENV_TO_SECRET_KEY
    const { ENV_TO_SECRET_KEY } = require("../secret-backend.js");
    for (const [envVar, secretPath] of Object.entries(ENV_TO_SECRET_KEY)) {
      if (secretPath === key) return envVar;
    }
    // Last resort: convert path to env-var-style name
    return key.split("/").pop()?.toUpperCase().replace(/-/g, "_") ?? key;
  }
}
```

### 2.3 — Backend registry and auto-detection

**File:** `packages/admin/src/lib/server/secret-backend-registry.ts`

```typescript
import type { SecretBackend } from "./secret-backend.js";
import { PassBackend } from "./backends/pass-backend.js";
import { PlaintextBackend } from "./backends/plaintext-backend.js";
import { readFileSync, existsSync } from "node:fs";
import { resolveDataHome, resolveConfigHome } from "./paths.js";
import { createLogger } from "./logger.js";

const logger = createLogger("secret-backend");

/** Map from varlock @plugin package name → backend constructor. */
const BACKEND_CONSTRUCTORS: Record<
  string,
  (dataHome: string, configHome: string) => SecretBackend
> = {
  "@varlock/pass-plugin":              (dh) => new PassBackend(dh),
  // Future backends register here:
  // "@varlock/azure-key-vault-plugin": (dh) => new AzureKvBackend(dh),
  // "@varlock/aws-secrets-plugin":     (dh) => new AwsSmBackend(dh),
  // "@varlock/1password-plugin":       (dh) => new OnePasswordBackend(dh),
};

/**
 * Detect the active secret backend by reading the @plugin() declaration
 * from the active secrets.env.schema file.
 *
 * Falls back to OPENPALM_SECRET_BACKEND env var, then to PlaintextBackend
 * (not pass — plaintext is the safe default for existing installations).
 */
function detectProvider(dataHome: string): string | null {
  // 1. Check explicit override
  const envOverride = process.env.OPENPALM_SECRET_BACKEND;
  if (envOverride && BACKEND_CONSTRUCTORS[envOverride]) {
    return envOverride;
  }

  // 2. Parse @plugin() from schema
  const schemaPath = `${dataHome}/secrets.env.schema`;
  if (existsSync(schemaPath)) {
    const content = readFileSync(schemaPath, "utf-8");
    const match = content.match(/@plugin\(([^)]+)\)/);
    if (match) {
      // Extract package name: "@varlock/pass-plugin@0.0.4" → "@varlock/pass-plugin"
      const raw = match[1].trim();
      const pkgName = raw.replace(/@[\d.]+$/, ""); // strip version suffix
      if (BACKEND_CONSTRUCTORS[pkgName]) {
        return pkgName;
      }
    }
  }

  // 3. No encrypted provider detected — fall back to PlaintextBackend
  return null;
}

let _backend: SecretBackend | null = null;

/** Get the active secret backend (lazy singleton). */
export function getSecretBackend(): SecretBackend {
  if (!_backend) {
    const dataHome = resolveDataHome();
    const configHome = resolveConfigHome();
    const provider = detectProvider(dataHome);

    if (provider === null) {
      // Default: PlaintextBackend for backward compatibility
      _backend = new PlaintextBackend(configHome);
      logger.info("secret backend initialized", { provider: "plaintext" });
    } else {
      const constructor = BACKEND_CONSTRUCTORS[provider];
      if (!constructor) {
        throw new Error(`No backend implementation for provider: ${provider}`);
      }
      _backend = constructor(dataHome, configHome);
      logger.info("secret backend initialized", { provider: _backend.provider });
    }
  }
  return _backend;
}

/** Reset backend (for testing or config change). */
export function resetSecretBackend(): void {
  _backend = null;
}
```

### 2.4 — Provider config file

**File (runtime):** `DATA_HOME/secrets/provider.json`

Written by `scripts/pass-init.sh` (or future setup tools). Read by the backend registry for provider-specific settings. When no `provider.json` exists, the system uses `PlaintextBackend`.

```json
{
  "provider": "@varlock/pass-plugin",
  "pass": {
    "storeDir": "secrets/pass-store",
    "gpgId": "user@example.com"
  }
}
```

For Azure Key Vault, the same file would look like:

```json
{
  "provider": "@varlock/azure-key-vault-plugin",
  "azureKeyVault": {
    "vaultUrl": "https://my-openpalm-vault.vault.azure.net/"
  }
}
```

The admin UI (future work) would let users choose and configure their provider through this file.

---

## Phase 3 — pass Provider (Default Encrypted Backend)

### 3.1 — `PassBackend` implementation

**File:** `packages/admin/src/lib/server/backends/pass-backend.ts`

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import type { SecretBackend } from "../secret-backend.js";
import { createLogger } from "../logger.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("pass-backend");
const PASS_TIMEOUT = 10_000;

const ENTRY_NAME_RE = /^[a-z0-9][a-z0-9\-\/]*[a-z0-9]$/;

function validateEntryName(name: string): void {
  if (!name || name.length > 200 || !ENTRY_NAME_RE.test(name)) {
    throw new Error(`Invalid entry name: ${name}`);
  }
  if (name.includes("..") || name.includes("//")) {
    throw new Error("Path traversal in entry name");
  }
}

export class PassBackend implements SecretBackend {
  readonly provider = "pass";
  readonly capabilities = {
    generate: true,
    remove: true,
    rename: true,
    list: true,
  };

  private readonly storeDir: string;
  private readonly env: Record<string, string>;

  constructor(dataHome: string) {
    this.storeDir = `${dataHome}/secrets/pass-store`;
    mkdirSync(this.storeDir, { recursive: true });

    // Build env with PASSWORD_STORE_DIR pointing to DATA_HOME location
    this.env = {
      ...process.env as Record<string, string>,
      PASSWORD_STORE_DIR: this.storeDir,
    };

    logger.info("pass backend initialized", { storeDir: this.storeDir });
  }

  private opts() {
    return { timeout: PASS_TIMEOUT, env: this.env };
  }

  async list(prefix: string): Promise<string[]> {
    validateEntryName(prefix);
    try {
      const { stdout } = await execFileAsync("pass", ["ls", prefix], this.opts());
      return parsePassTreeOutput(stdout);
    } catch {
      return [];
    }
  }

  async exists(key: string): Promise<boolean> {
    // Check for .gpg file directly — faster than pass ls
    const gpgPath = `${this.storeDir}/${key}.gpg`;
    return existsSync(gpgPath);
  }

  async write(key: string, value: string): Promise<void> {
    validateEntryName(key);
    logger.info("write", { key });
    await execFileAsync(
      "pass", ["insert", "-m", "-f", key],
      { ...this.opts(), input: value }
    );
  }

  async generate(key: string, length = 64): Promise<void> {
    validateEntryName(key);
    if (length < 8 || length > 1024) throw new Error(`Invalid length: ${length}`);
    logger.info("generate", { key, length });
    await execFileAsync(
      "pass", ["generate", "-f", key, String(length)],
      this.opts()
    );
  }

  async remove(key: string): Promise<void> {
    validateEntryName(key);
    logger.info("remove", { key });
    await execFileAsync("pass", ["rm", "-f", key], this.opts());
  }

  async rename(from: string, to: string): Promise<void> {
    validateEntryName(from);
    validateEntryName(to);
    logger.info("rename", { from, to });
    await execFileAsync("pass", ["mv", "-f", from, to], this.opts());
  }
}

/** Parse `pass ls` tree output into leaf entry paths. */
export function parsePassTreeOutput(output: string): string[] {
  const entries: string[] = [];
  const stack: { indent: number; name: string }[] = [];

  for (const line of output.split("\n")) {
    const stripped = line.replace(/[│├└─\s]+/g, " ").trim();
    if (!stripped || stripped === "Password Store") continue;
    const indent = line.search(/\S/);
    if (indent < 0) continue;

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, name: stripped });
    entries.push(stack.map((s) => s.name).join("/"));
  }

  return entries.filter((e) => !entries.some((o) => o !== e && o.startsWith(e + "/")));
}
```

### 3.2 — Compose mounts (pass-specific)

**File:** `assets/docker-compose.yml` — admin service:

```yaml
admin:
  environment:
    # ... existing ...
    GNUPGHOME: /home/node/.gnupg
    # PASSWORD_STORE_DIR is set by PassBackend at runtime, not here
  volumes:
    # ... existing CONFIG_HOME, STATE_HOME, DATA_HOME mounts ...
    # GPG agent socket (read-only)
    - ${GNUPGHOME:-${HOME}/.gnupg}/S.gpg-agent:/home/node/.gnupg/S.gpg-agent:ro
    # GPG public keyring (read-only — encrypt only, no key management)
    - ${GNUPGHOME:-${HOME}/.gnupg}/pubring.kbx:/home/node/.gnupg/pubring.kbx:ro
    - ${GNUPGHOME:-${HOME}/.gnupg}/trustdb.gpg:/home/node/.gnupg/trustdb.gpg:ro
    # Password store is inside DATA_HOME — no extra mount needed
    # (DATA_HOME is already mounted rw)
```

The pass store at `DATA_HOME/secrets/pass-store/` is already accessible through the existing `DATA_HOME` bind mount. No new mount is needed for the store itself — only the GPG agent socket and keyring.

### 3.3 — Install `pass` in admin Dockerfile

**File:** `core/admin/Dockerfile` — add `pass` to existing `apt-get install`:

```dockerfile
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     curl ca-certificates gnupg git unzip pass \
```

### 3.4 — `scripts/pass-init.sh`

Updated to target `DATA_HOME/secrets/pass-store/`:

```bash
#!/usr/bin/env bash
set -euo pipefail

DATA_HOME="${OPENPALM_DATA_HOME:-${HOME}/.local/share/openpalm}"
STORE_DIR="$DATA_HOME/secrets/pass-store"
GPG_ID="${1:-}"

if [ -z "$GPG_ID" ]; then
  echo "Usage: scripts/pass-init.sh <gpg-key-id>"
  echo "  e.g.: scripts/pass-init.sh user@example.com"
  exit 1
fi

# Initialize pass store at the OpenPalm data location
mkdir -p "$STORE_DIR"
export PASSWORD_STORE_DIR="$STORE_DIR"
pass init "$GPG_ID"

# Write provider config
mkdir -p "$DATA_HOME/secrets"
cat > "$DATA_HOME/secrets/provider.json" <<EOF
{
  "provider": "@varlock/pass-plugin",
  "pass": {
    "storeDir": "secrets/pass-store",
    "gpgId": "$GPG_ID"
  }
}
EOF

PREFIX="openpalm"

ensure_entry() {
  local entry="$1" generator="${2:-}"
  if ! pass show "$PREFIX/$entry" >/dev/null 2>&1; then
    if [ -n "$generator" ]; then
      eval "$generator" | pass insert -m "$PREFIX/$entry"
      echo "  CREATED: $PREFIX/$entry"
    else
      echo "  MISSING: $PREFIX/$entry — set with: PASSWORD_STORE_DIR=$STORE_DIR pass insert $PREFIX/$entry"
    fi
  else
    echo "       OK: $PREFIX/$entry"
  fi
}

echo ""
echo "Populating entries..."

ensure_entry "admin-token" "openssl rand -hex 16"
ensure_entry "assistant-token" "openssl rand -hex 32"
ensure_entry "memory/auth-token" "openssl rand -hex 32"

for entry in \
  "llm/openai-api-key" "llm/openai-base-url" \
  "llm/anthropic-api-key" "llm/groq-api-key" \
  "llm/mistral-api-key" "llm/google-api-key" \
  "openviking/api-key" "mcp/api-key" "embedding/api-key" \
  "memory/user-id" "owner/name" "owner/email" "opencode-server-password"; do
  ensure_entry "$entry"
done

echo ""
echo "Done. Store: $STORE_DIR"
echo "Verify: PASSWORD_STORE_DIR=$STORE_DIR pass ls $PREFIX/"
```

### 3.5 — `secrets.env.schema` (pass-backed)

```env
# OpenPalm — User Secrets Schema
#
# @plugin(@varlock/pass-plugin@0.0.4)
# @initPass(storePath=${OPENPALM_DATA_HOME}/secrets/pass-store, namePrefix=openpalm/)
# @defaultSensitive=true
# @defaultRequired=infer
# ---

# @type=string(minLength=8) @required
ADMIN_TOKEN=pass("admin-token")

# @type=string(minLength=32) @required @sensitive
ASSISTANT_TOKEN=pass("assistant-token")

# @type=string(startsWith=sk-) @sensitive
OPENAI_API_KEY=pass("llm/openai-api-key", allowMissing=true)

# @type=url @sensitive=false
OPENAI_BASE_URL=pass("llm/openai-base-url", allowMissing=true)

# @type=string @sensitive
ANTHROPIC_API_KEY=pass("llm/anthropic-api-key", allowMissing=true)

# @type=string @sensitive
GROQ_API_KEY=pass("llm/groq-api-key", allowMissing=true)

# @type=string @sensitive
MISTRAL_API_KEY=pass("llm/mistral-api-key", allowMissing=true)

# @type=string @sensitive
GOOGLE_API_KEY=pass("llm/google-api-key", allowMissing=true)

# @type=string @sensitive
OPENVIKING_API_KEY=pass("openviking/api-key", allowMissing=true)

# @type=string @sensitive
MCP_API_KEY=pass("mcp/api-key", allowMissing=true)

# @type=string @sensitive
EMBEDDING_API_KEY=pass("embedding/api-key", allowMissing=true)

# @type=enum(openai,anthropic,groq,mistral,google,ollama,litellm) @sensitive=false
SYSTEM_LLM_PROVIDER=

# @type=url @sensitive=false
SYSTEM_LLM_BASE_URL=

# @type=string @sensitive=false
SYSTEM_LLM_MODEL=

# @type=string @sensitive=false
EMBEDDING_MODEL=

# @type=integer(min=64, max=4096) @sensitive=false
EMBEDDING_DIMS=

# @type=string(minLength=32) @required @sensitive
MEMORY_AUTH_TOKEN=pass("memory/auth-token")

# @type=string @sensitive=false
MEMORY_USER_ID=pass("memory/user-id", allowMissing=true)

# @type=string @sensitive=false @required=false
OPENMEMORY_USER_ID=

# @type=string(minLength=32) @required=false @sensitive
OPENCODE_SERVER_PASSWORD=pass("opencode-server-password", allowMissing=true)

# @type=string @sensitive=false
OWNER_NAME=pass("owner/name", allowMissing=true)

# @type=email @sensitive=false
OWNER_EMAIL=pass("owner/email", allowMissing=true)
```

Note `storePath=${OPENPALM_DATA_HOME}/secrets/pass-store` in `@initPass()` — this tells the varlock plugin to read from the DATA_HOME-scoped store, not `~/.password-store`.

### 3.6 — Setup wizard integration

The setup wizard presents the encrypted secrets choice during first boot:

**Step: "Enable encrypted secrets?"**

- **Yes** — Guide the user through GPG key setup:
  1. Check if a GPG key exists (`gpg --list-keys`)
  2. If not, offer to generate one (`gpg --gen-key`)
  3. Run `pass-init.sh <gpg-id>` to initialize the pass store
  4. Write `provider.json` and `secrets.env.schema` (pass-backed)
  5. Continue with the rest of setup (ADMIN_TOKEN etc. written to pass)

- **No** — Continue with `PlaintextBackend`:
  1. No GPG setup, no pass initialization
  2. `secrets.env` is created in CONFIG_HOME as before
  3. User can opt in to encrypted storage later via `openpalm secrets init`

This ensures zero-breaking-change upgrades: existing users keep working with plaintext until they explicitly opt in. New users make an informed choice at first boot.

---

## Phase 4 — Secrets API Routes

All routes use `requireAdmin()` — assistant token is rejected.
All routes use `getSecretBackend()` — provider-agnostic.

### 4.1 — `GET/POST/DELETE /admin/secrets`

**File:** `packages/admin/src/routes/admin/secrets/+server.ts`

```typescript
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { jsonResponse, errorResponse, requireAdmin, getRequestId, getActor, getCallerType } from "$lib/server/helpers.js";
import { appendAudit } from "$lib/server/control-plane.js";
import { getSecretBackend } from "$lib/server/secret-backend-registry.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const backend = getSecretBackend();
  const prefix = event.url.searchParams.get("prefix") ?? "openpalm";
  const entries = await backend.list(prefix);

  const state = getState();
  appendAudit(state, getActor(event), "secrets.list", { prefix, provider: backend.provider }, true, requestId, getCallerType(event));
  return jsonResponse(200, {
    entries,
    provider: backend.provider,
    capabilities: backend.capabilities,
  }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const body = await event.request.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  const value = typeof body?.value === "string" ? body.value : "";
  const scope = typeof body?.scope === "string" ? body.scope.trim() : "";

  if (!key || !key.startsWith("openpalm/")) {
    return errorResponse(400, "bad_request", "Key must start with openpalm/", {}, requestId);
  }

  // Validate scope: "" (core), "component/<instance-id>", or "custom"
  if (scope && !scope.startsWith("component/") && scope !== "custom") {
    return errorResponse(400, "bad_request", "Scope must be 'component/<instance-id>' or 'custom'", {}, requestId);
  }

  const backend = getSecretBackend();
  await backend.write(key, value);

  const state = getState();
  appendAudit(state, getActor(event), "secrets.write", { key, scope, provider: backend.provider }, true, requestId, getCallerType(event));
  return jsonResponse(200, { ok: true, key }, requestId);
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const body = await event.request.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key.trim() : "";

  if (!key || !key.startsWith("openpalm/")) {
    return errorResponse(400, "bad_request", "Key must start with openpalm/", {}, requestId);
  }

  const backend = getSecretBackend();
  if (!backend.capabilities.remove) {
    return errorResponse(501, "not_supported", `${backend.provider} does not support deletion`, {}, requestId);
  }

  await backend.remove(key);

  const state = getState();
  appendAudit(state, getActor(event), "secrets.delete", { key, provider: backend.provider }, true, requestId, getCallerType(event));
  return jsonResponse(200, { ok: true, deleted: key }, requestId);
};
```

### 4.2 — `POST /admin/secrets/generate`

**File:** `packages/admin/src/routes/admin/secrets/generate/+server.ts`

```typescript
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const body = await event.request.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  const length = typeof body?.length === "number" ? body.length : 64;

  if (!key || !key.startsWith("openpalm/")) {
    return errorResponse(400, "bad_request", "Key must start with openpalm/", {}, requestId);
  }

  const backend = getSecretBackend();
  if (!backend.capabilities.generate) {
    return errorResponse(501, "not_supported", `${backend.provider} does not support generation`, {}, requestId);
  }

  await backend.generate(key, length);

  const state = getState();
  appendAudit(state, getActor(event), "secrets.generate", { key, length, provider: backend.provider }, true, requestId, getCallerType(event));
  return jsonResponse(200, { ok: true, key, length }, requestId);
};
```

---

## Phase 5 — Password Manager UI

### 5.1 — `SecretsTab.svelte`

The component adapts to the active backend's capabilities:

```
┌──────────────────────────────────────────────────────────────────┐
│  Secrets  ·  Provider: pass                                 [+]  │
├──────────────────────────────────────────────────────────────────┤
│  ▼ core/                                                         │
│    ▼ llm/                                                        │
│      openai-api-key          ●  configured   [Set] [✕]          │
│      anthropic-api-key       ○  not set      [Set] [✕]          │
│      ...                                                         │
│    ▼ memory/                                                     │
│      auth-token              ●  configured   [Set] [Gen]        │
│    admin-token               ●  configured   [Set] [Gen]        │
│    assistant-token           ●  configured   [Set] [Gen]        │
│  ▼ component/                                                    │
│    ▼ discord-main/                                               │
│      discord-bot-token       ●  configured   [Set] [✕]          │
│  ▼ custom/                                                       │
│    my-tool-api-key           ●  configured   [Set] [✕]          │
└──────────────────────────────────────────────────────────────────┘
```

**Capability-driven UI:**

- `GET /admin/secrets` returns `capabilities` in the response
- If `capabilities.generate === false`, the [Gen] button is hidden
- If `capabilities.remove === false`, the [✕] button is hidden
- The provider name is shown in the tab header

**All fetches use `x-admin-token` with the admin token** (from `AuthGate`). No secondary nonce or special headers needed.

### 5.2 — Register the tab

Add to `TabBar.svelte` after Connections.

---

## Phase 6 — Connections Endpoint Refactor

### 6.1 — `patchConnections()` uses `SecretBackend`

**File:** `packages/admin/src/routes/admin/connections/+server.ts`

```typescript
import { getSecretBackend, ENV_TO_SECRET_KEY, SECRET_KEYS } from "$lib/server/secret-backend.js";
import { identifyCallerByToken } from "$lib/server/helpers.js";

async function patchConnections(
  event: RequestEvent,
  configDir: string,
  patches: Record<string, string>,
): Promise<{ envPatched: string[]; secretsPatched: string[]; rejected: string[] }> {
  const caller = identifyCallerByToken(event);
  const backend = getSecretBackend();
  const envPatches: Record<string, string> = {};
  const secretsPatched: string[] = [];
  const rejected: string[] = [];

  for (const [envKey, value] of Object.entries(patches)) {
    if (SECRET_KEYS.has(envKey)) {
      if (caller !== "admin") {
        rejected.push(envKey);
        continue;
      }
      const secretKey = ENV_TO_SECRET_KEY[envKey];
      if (secretKey && value) {
        await backend.write(secretKey, value);
        secretsPatched.push(envKey);
      }
    } else {
      envPatches[envKey] = value;
    }
  }

  if (Object.keys(envPatches).length > 0) {
    patchSecretsEnvFile(configDir, envPatches);
  }

  return { envPatched: Object.keys(envPatches), secretsPatched, rejected };
}
```

Note: `patchConnections` calls `backend.write()`, not `insertEntry()`. It works identically regardless of the backend provider.

---

## Phase 7 — Migration Tooling

### 7.1 — `scripts/migrate-to-pass.sh`

Updated to target `DATA_HOME/secrets/pass-store/`:

```bash
#!/usr/bin/env bash
set -euo pipefail

DATA_HOME="${OPENPALM_DATA_HOME:-${HOME}/.local/share/openpalm}"
CONFIG_HOME="${OPENPALM_CONFIG_HOME:-${HOME}/.config/openpalm}"
STORE_DIR="$DATA_HOME/secrets/pass-store"
SECRETS_ENV="$CONFIG_HOME/secrets.env"

[ -f "$SECRETS_ENV" ] || { echo "No secrets.env — nothing to migrate."; exit 0; }
command -v pass >/dev/null || { echo "Error: pass not installed."; exit 1; }
[ -f "$STORE_DIR/.gpg-id" ] || { echo "Error: pass store not initialized. Run: scripts/pass-init.sh <gpg-key-id>"; exit 1; }

export PASSWORD_STORE_DIR="$STORE_DIR"

declare -A KEY_MAP=(
  [ADMIN_TOKEN]="admin-token" [ASSISTANT_TOKEN]="assistant-token"
  [OPENAI_API_KEY]="llm/openai-api-key" [OPENAI_BASE_URL]="llm/openai-base-url"
  [ANTHROPIC_API_KEY]="llm/anthropic-api-key" [GROQ_API_KEY]="llm/groq-api-key"
  [MISTRAL_API_KEY]="llm/mistral-api-key" [GOOGLE_API_KEY]="llm/google-api-key"
  [OPENVIKING_API_KEY]="openviking/api-key"
  [MCP_API_KEY]="mcp/api-key"
  [EMBEDDING_API_KEY]="embedding/api-key"
  [MEMORY_AUTH_TOKEN]="memory/auth-token" [MEMORY_USER_ID]="memory/user-id"
  [OWNER_NAME]="owner/name" [OWNER_EMAIL]="owner/email"
  [OPENCODE_SERVER_PASSWORD]="opencode-server-password"
)

migrated=0 skipped=0

while IFS='=' read -r key value; do
  [[ "$key" =~ ^[[:space:]]*# ]] && continue
  key=$(echo "$key" | xargs); value=$(echo "$value" | xargs)
  [[ -z "$key" || -z "$value" ]] && continue
  entry="${KEY_MAP[$key]:-}"; [[ -z "$entry" ]] && continue

  if pass show "openpalm/$entry" >/dev/null 2>&1; then
    echo "  SKIP: openpalm/$entry"; ((skipped++))
  else
    echo "$value" | pass insert -m "openpalm/$entry"
    echo "    OK: openpalm/$entry"; ((migrated++))
  fi
done < "$SECRETS_ENV"

mv "$SECRETS_ENV" "$SECRETS_ENV.migrated.$(date +%s)"
echo "Migrated: $migrated  Skipped: $skipped"
```

### 7.2 — CLI subcommands

All commands respect `PASSWORD_STORE_DIR=${OPENPALM_DATA_HOME}/secrets/pass-store`:

| Command | Action |
|---------|--------|
| `openpalm secrets init <gpg-id>` | `scripts/pass-init.sh <gpg-id>` |
| `openpalm secrets migrate` | `scripts/migrate-to-pass.sh` |
| `openpalm secrets ls` | `pass ls openpalm/` |
| `openpalm secrets set <entry>` | `pass insert openpalm/<entry>` |
| `openpalm secrets generate <entry>` | `pass generate openpalm/<entry> 64` |

---

## Appendix A — Provider Swap Guide

### Swapping to Azure Key Vault (example)

Two files change. No code changes.

**1. Replace `assets/secrets.env.schema`:**

```env
# @plugin(@varlock/azure-key-vault-plugin@0.0.4)
# @initAzure(vaultUrl=https://openpalm-vault.vault.azure.net/)
# @defaultSensitive=true
# @defaultRequired=infer
# ---

# @type=string(minLength=8) @required
ADMIN_TOKEN=azureSecret("openpalm-admin-token")

# @type=string(minLength=32) @required @sensitive
ASSISTANT_TOKEN=azureSecret("openpalm-assistant-token")

# @type=string(startsWith=sk-) @sensitive
OPENAI_API_KEY=azureSecret("openpalm-llm-openai-api-key", allowMissing=true)

# ... (same pattern for all keys, using Azure naming convention: hyphens, no slashes)
```

**2. Update `DATA_HOME/secrets/provider.json`:**

```json
{
  "provider": "@varlock/azure-key-vault-plugin",
  "azureKeyVault": {
    "vaultUrl": "https://openpalm-vault.vault.azure.net/"
  }
}
```

**3. Register `AzureKvBackend`** in `secret-backend-registry.ts` (one-time code addition per new provider):

```typescript
"@varlock/azure-key-vault-plugin": (dh) => new AzureKvBackend(dh),
```

The `AzureKvBackend` class implements `SecretBackend` using the Azure Key Vault REST API (`az keyvault secret set`, etc.).

### Available varlock provider plugins

| Plugin | Init Decorator | Resolver | Version |
|--------|:---:|:---:|:---:|
| `@varlock/pass-plugin` | `@initPass()` | `pass()` | 0.0.4 |
| `@varlock/azure-key-vault-plugin` | `@initAzure()` | `azureSecret()` | 0.0.4 |
| `@varlock/aws-secrets-plugin` | `@initAws()` | `awsSecret()` | 0.0.4 |
| `@varlock/1password-plugin` | `@initOp()` | `op()` | 0.2.3 |
| `@varlock/bitwarden-plugin` | `@initBw()` | `bw()` | 0.0.4 |
| `@varlock/google-secret-manager-plugin` | `@initGcp()` | `gcpSecret()` | 0.1.4 |
| `@varlock/infisical-plugin` | `@initInfisical()` | `infisical()` | 0.0.4 |

---

## Appendix B — Security Model

### Token access matrix

| Endpoint | `ADMIN_TOKEN` | `ASSISTANT_TOKEN` | Admin OpenCode Instance | No token |
|----------|:---:|:---:|:---:|:---:|
| `GET/POST/DELETE /admin/secrets` | yes | no (401) | yes (uses ADMIN_TOKEN) | no (401) |
| `POST /admin/secrets/generate` | yes | no (401) | yes (uses ADMIN_TOKEN) | no (401) |
| `POST /admin/connections` (secret keys) | yes, writes via backend | no (rejected) | yes (uses ADMIN_TOKEN) | no (401) |
| `POST /admin/connections` (config keys) | yes | yes | yes | no (401) |
| `POST /admin/setup` | yes | no (401) | yes (uses ADMIN_TOKEN) | no (401) |
| `POST /admin/install/uninstall/upgrade` | yes | no (401) | yes (uses ADMIN_TOKEN) | no (401) |
| All other `/admin/*` | yes | yes | yes | no (401) |

The admin OpenCode instance (#304) authenticates with `ADMIN_TOKEN` and has full admin-level API access. It is embedded in the admin container and is conceptually an admin agent, not the assistant. The assistant container remains isolated with only `ASSISTANT_TOKEN`.

### Why the assistant can't write secrets

The assistant receives `ASSISTANT_TOKEN` via `OPENPALM_ASSISTANT_TOKEN` env var. Secrets endpoints call `requireAdmin()` which only accepts `ADMIN_TOKEN`. The assistant does not possess `ADMIN_TOKEN` — it's not in its environment, not on disk it can access, and no endpoint returns it.

### Password manager UI invariants

- `SecretBackend` has no read/decrypt method
- No API endpoint returns decrypted secret values
- The UI never shows, stores, or reveals passwords
- Audit logs record every write/generate/delete with actor and provider

### GPG agent socket trust boundary

**Important:** When the pass backend is active, the host GPG agent socket is bind-mounted into the admin container (read-only). This means the admin container can decrypt **any** GPG-encrypted content that the host user's GPG key can decrypt — not just OpenPalm secrets. This is inherent to GPG agent forwarding and is the same trust model as SSH agent forwarding. The admin container is already the most privileged component (Docker socket access), so this does not expand the existing trust boundary in practice, but operators should be aware that GPG agent access is broad, not scoped to the OpenPalm pass store.

### Backup and restore implications

After migrating to the pass backend, the pass store (`DATA_HOME/secrets/pass-store/`) contains GPG-encrypted files. **Restoring a backup of the pass store requires the corresponding GPG private key on the restore target.** If the GPG key is lost, the encrypted secrets are irrecoverable. Operators should:

1. Back up their GPG private key separately (e.g., `gpg --export-secret-keys <key-id> > key-backup.gpg`)
2. Store the GPG key backup in a different location than the pass store backup
3. Test restore procedures periodically

The `PlaintextBackend` does not have this requirement — plaintext `secrets.env` files are self-contained and portable.

---

## Appendix C — Token Refactor Migration Checklist

### Files that change `requireAdmin` → `requireAuth`

```
- routes/admin/connections/+server.ts
- routes/admin/connections/status/+server.ts
- routes/admin/connections/test/+server.ts
- routes/admin/connections/profiles/+server.ts
- routes/admin/connections/profiles/[id]/+server.ts
- routes/admin/connections/assignments/+server.ts
- routes/admin/connections/export/mem0/+server.ts
- routes/admin/connections/export/opencode/+server.ts
- routes/admin/containers/list/+server.ts
- routes/admin/containers/up/+server.ts
- routes/admin/containers/down/+server.ts
- routes/admin/containers/restart/+server.ts
- routes/admin/containers/pull/+server.ts
- routes/admin/channels/+server.ts
- routes/admin/channels/install/+server.ts
- routes/admin/channels/uninstall/+server.ts
- routes/admin/artifacts/+server.ts
- routes/admin/artifacts/[name]/+server.ts
- routes/admin/artifacts/manifest/+server.ts
- routes/admin/audit/+server.ts
- routes/admin/automations/+server.ts
- routes/admin/config/validate/+server.ts
- routes/admin/access-scope/+server.ts
- routes/admin/memory/config/+server.ts
- routes/admin/memory/models/+server.ts
- routes/admin/memory/reset-collection/+server.ts
- routes/admin/providers/local/+server.ts
- routes/admin/registry/+server.ts
- routes/admin/registry/install/+server.ts
- routes/admin/registry/refresh/+server.ts
- routes/admin/registry/uninstall/+server.ts
- routes/admin/update/+server.ts
- routes/admin/installed/+server.ts
```

### Files that KEEP `requireAdmin`

```
- routes/admin/setup/+server.ts
- routes/admin/install/+server.ts
- routes/admin/uninstall/+server.ts
- routes/admin/upgrade/+server.ts
- routes/admin/secrets/+server.ts          (NEW)
- routes/admin/secrets/generate/+server.ts (NEW)
```

### Other changes

```
- lib/server/types.ts                    — add assistantToken
- lib/server/secrets.ts                  — generate ASSISTANT_TOKEN
- lib/server/lifecycle.ts                — load assistantToken
- lib/server/helpers.ts                  — identifyCallerByToken, requireAuth, getActor
- hooks.server.ts                        — upgrade migration
- assets/docker-compose.yml              — token routing
- assets/secrets.env.schema              — add ASSISTANT_TOKEN
- assets/redact.env.schema               — add ASSISTANT_TOKEN
- packages/assistant-tools/.../lib.ts    — OPENPALM_ASSISTANT_TOKEN
- scripts/dev-setup.sh                   — generate ASSISTANT_TOKEN
- docs + AGENTS.md                       — update references
```
