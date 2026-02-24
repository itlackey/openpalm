# Plan: Merge Compose Runners

## Current State Analysis

The codebase has three compose-related files in `packages/lib/src/`:

**File A: `compose-runner.ts` (88 lines)** -- The low-level runner. This is the correct foundation. It takes raw args and `ComposeRunOptions`, spawns `docker compose`, handles timeouts, error classification, and retries. Both CLI and admin already depend on this. Exports one function: `runCompose`.

**File B: `compose.ts` (164 lines)** -- CLI-facing convenience layer. Thin wrappers (`composeUp`, `composeDown`, `composePull`, etc.) that accept a `ComposeConfig` and delegate to `runCompose`. Every CLI command uses this through `loadComposeConfig()`. Clean, stateless, config-driven.

**File C: `admin/compose-runner.ts` (359 lines)** -- Admin-facing layer. Duplicates much of what `compose.ts` does but adds:
- 6 env-reading helper functions (lines 13-47) to resolve config from `Bun.env`/`process.env`
- A private `runCompose` wrapper (lines 51-72) that reads env vars on every call
- `parseServiceNamesFromComposeFile` (lines 74-91) -- dead code, never called
- Service allowlist logic (`allowedServiceSet`, `ensureAllowedServices`, `composeServiceNames`, `filterUiManagedServices`)
- Drift detection (`computeDriftReport`, `persistDriftReport`)
- 5 override registries with mutable module state

## Problems with the Current Admin Compose Runner

1. **Module-level mutable state**: Five separate override registries stored as `let` variables at module scope. Tests must manually set and then reset every override.
2. **Implicit configuration from env vars**: Reads 7 env vars on every call instead of accepting a config object. Behavior changes silently based on environment.
3. **Dead code**: `parseServiceNamesFromComposeFile` (lines 74-91) is defined but never called.
4. **Duplicated compose operations**: Both `compose.ts` and `admin/compose-runner.ts` have `composePull`, `composeLogs`, `composeExec`, `composePs`.
5. **`WithOverride` function proliferation**: Every compose operation has a normal version and a `WithOverride` version, doubling the API surface (lines 330-358).

## Unified Design

### Keep `compose-runner.ts` Untouched

The low-level `runCompose` in `packages/lib/src/compose-runner.ts` is already correct. It stays exactly as-is.

### New Interface: `ComposeClient`

Replace all module-level state and env-reading functions with a single class that holds config and can be injected/mocked:

```typescript
// packages/lib/src/admin/compose-client.ts

export type ComposeClientConfig = {
  bin: string;
  subcommand: string;
  composeFile: string;
  envFile?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
};

export class ComposeClient {
  constructor(private config: ComposeClientConfig) {}

  async action(action: "up" | "stop" | "restart", services: string | string[]): Promise<ComposeResult> { ... }
  async actionForFile(action: "up" | "stop" | "restart", services: string | string[], composeFile: string, envFile?: string): Promise<ComposeResult> { ... }
  async exec(service: string, args: string[]): Promise<ComposeResult> { ... }
  async pull(service?: string): Promise<ComposeResult> { ... }
  async logs(service: string, tail?: number): Promise<ComposeResult> { ... }
  async list(): Promise<ComposeResult> { ... }
  async ps(): Promise<{ ok: boolean; services: ServiceHealthState[]; stderr: string }> { ... }
  async configServices(composeFileOverride?: string): Promise<string[]> { ... }
  async configValidate(): Promise<ComposeResult> { ... }
  async configValidateForFile(composeFile: string, envFile?: string): Promise<ComposeResult> { ... }
  async stackDown(): Promise<ComposeResult> { ... }
}
```

This class:
- Accepts config via constructor (no env reads at call time)
- Has no mutable module-level state
- Is trivially mockable: tests create a mock `ComposeClient` or pass a test config
- Uses the same `runCompose` from `compose-runner.ts` internally

### Preserve Standalone Functions

The following are not compose operations -- they are service-management / domain logic. They stay as standalone functions but accept a `ComposeClient` parameter:

- `allowedServiceSet(client: ComposeClient, extraServices?: string[]): Promise<Set<string>>`
- `composeServiceNames(client: ComposeClient): Promise<string[]>`
- `filterUiManagedServices(services: string[]): string[]` (pure, no change)
- `composeLogsValidateTail(tail: number): boolean` (pure, no change)
- `computeDriftReport(client: ComposeClient, args: ...): Promise<DriftReport>`
- `persistDriftReport(report: DriftReport, reportPath?: string): void`

