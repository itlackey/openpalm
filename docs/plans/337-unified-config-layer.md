# Implementation Plan: Unified Configuration Layer (Issue #337)

## Summary

Consolidate OpenPalm's fragmented configuration into a single authoritative file (`config/openpalm.yaml` v4), standardize environment variables with the `OP_` prefix, and enable `openpalm start --config <file>` for single-file stack bootstrapping.

## Design Decisions

### Council Consensus

Five specialist agents (architect, security, DX, migration, testing) analyzed the codebase and converged on these decisions:

1. **StackSpec v4 is the single source of truth** for all non-secret configuration. `connections/profiles.json` is absorbed. `openpalm.yml` (the boolean-flag file) is eliminated.

2. **Vault boundary preserved strictly.** API keys, tokens, and HMAC secrets stay in vault. Non-secret config values (ports, bind addresses, UID/GID, image tags, feature flags, owner info, LLM model names) move to the StackSpec.

3. **`OP_` prefix adopted** for all OpenPalm-originated env vars. Provider-standard keys (`OPENAI_API_KEY`, etc.) keep their names. Two-phase migration: write both old and new names during deprecation window.

4. **Config-to-env derivation pipeline** reads `openpalm.yaml` and deterministically produces `vault/system.env` values. Users edit YAML, not env files.

5. **Bind addresses stay security-sensitive** — moving to config is safe but requires validation that warns on `0.0.0.0`.

