# Plan: Consolidate Preflight Checks

## Summary

There are two separate preflight check systems in OpenPalm:

**System A -- CLI install-time preflight** (`packages/lib/src/preflight.ts`, 210 lines): Runs once during `openpalm install`. Checks disk space, port 80, and Docker daemon status. Also provides guidance text when no runtime or compose is found. This is valuable first-boot troubleshooting and should be **kept entirely**.

**System B -- Admin per-apply preflight** (`packages/lib/src/admin/preflight-checks.ts`, 113 lines): Runs before **every** `applyStack()` call. Contains five checks that are either redundant, fragile, or conflate validation with execution. This should be **removed**.

## Analysis of Each Check in Admin Preflight

| Check | Function | Lines | Verdict | Reasoning |
|-------|----------|-------|---------|-----------|
| Docker socket exists | `checkDockerSocket()` | 32-53 | **Remove** | Docker itself will report "Cannot connect to the Docker daemon" when compose commands fail. The `applyStack()` function immediately calls `composeConfigValidateForFileWithOverride()` which will surface the same failure with Docker's own error message. |
| Port availability | `checkPortsAvailable()` | 55-71 | **Remove** | Uses `ss -tln` which is Linux-only (fragile). Docker reports "Bind for 0.0.0.0:80: address already in use" which is clearer and works on all platforms. |
| Writable mounts | `checkWritableMounts()` | 73-84 | **Remove** | Checks writability of `stateRootPath`, `caddyJsonPath`, `composeFilePath`, `systemEnvPath`. But `applyStack()` at line 256 calls `manager.renderArtifactsToTemp()` which writes to those exact paths -- if they are not writable, that call fails with a clear filesystem error. |
| Disk space | `checkDiskSpace()` (imported from `preflight.ts`) | 109 | **Preserve as optional warning** | This is the one check with genuine value -- disk space is a silent failure mode. However, it should become a non-blocking warning rather than part of a hard-fail preflight gate. Optional and low priority. |
| Image pulls | `checkImageAvailability()` | 86-93 | **Remove** | Pulling images is the deployment itself, not a pre-check. `compose up` pulls images as needed. Pulling ahead of time adds latency and duplicates work. |
| Port extraction | `extractPublishedPorts()` | 10-30 | **Remove** | Only consumed by `checkPortsAvailable()`. No other callers. |

## Genuinely Useful Checks to Preserve

Only one: **disk space**. The `checkDiskSpace()` function lives in `packages/lib/src/preflight.ts` (the install-time preflight, being kept). If a disk-space warning is wanted in the apply path, it can be called directly as a non-blocking warning -- but this is optional and low priority.

## Complete Consumer Map

### Files that import from `preflight-checks.ts` (System B -- to be removed):

| File | Line | Import/Usage |
|------|------|-------------|
| `packages/lib/src/admin/stack-apply-engine.ts` | 18 | `import { runApplyPreflight } from "./preflight-checks.ts"` |
| `packages/lib/src/admin/stack-apply-engine.ts` | 240-251 | Calls `runApplyPreflight()`, throws on failures, pushes warnings |

### Files that consume `StackApplyResult.preflightWarnings`:

| File | Line | Usage |
|------|------|-------|
| `packages/lib/src/admin/stack-apply-engine.ts` | 27 | Type definition: `preflightWarnings?: string[]` |
| `packages/lib/src/admin/stack-apply-engine.ts` | 226 | Initializes: `const preflightWarnings: string[] = []` |
| `packages/lib/src/admin/stack-apply-engine.ts` | 251 | Populates: `preflightWarnings.push(...preflight.warnings)` |
| `packages/lib/src/admin/stack-apply-engine.ts` | 349 | Returns: `{ ok: true, generated, impact, warnings, preflightWarnings }` |
| `packages/ui/src/routes/stack/apply/+server.ts` | 13 | Passes result to `json(200, result)` |
| `packages/ui/src/routes/setup/complete/+server.ts` | 26 | Passes result as `apply: applyResult` |
| `packages/ui/src/routes/command/+server.ts` | 136 | Returns as `data: result` for `stack.apply` command |
| `packages/ui/src/routes/command/+server.ts` | 292 | Returns as `apply: applyResult` for `setup.complete` command |

### Files using `OPENPALM_PREFLIGHT_SKIP_*` env vars (test workarounds):