### Factory for Admin Context

```typescript
export function createAdminComposeClient(): ComposeClient {
  return new ComposeClient({
    bin: envValue("OPENPALM_COMPOSE_BIN") ?? "docker",
    subcommand: envValue("OPENPALM_COMPOSE_SUBCOMMAND") ?? "compose",
    composeFile: envValue("OPENPALM_COMPOSE_FILE") ?? "docker-compose.yml",
    envFile: envValue("OPENPALM_COMPOSE_ENV_FILE") ?? envValue("COMPOSE_ENV_FILE"),
    cwd: envValue("COMPOSE_PROJECT_PATH") ?? "/state",
    env: {
      DOCKER_HOST: envValue("OPENPALM_CONTAINER_SOCKET_URI") ?? "unix:///var/run/docker.sock",
      CONTAINER_HOST: envValue("OPENPALM_CONTAINER_SOCKET_URI") ?? "unix:///var/run/docker.sock",
    },
  });
}
```

### Remove the Override System

Instead of 5 override registries, tests will:
1. Construct a `ComposeClient` with test config, or
2. For stack-apply-engine tests: pass a `ComposeClient` into `applyStack` as an option

The `applyStack` signature becomes:
```typescript
export async function applyStack(
  manager: StackManager,
  options?: { apply?: boolean; rolloutMode?: RolloutMode; composeClient?: ComposeClient }
): Promise<StackApplyResult>
```

## Function-by-Function Disposition

| Function (admin/compose-runner.ts) | Action | Reason |
|---|---|---|
| `envValue` (L13) | Move to `createAdminComposeClient` | Only needed for factory |
| `composeProjectPath` (L18) | Remove | Folded into factory |
| `composeBin` (L22) | Remove | Folded into factory |
| `composeSubcommand` (L26) | Remove | Folded into factory |
| `composeFilePath` (L30) | Remove | Folded into factory |
| `composeEnvFilePath` (L34) | Remove | Folded into factory |
| `containerSocketUri` (L38) | Remove | Folded into factory |
| `extraServicesFromEnv` (L42) | Keep as standalone | Used by `allowedServiceSet` |
| `runCompose` (L51) | Remove | Replaced by `ComposeClient` methods |
| `parseServiceNamesFromComposeFile` (L74) | Delete | Dead code |
| `composeConfigServices` (L93) | `ComposeClient.configServices` | |
| `setComposeConfigServicesOverride` (L103) | Delete | Replaced by DI |
| `composeConfigServicesWithOverride` (L107) | Delete | Replaced by DI |
| `allowedServiceSet` (L112) | Keep, add `client` param | |
| `ensureAllowedServices` (L118) | Keep, add `client` param | |
| `composeConfigValidate` (L126) | `ComposeClient.configValidate` | |
| `composeConfigValidateForFile` (L130) | `ComposeClient.configValidateForFile` | |
| `composeList` (L134) | `ComposeClient.list` | |
| All `set*Override` functions | Delete | Replaced by DI |
| All `*WithOverride` functions (L330-358) | Delete | Replaced by DI |
| `CoreServices` const (L5) | Keep | |
| `UiManagedServiceExclusions` const (L9) | Keep | |

**`compose.ts` stays exactly as-is.** It serves CLI commands that construct their own `ComposeConfig` from XDG paths.

## Every File That Needs Updating

### New File

| File | Description |
|---|---|
| `packages/lib/src/admin/compose-client.ts` | New `ComposeClient` class, `createAdminComposeClient` factory, standalone functions |

### Files to Modify

| File | Changes Needed |
|---|---|
| `packages/lib/src/admin/compose-runner.ts` | Rewrite as thin re-export bridge, then eventually delete |
| `packages/lib/src/admin/stack-apply-engine.ts` (L1-14, L128-135, L236-316) | Accept `ComposeClient` in options. Replace `*WithOverride` calls with `client.method()` |
| `packages/lib/src/admin/health-gate.ts` (L3, L52-56) | Accept `ComposeClient` in `pollUntilHealthy`. Replace `composePsWithOverride()` |
| `packages/lib/src/admin/preflight-checks.ts` (L3, L86-93) | Accept `ComposeClient` in `runApplyPreflight`. Replace `composePull()` |
| `packages/ui/src/lib/server/init.ts` (L112-118) | Create/cache singleton `ComposeClient` |
| `packages/ui/src/routes/command/+server.ts` (L31-38, L164-183, L531-599) | Import from new module, use singleton client |
| `packages/ui/src/routes/containers/stop/+server.ts` | Use `ComposeClient` instance |
| `packages/ui/src/routes/containers/update/+server.ts` | Use `ComposeClient` instance |
| `packages/ui/src/routes/containers/up/+server.ts` | Use `ComposeClient` instance |
| `packages/ui/src/routes/containers/restart/+server.ts` | Use `ComposeClient` instance |
| `packages/ui/src/routes/containers/service-logs/+server.ts` | Use `ComposeClient` instance |
| `packages/ui/src/routes/stack/drift/+server.ts` | Use `ComposeClient` instance |
| `packages/ui/src/routes/setup/access-scope/+server.ts` | Use `ComposeClient` instance |
| `packages/ui/src/routes/setup/complete/+server.ts` | Use `ComposeClient` instance |