6. **Owner name/email stay in vault** (PII concern from security council, overriding architect's recommendation).

### Key Disagreements Resolved

| Topic | Architect | Security | Resolution |
|-------|-----------|----------|------------|
| Owner info location | Move to config | Keep in vault (PII) | **Keep in vault** — PII trumps convenience |
| Base URLs | Move to config | Keep in vault (can embed creds) | **Keep in vault** — `SYSTEM_LLM_BASE_URL` can contain auth tokens in path |
| OP_ prefix for API keys | Rename to `OP_KEY_*` | Keep provider-standard names | **Keep standard names** — interoperability with ecosystem tools |
| Bind address move | Move to config | Move with warnings | **Move to config with validation** — warn on public-facing values |
| ADMIN_TOKEN rename timing | Rename now | Defer (high-risk, low-value) | **Rename now with dual-write** — the whole point of #337 is standardization |

---

## Phase 1: StackSpec v4 Type & Parser

### New Type Definition

```typescript
// packages/lib/src/control-plane/stack-spec.ts

export type StackSpecV4 = {
  version: 4;

  // ── Connections (absorbed from profiles.json) ──────────────────
  connections: StackSpecConnection[];
  assignments: StackSpecAssignments;

  // ── Feature flags (absorbed from openpalm.yml + system.env) ───
  features?: {
    ollama?: boolean;    // default: false
    admin?: boolean;     // default: true
  };

  // ── Infrastructure (moved from system.env non-secrets) ────────
  ports?: {
    ingress?: number;      // default: 3080
    assistant?: number;    // default: 3800
    admin?: number;        // default: 3880
    adminOpencode?: number;// default: 3881
    scheduler?: number;    // default: 3897
    memory?: number;       // default: 3898
    guardian?: number;     // default: 3899
    assistantSsh?: number; // default: 2222
  };

  network?: {
    bindAddress?: string;  // default: "127.0.0.1" (LAN-first)
  };

  image?: {
    namespace?: string;    // default: "openpalm"
    tag?: string;          // default: "latest"
  };

  runtime?: {
    uid?: number;          // default: process.getuid()
    gid?: number;          // default: process.getgid()
    dockerSock?: string;   // default: "/var/run/docker.sock"
  };

  // ── Memory (userId moved from user.env) ────────────────────────
  memory?: {
    userId?: string;       // default: "default_user"
  };

  // ── Channels & services (carried from v3) ─────────────────────
  channels?: Record<string, StackSpecChannelConfig | boolean>;
  services?: Record<string, StackSpecServiceConfig | boolean>;

  // ── Voice (carried from v3) ───────────────────────────────────
  voice?: { tts?: string; stt?: string };
};
```

### Connection types (enhanced from v3)

```typescript
export type StackSpecConnection = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  kind?: "openai_compatible_remote" | "openai_compatible_local" | "ollama_local";
  auth?: {
    mode: "api_key" | "none";
    secretRef?: string; // e.g., "env:OPENAI_API_KEY"
  };
};

export type StackSpecAssignments = {
  llm: { connectionId: string; model: string; smallModel?: string };
  embeddings: { connectionId: string; model: string; dims?: number };
  reranking?: { enabled: boolean; connectionId?: string; mode?: string; model?: string; topK?: number; topN?: number };
  tts?: { enabled: boolean; connectionId?: string; model?: string; voice?: string; format?: string };
  stt?: { enabled: boolean; connectionId?: string; model?: string; language?: string };
};
```

### Read/Write with auto-upgrade

```typescript
export function readStackSpec(configDir: string): StackSpecV4 | null {
  // Try .yaml first, fall back to .yml (fix the longstanding inconsistency)
  // If version === 3, auto-upgrade in memory via upgradeV3ToV4InMemory()
  // If version === 4, return as-is
  // Otherwise return null
}
```

### Files to create/modify

| File | Action |
|------|--------|
| `packages/lib/src/control-plane/stack-spec.ts` | Modify: add v4 types, update readStackSpec with auto-upgrade |
| `packages/lib/src/control-plane/stack-spec.test.ts` | Create: ~20 unit tests for v4 parsing |

---

## Phase 2: Config-to-Env Derivation Pipeline

### New module: `spec-to-env.ts`

Pure function that reads a StackSpec v4 and produces the env vars that `system.env` needs:

```typescript
export function deriveSystemEnvFromSpec(
  spec: StackSpecV4,
  homeDir: string
): Record<string, string> {
  // Returns OP_* keys + legacy OPENPALM_* aliases (dual-write)
  // Returns derived values: SYSTEM_LLM_PROVIDER, SYSTEM_LLM_MODEL, etc.
  // Does NOT include secrets (tokens, API keys, HMAC)
}
```

### Updated `writeSystemEnv`

1. Read the StackSpec
2. Call `deriveSystemEnvFromSpec()`
3. Merge with existing secrets (tokens, channel HMAC)
4. Write the combined result

### Updated `isOllamaEnabled` / `isAdminEnabled`

Replace the regex-based `.yml` reader with `readStackSpec()?.features?.ollama` etc., with legacy fallback.

### Files to create/modify

| File | Action |
|------|--------|
| `packages/lib/src/control-plane/spec-to-env.ts` | Create: pure derivation function |
| `packages/lib/src/control-plane/spec-to-env.test.ts` | Create: ~15 unit tests |
| `packages/lib/src/control-plane/staging.ts` | Modify: replace `isOllamaEnabled`/`isAdminEnabled` regex readers, update `writeSystemEnv` |

---

## Phase 3: OP_ Prefix Standardization

### Env var compatibility layer

```typescript
// packages/lib/src/control-plane/env-compat.ts
export const ENV_ALIASES: [newName: string, oldName: string][] = [
  ["OP_HOME", "OPENPALM_HOME"],
  ["OP_ADMIN_TOKEN", "OPENPALM_ADMIN_TOKEN"],
  ["OP_ASSISTANT_TOKEN", "ASSISTANT_TOKEN"],
  ["OP_MEMORY_TOKEN", "MEMORY_AUTH_TOKEN"],
  // ... full mapping
];

export function resolveEnv(newName: string): string | undefined;
export function dualWriteEnvPair(newName: string, value: string): Record<string, string>;
```

### Compose file updates

All `assets/*.yml` compose files updated to use `${OP_*:-${OPENPALM_*}}` pattern where supported, or rely on dual-write in `system.env`.

### Full mapping table

| New (OP_) | Old | Category |
|-----------|-----|----------|
| `OP_HOME` | `OPENPALM_HOME` | Path |
| `OP_ADMIN_TOKEN` | `OPENPALM_ADMIN_TOKEN` | Secret |
| `OP_ASSISTANT_TOKEN` | `ASSISTANT_TOKEN` | Secret |
| `OP_MEMORY_TOKEN` | `MEMORY_AUTH_TOKEN` | Secret |
| `OP_OPENCODE_PASSWORD` | `OPENCODE_SERVER_PASSWORD` | Secret |
| `OP_CHANNEL_*_SECRET` | `CHANNEL_*_SECRET` | Secret |
| `OP_UID` | `OPENPALM_UID` | Runtime |
| `OP_GID` | `OPENPALM_GID` | Runtime |
| `OP_DOCKER_SOCK` | `OPENPALM_DOCKER_SOCK` | Runtime |
| `OP_IMAGE_NAMESPACE` | `OPENPALM_IMAGE_NAMESPACE` | Image |
| `OP_IMAGE_TAG` | `OPENPALM_IMAGE_TAG` | Image |
| `OP_INGRESS_PORT` | `OPENPALM_INGRESS_PORT` | Network |
| `OP_ASSISTANT_PORT` | `OPENPALM_ASSISTANT_PORT` | Network |
| `OP_ADMIN_PORT` | `OPENPALM_ADMIN_PORT` | Network |
| `OP_SCHEDULER_PORT` | `OPENPALM_SCHEDULER_PORT` | Network |
| `OP_MEMORY_PORT` | `OPENPALM_MEMORY_PORT` | Network |
| `OP_GUARDIAN_PORT` | `OPENPALM_GUARDIAN_PORT` | Network |
| `OP_INGRESS_BIND` | `OPENPALM_INGRESS_BIND_ADDRESS` | Network |
| `OP_SETUP_COMPLETE` | `OPENPALM_SETUP_COMPLETE` | Flag |
| `OP_OLLAMA_ENABLED` | `OPENPALM_OLLAMA_ENABLED` | Flag |
| `OP_ADMIN_ENABLED` | `OPENPALM_ADMIN_ENABLED` | Flag |

Provider-standard keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) are **NOT renamed**.