| File | Line | Variable |
|------|------|----------|
| `packages/lib/src/admin/stack-apply-engine.test.ts` | 13-23 | `withSkippedDockerSocketCheck()` sets env to bypass socket check |
| `packages/lib/src/admin/stack-apply-engine.test.ts` | 25-35 | `withDisabledPortCheck()` sets `OPENPALM_PREFLIGHT_SKIP_PORT_CHECKS=1` |
| `packages/ui/e2e/env.ts` | 100-101 | Sets both `OPENPALM_PREFLIGHT_SKIP_DOCKER_CHECKS=1` and `OPENPALM_PREFLIGHT_SKIP_PORT_CHECKS=1` |
| `test/docker/docker-stack.docker.ts` | 160-161 | Sets both skip env vars |
| `dev/docs/testing-plan.md` | 65-66 | Documents both skip env vars |

---

## Step-by-Step Implementation Order

### Step 1: Delete the admin preflight-checks module

Delete `packages/lib/src/admin/preflight-checks.ts` entirely (113 lines).

This removes exports: `PreflightFailure`, `PreflightResult`, `extractPublishedPorts()`, `checkDockerSocket()`, `checkPortsAvailable()`, `checkWritableMounts()`, `checkImageAvailability()`, `runApplyPreflight()`.

### Step 2: Update `stack-apply-engine.ts` to remove preflight integration

File: `packages/lib/src/admin/stack-apply-engine.ts`

1. **Remove import** (line 18): Delete `import { runApplyPreflight } from "./preflight-checks.ts";`
2. **Remove `preflightWarnings` from `StackApplyResult`** (line 27): Delete `preflightWarnings?: string[];`
3. **Remove preflight call block** (lines 226, 240-251): Remove `const preflightWarnings: string[] = [];` and the entire preflight block.
4. **Remove from return value** (line 349): Remove `preflightWarnings` from the return object.

### Step 3: Update test file for `stack-apply-engine`

File: `packages/lib/src/admin/stack-apply-engine.test.ts`

1. **Remove `withSkippedDockerSocketCheck()` helper** (lines 13-23)
2. **Remove `withDisabledPortCheck()` helper** (lines 25-35)
3. **Remove all calls to these helpers in tests** (lines 218-219, 253-254, 270-271, 319-320, 357-358, 405-406): Every test in `applyStack` blocks begins with these workarounds and ends with cleanup calls. Remove all six pairs.

### Step 4: Update E2E test environment configuration

File: `packages/ui/e2e/env.ts`

Remove lines 100-101:
```typescript
OPENPALM_PREFLIGHT_SKIP_DOCKER_CHECKS: '1',
OPENPALM_PREFLIGHT_SKIP_PORT_CHECKS: '1',
```

### Step 5: Update Docker stack integration test

File: `test/docker/docker-stack.docker.ts`

Remove lines 160-161 (the skip env vars).

### Step 6: Update testing documentation

File: `dev/docs/testing-plan.md`

Remove lines 65-66 documenting the skip env vars.

### Step 7: Verify no leftover references

Search for: `preflight-checks`, `OPENPALM_PREFLIGHT_SKIP_DOCKER_CHECKS`, `OPENPALM_PREFLIGHT_SKIP_PORT_CHECKS`, `runApplyPreflight`, `PreflightFailure`, `preflightWarnings`, `extractPublishedPorts`.

### Step 8: Run the full test suite

```bash
bun run typecheck
bun test
```

## Files NOT Changed

- `packages/lib/src/preflight.ts` -- CLI install-time preflight. Kept entirely.
- `packages/lib/src/index.ts` -- Still re-exports `preflight.ts`. No change.
- `packages/cli/src/commands/install.ts` -- Still uses `runPreflightChecks`. No change.
- `packages/cli/src/commands/preflight.ts` -- Dev-only directory check. Unrelated.

## Risk Assessment

**Risk: Low.** The admin preflight is a validation-only layer. Removing it means Docker itself becomes the source of truth for infrastructure errors. Docker's error messages are clear and actionable. The `preflightWarnings` field was already optional, so removing it from responses is backward-compatible.

## Net Impact

- **Lines removed**: ~177 (113 module + 30 engine block + 30 test helpers + 4 env vars)
- **Lines added**: 0
- **Test helpers eliminated**: 2 (`withSkippedDockerSocketCheck`, `withDisabledPortCheck`)
- **Environment variables eliminated**: 2 (`OPENPALM_PREFLIGHT_SKIP_DOCKER_CHECKS`, `OPENPALM_PREFLIGHT_SKIP_PORT_CHECKS`)
- **Modules deleted**: 1 (`packages/lib/src/admin/preflight-checks.ts`)