### Test Files to Update

| File | Changes Needed |
|---|---|
| `packages/lib/src/admin/compose-runner.test.ts` | Rewrite to test `ComposeClient` directly, remove override patterns |
| `packages/lib/src/admin/stack-apply-engine.test.ts` (L10, L138-470) | Replace all `setCompose*Override` calls with mock `ComposeClient` injection |
| `packages/lib/src/admin/health-gate.test.ts` (L3-33) | Replace `setComposePsOverride` with mock `ComposeClient` |

### Files That Do NOT Change

| File | Reason |
|---|---|
| `packages/lib/src/compose-runner.ts` | Foundation layer, already correct |
| `packages/lib/src/compose.ts` | CLI convenience layer, stays as-is |
| `packages/cli/src/commands/*.ts` (all) | These use `compose.ts`, not admin runner |
| `packages/cli/test/compose.test.ts` | Tests CLI `compose.ts` |

## Testability Strategy

**Before (module-level overrides):**
```typescript
setComposeRunnerOverrides({ composeAction: async () => ... });
setComposeListOverride(async () => ...);
setComposePsOverride(async () => ...);
// ... run test ...
setComposeRunnerOverrides({});  // must manually clean up
```

**After (dependency injection):**
```typescript
const mockClient = {
  action: async () => ({ ok: true, stdout: "", stderr: "" }),
  list: async () => ({ ok: true, stdout: "[]", stderr: "" }),
  ps: async () => ({ ok: true, services: [], stderr: "" }),
  configServices: async () => [],
  configValidateForFile: async () => ({ ok: true, stdout: "", stderr: "" }),
  exec: async () => ({ ok: true, stdout: "", stderr: "" }),
} as ComposeClient;

const result = await applyStack(manager, { apply: true, composeClient: mockClient });
// No cleanup needed
```

---

## Step-by-Step Implementation Order

### Phase 1: Create new module without breaking anything

1. Create `packages/lib/src/admin/compose-client.ts` with `ComposeClient` class and factory. Move standalone functions that accept `client` param.
2. Create `packages/lib/src/admin/compose-client.test.ts` -- port existing tests.
3. Run `bun test packages/lib/src/admin/compose-client.test.ts`.

### Phase 2: Update internal consumers (lib layer)

4. Update `health-gate.ts` to accept `ComposeClient` parameter.
5. Update `health-gate.test.ts` with mock `ComposeClient`.
6. Update `preflight-checks.ts` to accept `ComposeClient`.
7. Update `stack-apply-engine.ts` -- add `composeClient` to options, replace all `*WithOverride` calls.
8. Update `stack-apply-engine.test.ts` -- replace override patterns with DI.
9. Run `bun test packages/lib/src/admin/`.

### Phase 3: Update UI/admin consumers

10. Update `packages/ui/src/lib/server/init.ts` -- add lazy `getComposeClient()` singleton.
11. Update all 9 UI route files to import from new module and use singleton.
12. Run `bun run typecheck`.

### Phase 4: Bridge and cleanup

13. Rewrite `admin/compose-runner.ts` as thin re-export shim. Delete dead code and overrides.
14. Run full test suite: `bun test` and `bun run typecheck`.

### Phase 5: Final cleanup

15. Delete `admin/compose-runner.ts` once all imports are migrated.
16. Final `bun test` and `bun run typecheck`.

## Lines of Code Estimate

- **New code**: ~180 lines (`compose-client.ts`)
- **Deleted code**: ~200 lines (override registries, `*WithOverride` wrappers, dead code, env helpers)
- **Modified code**: ~150 lines across 14 files
- **Net change**: ~-170 lines