### Files to create/modify

| File | Action |
|------|--------|
| `packages/lib/src/control-plane/env-compat.ts` | Create: alias resolution + dual-write |
| `packages/lib/src/control-plane/env-compat.test.ts` | Create: ~10 unit tests |
| `packages/lib/src/control-plane/home.ts` | Modify: use `resolveEnv("OP_HOME")` |
| `packages/lib/src/control-plane/lifecycle.ts` | Modify: use `resolveEnv` for token loading |
| `packages/lib/src/control-plane/secrets.ts` | Modify: use new key names + dual-write |
| `packages/lib/src/control-plane/staging.ts` | Modify: use new key names in `generateFallbackSystemEnv` |
| `packages/lib/src/control-plane/setup-status.ts` | Modify: use `OP_SETUP_COMPLETE` |
| `core/guardian/src/server.ts` | Modify: use `OP_ADMIN_TOKEN` with fallback |
| `packages/scheduler/src/server.ts` | Modify: use `OP_ADMIN_TOKEN` with fallback |
| `assets/docker-compose.yml` | Modify: update all env var references |
| `assets/admin.yml` | Modify: update env var references |
| `assets/ollama.yml` | Modify: update env var references |
| `assets/system.env.schema` | Modify: add OP_* vars, deprecation notes |
| `assets/user.env.schema` | Modify: update where applicable |
| `packages/cli/src/lib/env.ts` | Modify: use new key names |
| `packages/admin-tools/opencode/tools/lib.ts` | Modify: use OP_ADMIN_TOKEN |

---

## Phase 4: Connection Profile Consolidation

### Merge profiles.json into StackSpec

The CRUD functions in `connection-profiles.ts` are rebacked to read/write `openpalm.yaml`:

```typescript
export function listConnectionProfiles(configDir: string): StackSpecConnection[] {
  return readStackSpec(configDir)?.connections ?? [];
}

export function upsertConnectionProfile(configDir: string, profile: StackSpecConnection): MutationResult;
export function deleteConnectionProfile(configDir: string, id: string): MutationResult;
export function getCapabilityAssignments(configDir: string): StackSpecAssignments | null;
export function saveCapabilityAssignments(configDir: string, assignments: StackSpecAssignments): MutationResult;
```

### Backward-compatible shim

`readConnectionProfilesDocument()` returns data from the StackSpec in the old `CanonicalConnectionsDocument` shape for one release cycle.

### Files to modify

| File | Action |
|------|--------|
| `packages/lib/src/control-plane/connection-profiles.ts` | Modify: reback to StackSpec |
| `packages/lib/src/control-plane/setup.ts` | Modify: write v4 spec with connections, remove separate `writeConnectionsDocument` call |
| Admin connection API routes (6+ files) | Modify: update to new profile API |

---

## Phase 5: Migration v3 → v4

### New module: `migration.ts`

```typescript
export function migrateV3ToV4(state: ControlPlaneState): MigrationResult {
  // 1. Snapshot current state for rollback
  // 2. Read all v3 sources (openpalm.yaml, openpalm.yml, profiles.json, system.env, user.env)
  // 3. Merge into a v4 StackSpec
  // 4. Write v4 spec to config/openpalm.yaml
  // 5. Update system.env with OP_* keys + legacy aliases
  // 6. Archive consumed files (.v3.bak)
  // 7. Remove non-secret config keys from user.env (SYSTEM_LLM_*, EMBEDDING_*, MEMORY_USER_ID)
}
```

### Auto-upgrade on read

`readStackSpec()` transparently upgrades v3 to v4 in memory. Explicit `migrateV3ToV4()` persists the upgrade.

### CLI command

`openpalm config migrate` — runs migration with user confirmation. `openpalm config migrate --dry-run` shows planned changes.

### Files to create/modify

| File | Action |
|------|--------|
| `packages/lib/src/control-plane/migration.ts` | Create: v3→v4 migration function |
| `packages/lib/src/control-plane/migration.test.ts` | Create: ~25 unit tests with fixtures |
| `packages/lib/src/control-plane/rollback.ts` | Modify: fix SNAPSHOT_FILES (.yml → .yaml), add profiles.json |
| `packages/lib/src/index.ts` | Modify: export new modules |

---

## Phase 6: Non-Secret Config Extraction from user.env

### Values removed from user.env

These values are now derived from the StackSpec via the derivation pipeline:

- `SYSTEM_LLM_PROVIDER` → derived from `spec.connections[spec.assignments.llm.connectionId].provider`
- `SYSTEM_LLM_BASE_URL` → keep in vault (can embed creds — security council ruling)
- `SYSTEM_LLM_MODEL` → derived from `spec.assignments.llm.model`
- `EMBEDDING_MODEL` → derived from `spec.assignments.embeddings.model`
- `EMBEDDING_DIMS` → derived from `spec.assignments.embeddings.dims`
- `MEMORY_USER_ID` → derived from `spec.memory.userId`
- `OPENMEMORY_USER_ID` → eliminated (legacy alias)

### Values that stay in user.env

- All `*_API_KEY` values (secrets)
- `SYSTEM_LLM_BASE_URL` (can embed creds)
- `OPENAI_BASE_URL` (can embed creds)
- `OWNER_NAME`, `OWNER_EMAIL` (PII)
- `STT_*`, `TTS_*` channel contract vars (consumed by voice channel)

### Files to modify

| File | Action |
|------|--------|
| `packages/lib/src/control-plane/secrets.ts` | Modify: update ALLOWED_CONNECTION_KEYS, PLAIN_CONFIG_KEYS |
| `packages/lib/src/control-plane/setup.ts` | Modify: don't write eliminated keys to user.env |
| Admin connection save routes | Modify: don't write eliminated keys to user.env |

---

## Phase 7: Spec Validator

### New module: `spec-validator.ts`

```typescript
export type ValidationError = {
  code: string;     // e.g., "OP-CFG-003"
  message: string;
  path?: string;    // e.g., "assignments.llm.connectionId"
  hint?: string;
};

export function validateStackSpecV4(spec: unknown): ValidationError[];
```

### Validation rules

- `version` must be 4
- `connections` must be a non-empty array
- Each connection must have `id`, `name`, `provider`
- Connection IDs must be unique and match `/^[a-z0-9][a-z0-9-]{0,62}$/`
- `assignments.llm` and `assignments.embeddings` are required
- `assignments.*.connectionId` must reference an existing connection
- `ports.*` must be integers 1-65535
- `network.bindAddress` must be a valid IP; warn if `0.0.0.0`
- `image.namespace` must match `/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/`

### Files to create

| File | Action |
|------|--------|
| `packages/lib/src/control-plane/spec-validator.ts` | Create: validation function |
| `packages/lib/src/control-plane/spec-validator.test.ts` | Create: ~20 unit tests |

---

## Phase 8: Setup Flow Update

### performSetup writes v4

`performSetup()` in `setup.ts` is updated to:
1. Build a v4 StackSpec from SetupInput (connections embedded directly)
2. Write to `config/openpalm.yaml`
3. Write only secrets to vault files
4. Remove separate `writeConnectionsDocument()` call
5. Remove `data/stack.env` write (setup-complete flag goes to system.env only)

### SetupConfig/SetupInput alignment

`SetupConfig` (the `--file` install format) becomes a thin wrapper over StackSpec v4, adding only the `security.adminToken` field that can't go in YAML.

### Files to modify

| File | Action |
|------|--------|
| `packages/lib/src/control-plane/setup.ts` | Modify: write v4 spec, eliminate redundant writes |
| `packages/cli/src/commands/install.ts` | Modify: support `--config` flag (alias for `--file`) |
| `packages/cli/src/setup-wizard/server.ts` | Modify: wizard produces v4-compatible config |

---

## Phase 9: Admin API Updates

### Updated routes

| Route | Change |
|-------|--------|
| `GET /admin/connections` | Read from StackSpec instead of profiles.json + user.env |
| `POST /admin/connections` | Write to StackSpec + vault (secrets only) |
| `GET /admin/connections/profiles` | Read from StackSpec |
| `POST/PUT/DELETE /admin/connections/profiles` | Write to StackSpec |
| `GET/POST /admin/connections/assignments` | Read/write StackSpec assignments |
| `GET /admin/connections/status` | Derive from StackSpec (not env vars) |

### Files to modify

All files under `packages/admin/src/routes/admin/connections/`.

---

## Phase 10: Test Updates

### New test files (~105 new tests)

| File | Tests |
|------|-------|
| `packages/lib/src/control-plane/stack-spec.test.ts` | ~20: v4 parsing, round-trip, edge cases |
| `packages/lib/src/control-plane/spec-to-env.test.ts` | ~15: derivation correctness |
| `packages/lib/src/control-plane/env-compat.test.ts` | ~10: alias resolution, dual-write |
| `packages/lib/src/control-plane/spec-validator.test.ts` | ~20: validation rules |
| `packages/lib/src/control-plane/migration.test.ts` | ~25: v3→v4 scenarios |
| `packages/lib/src/control-plane/home.test.ts` | ~15: path resolution, legacy detection |

### Existing tests to update

| File | Change |
|------|--------|
| `install-edge-cases.test.ts` | Update version expectations (3→4) |
| `setup.test.ts` | Update StackSpec assertions |
| `lifecycle.test.ts` | Update env var names |
| `staging-core.test.ts` | Update system.env assertions |
| `connection-profiles.test.ts` | Reback to StackSpec storage |
| `secrets.test.ts` | Update ALLOWED_CONNECTION_KEYS |

---

## Implementation Order

The phases are ordered by dependency. Each phase should be a separate commit.

```
Phase 1: StackSpec v4 types + parser (foundation)
    ↓
Phase 2: Config-to-env derivation (uses v4 types)
    ↓
Phase 3: OP_ prefix + env-compat layer (uses derivation)
    ↓
Phase 4: Connection profile consolidation (uses v4 types)
    ↓
Phase 5: Migration v3→v4 (uses all of the above)
    ↓
Phase 6: Non-secret extraction from user.env (uses migration)
    ↓
Phase 7: Spec validator (uses v4 types)
    ↓
Phase 8: Setup flow update (uses v4, derivation, profiles)
    ↓
Phase 9: Admin API updates (uses all)
    ↓
Phase 10: Test updates (validates everything)
```

## Delivery Checklist

- [ ] `bun run check` passes (svelte-check + sdk tests)
- [ ] `bun run test` passes (all non-admin unit tests)
- [ ] `bun run admin:test:unit` passes
- [ ] `bun run admin:test:e2e:mocked` passes
- [ ] No new secrets leak through config tier
- [ ] Vault boundary preserved (API keys + tokens in vault only)
- [ ] Backward compatibility: v3 StackSpec auto-upgraded on read
- [ ] Backward compatibility: OPENPALM_* env vars still work (dual-write)
- [ ] Core principles compliance verified
