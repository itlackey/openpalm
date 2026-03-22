# TypeScript Static Analysis Report

Date: 2026-03-21

This report covers all TypeScript-bearing workspaces in the repository. It combines:

- AKM-discovered `fta-code-quality` guidance, using `npx -y fta-cli <path> --json`
- Project-native static checks such as `npm run check`
- `tsc --noEmit` runs for packages with `tsconfig.json`
- Ad hoc `tsc --noEmit` runs for TypeScript packages that do not yet define a dedicated type-check configuration
- A repository scan for `@ts-ignore`, `@ts-expect-error`, and explicit `any` usage

## Scope

Analyzed workspaces:

- `packages/admin`
- `packages/lib`
- `packages/memory`
- `packages/scheduler`
- `packages/channel-slack`
- `packages/channel-voice`
- `packages/cli`
- `core/guardian`
- `core/memory`
- `packages/channels-sdk`
- `packages/channel-discord`
- `packages/channel-api`
- `packages/channel-chat`
- `packages/assistant-tools`
- `packages/admin-tools`

## Executive Summary

- `packages/admin`, `packages/lib`, `packages/channels-sdk`, `packages/channel-api`, and `packages/channel-chat` pass the static checks used in this review.
- The most urgent type failures are in `core/guardian`, `packages/cli`, `packages/memory`, `core/memory`, `packages/channel-slack`, `packages/channel-discord`, `packages/assistant-tools`, `packages/admin-tools`, and `packages/scheduler`.
- Nine TypeScript workspaces still lack a dedicated `tsconfig.json`, forcing ad hoc analysis commands and hiding package-specific compiler intent.
- Maintainability risk is concentrated in a small set of very large files, especially `packages/cli/src/setup-wizard/wizard.js`, `packages/lib/src/control-plane/setup.ts`, `packages/assistant-tools/opencode/plugins/memory-context.ts`, and `packages/admin/src/lib/api.ts`.
- Type suppressions are currently concentrated in `packages/admin/src/lib/server/vite-asset-provider.ts`; explicit `any` usage appears mostly in tests, but a few runtime files still rely on it.

## Commands Used

Project-native checks:

```bash
cd packages/admin && npm run check
cd packages/lib && bunx tsc --noEmit -p tsconfig.json
cd packages/memory && bunx tsc --noEmit -p tsconfig.json
cd packages/scheduler && bunx tsc --noEmit -p tsconfig.json
cd packages/channel-slack && bunx tsc --noEmit -p tsconfig.json
cd packages/channel-voice && bun run typecheck
```

Ad hoc checks for packages without a dedicated `tsconfig.json`:

```bash
bunx tsc --noEmit --skipLibCheck --allowImportingTsExtensions --module ESNext --moduleResolution bundler --target ESNext --types bun-types,node <entrypoint>
```

FTA maintainability analysis:

```bash
npx -y fta-cli <workspace> --json
```

## Static Check Status By Workspace

| Workspace | Result | Notes |
|---|---|---|
| `packages/admin` | Pass | `npm run check` succeeded with 0 errors / 0 warnings |
| `packages/lib` | Pass | `bunx tsc --noEmit -p tsconfig.json` succeeded |
| `packages/memory` | Fail | Production source and tests fail type-check |
| `packages/scheduler` | Fail | Test mocks are incompatible with current `fetch` typing |
| `packages/channel-slack` | Fail | Source and tests fail type-check |
| `packages/channel-voice` | Pass with normalized TS flags | Native `typecheck` surfaced Bun typing duplication noise; source itself passed under normalized `tsc` flags |
| `packages/cli` | Fail | Setup wizard static asset typing issues |
| `core/guardian` | Fail | Discriminated union narrowing issue in ingress validation path |
| `core/memory` | Fail | Inherits `packages/memory` SQLite binding typing issue |
| `packages/channels-sdk` | Pass | Ad hoc `tsc` run succeeded |
| `packages/channel-discord` | Fail | Unsafe cast from Discord member shape to record |
| `packages/channel-api` | Pass | Ad hoc `tsc` run succeeded |
| `packages/channel-chat` | Pass | Ad hoc `tsc` run succeeded |
| `packages/assistant-tools` | Fail | Plugin contract and tool definition typing errors |
| `packages/admin-tools` | Fail | Tool definitions do not satisfy current plugin typings |

## High-Priority Type Failures

### 1. Guardian ingress validation union is not narrowing cleanly

Affected code:

- `core/guardian/src/server.ts:467`
- `core/guardian/src/server.ts:468`

Observed issue:

- `validation.error` is accessed after `if (!validation.ok)`, but TypeScript still reports that `ValidationResult` might be the success branch.

Why this matters:

- This is security-sensitive ingress code. Any ambiguity in validation control flow should be removed explicitly.

Recommended action:

- Refine the `ValidationResult` type and `validatePayload()` return shape so `ok` is a reliable discriminator.
- If needed, extract the error branch into a helper that accepts only the failure variant.

### 2. CLI setup wizard static assets are not typed correctly

Affected code:

- `packages/cli/src/setup-wizard/server.ts:134`
- `packages/cli/src/setup-wizard/server.ts:307`
- `packages/cli/src/setup-wizard/server.ts:308`
- `packages/cli/src/setup-wizard/server.ts:309`

Observed issues:

- `WIZARD_HTML` is inferred as `HTMLBundle`, which TypeScript does not accept as `BodyInit` for `new Response()`.
- `./wizard.css` has no corresponding module declaration under the current check setup.

Why this matters:

- The setup wizard is a key entry point, and the current package has no dedicated type-check config to express Bun import semantics.

Recommended action:

- Add a package-level `tsconfig.json` for `packages/cli`.
- Add explicit module declarations or a Bun-compatible type strategy for `with { type: 'text' }` imports.
- Normalize the imported asset types before passing them to `Response`.

### 3. Memory SQLite query params are typed too loosely

Affected code:

- `packages/memory/src/vector-stores/sqlite-vec.ts:305`
- `packages/memory/src/vector-stores/sqlite-vec.ts:311`

Observed issue:

- `unknown[]` is spread into Bun SQLite query methods expecting `SQLQueryBindings[]`.

Why this matters:

- This is a production code path and also breaks `core/memory`, which depends on the same package.

Recommended action:

- Replace the `unknown[]` parameter accumulator with a typed binding array.
- Push only values that satisfy Bun SQLite binding types.

### 4. Slack channel types no longer match dependency typings

Affected code:

- `packages/channel-slack/src/index.ts:2`
- `packages/channel-slack/src/index.ts:192`
- `packages/channel-slack/src/index.ts:193`
- `packages/channel-slack/src/index.ts:195`
- `packages/channel-slack/src/index.ts:220`

Observed issues:

- `@slack/bolt` does not export `GenericMessageEvent` as currently imported.
- `event.user` and related fields are still `string | undefined` in paths that assume a string.
- `AppMentionEvent` is cast directly to `Record<string, unknown>`, which TypeScript rejects.

Why this matters:

- This is production channel ingress code and should not depend on optimistic casting.

Recommended action:

- Update imports to match the installed Slack SDK version.
- Narrow `event.user` and other optional fields before building `UserInfo`.
- Replace broad record casts with targeted property extraction.

### 5. Discord member extraction relies on unsafe record casting

Affected code:

- `packages/channel-discord/src/index.ts:342`
- `packages/channel-discord/src/index.ts:343`

Observed issue:

- `interaction.member` is cast to `Record<string, unknown>` and read as though it always matches the fallback shape.

Why this matters:

- This is a runtime boundary between Discord SDK data and internal authorization logic.

Recommended action:

- Replace record casts with explicit type guards over the union of `GuildMember` and `APIInteractionGuildMember`.

### 6. Assistant tools plugin contract is internally inconsistent

Affected code:

- `packages/assistant-tools/opencode/tools/lib.ts:10`
- `packages/assistant-tools/opencode/tools/lib.ts:23`
- `packages/assistant-tools/opencode/tools/lib.ts:37`
- `packages/assistant-tools/src/index.ts:29`
- `packages/assistant-tools/opencode/tools/memory-apps.ts:4`
- `packages/assistant-tools/opencode/tools/memory-stats.ts:4`

Observed issues:

- `ProvisionResult` requires `{ ok: false; error: string }`, but `provisionMemoryUser()` returns `{ ok: res.ok }`, which produces an impossible union member.
- The plugin builds its `tool` map as `Record<string, unknown>`, which is too weak for the expected plugin contract.
- Several tool definitions omit `args`, but current typings require it.

Why this matters:

- This package represents assistant runtime behavior and tool registration. Broken typings here indicate drift from the active plugin API.

Recommended action:

- Fix `ProvisionResult` so success and failure branches are explicit and exhaustive.
- Define a concrete tool-map type instead of `Record<string, unknown>`.
- Standardize zero-argument tools on an explicit `args: {}` or the plugin library's supported empty-args pattern.

### 7. Admin tools package has repeated plugin API mismatches

Affected code examples:

- `packages/admin-tools/opencode/tools/admin-artifacts.ts:6`
- `packages/admin-tools/opencode/tools/admin-artifacts.ts:13`
- Similar patterns across `admin-automations.ts`, `admin-channels.ts`, `admin-config.ts`, `admin-connections.ts`, `admin-containers.ts`, `admin-lifecycle.ts`, and others

Observed issue:

- Many tools define `tool({ description, execute() { ... } })` with no `args`, but current typings require `args`.

Why this matters:

- This is repeated surface-area drift, not a one-off typing nuisance. It indicates the package is out of sync with the active OpenCode plugin API.

Recommended action:

- Update all zero-argument tools to the currently supported typed shape.
- Add a dedicated `tsconfig.json` and package-level type-check script so API drift is caught earlier.

### 8. Scheduler tests use outdated mocked `fetch` assumptions

Affected files:

- `packages/scheduler/src/actions/api.test.ts`
- `packages/scheduler/src/actions/assistant.test.ts`
- `packages/scheduler/src/actions/http.test.ts`

Observed issue:

- Mocked values are cast directly to `typeof fetch`, but current lib definitions include members not present on the mock type.

Why this matters:

- The code under test may still work, but test typing is now brittle and noisy.

Recommended action:

- Wrap fetch mocking in a helper with an explicit compatible test type.
- Cast through `unknown` only if necessary and well-contained.

## Packages Missing Dedicated Type-Check Configuration

These workspaces have TypeScript source but no dedicated `tsconfig.json`:

- `packages/cli`
- `core/guardian`
- `core/memory`
- `packages/channel-discord`
- `packages/channel-api`
- `packages/channel-chat`
- `packages/assistant-tools`
- `packages/admin-tools`

Risks:

- Compiler behavior is inferred ad hoc rather than documented in-package.
- Asset import behavior and Bun-specific semantics are harder to express cleanly.
- CI and local developer checks can drift from actual runtime assumptions.

Recommended action:

- Add `tsconfig.json` and a `check` or `typecheck` script for each package.
- Keep options package-local so runtime differences are explicit rather than hidden in one-off commands.

## Maintainability Findings From FTA

### Workspace-Level Hotspots

| Workspace | Files analyzed | Files with FTA score >= 60 | Worst file | Score |
|---|---:|---:|---|---:|
| `packages/cli` | 33 | 8 | `src/setup-wizard/wizard.js` | 121.58 |
| `packages/lib` | 51 | 12 | `src/control-plane/setup.ts` | 90.98 |
| `packages/assistant-tools` | 33 | 5 | `opencode/plugins/memory-context.ts` | 84.52 |
| `packages/channel-slack` | 5 | 2 | `src/index.test.ts` | 79.96 |
| `packages/channel-discord` | 7 | 2 | `src/index.test.ts` | 77.04 |
| `packages/admin` | 124 | 12 | `src/lib/api.ts` | 75.37 |
| `packages/channel-api` | 2 | 1 | `src/index.test.ts` | 72.84 |
| `packages/channel-voice` | 8 | 2 | `web/app.js` | 72.40 |
| `core/guardian` | 2 | 2 | `src/server.ts` | 70.27 |
| `core/memory` | 2 | 2 | `src/server.ts` | 69.02 |
| `packages/memory` | 41 | 8 | `src/__tests__/memory.test.ts` | 66.47 |
| `packages/channels-sdk` | 13 | 0 | `src/assistant-client.test.ts` | 59.74 |
| `packages/scheduler` | 13 | 0 | `src/scheduler.ts` | 58.04 |
| `packages/admin-tools` | 24 | 0 | `opencode/tools/stack-diagnostics.ts` | 55.24 |
| `packages/channel-chat` | 2 | 0 | `src/index.ts` | 46.69 |

### Top 20 Repo-Wide FTA Hotspots

| File | Score | Cyclomatic complexity | Lines | Assessment |
|---|---:|---:|---:|---|
| `packages/cli/src/setup-wizard/wizard.js` | 121.58 | 371 | 1330 | Needs improvement |
| `packages/lib/src/control-plane/setup.ts` | 90.98 | 201 | 704 | Needs improvement |
| `packages/assistant-tools/opencode/plugins/memory-context.ts` | 84.52 | 135 | 802 | Needs improvement |
| `packages/lib/src/control-plane/setup.test.ts` | 83.14 | 3 | 1047 | Needs improvement |
| `packages/channel-slack/src/index.test.ts` | 79.96 | 9 | 1299 | Needs improvement |
| `packages/lib/src/control-plane/components.ts` | 79.14 | 130 | 556 | Needs improvement |
| `packages/channel-discord/src/index.test.ts` | 77.04 | 15 | 1016 | Needs improvement |
| `packages/lib/src/control-plane/install-edge-cases.test.ts` | 76.47 | 7 | 874 | Needs improvement |
| `packages/admin/src/lib/api.ts` | 75.37 | 93 | 626 | Needs improvement |
| `packages/lib/src/control-plane/components.test.ts` | 74.25 | 7 | 812 | Needs improvement |
| `packages/admin/e2e/setup-wizard.test.ts` | 73.41 | 10 | 729 | Needs improvement |
| `packages/channel-api/src/index.test.ts` | 72.84 | 3 | 443 | Needs improvement |
| `packages/admin/src/lib/server/scheduler.test.ts` | 72.55 | 11 | 711 | Needs improvement |
| `packages/channel-voice/web/app.js` | 72.40 | 94 | 422 | Needs improvement |
| `packages/admin/src/lib/server/memory-config.test.ts` | 72.19 | 6 | 574 | Needs improvement |
| `packages/assistant-tools/tests/viking-context.integration.test.ts` | 71.87 | 104 | 400 | Needs improvement |
| `packages/admin/src/lib/server/docker.test.ts` | 71.82 | 4 | 478 | Needs improvement |
| `packages/assistant-tools/tests/context-budget.test.ts` | 71.71 | 3 | 375 | Needs improvement |
| `packages/lib/src/control-plane/instance-lifecycle.test.ts` | 71.06 | 3 | 356 | Needs improvement |
| `packages/channel-discord/src/index.ts` | 70.84 | 75 | 495 | Needs improvement |

### Interpretation

- The highest-risk production files are not just long; they combine length with concentrated control flow and mixed responsibilities.
- Test suites are also a significant maintainability cost. Several tests exceed the size where failures become hard to isolate and future behavior becomes difficult to extend safely.
- `packages/cli/src/setup-wizard/wizard.js` is well beyond a normal cleanup threshold and should be treated as a decomposition task.
- `packages/lib/src/control-plane/setup.ts` appears to be acting as a broad orchestration hub and should be broken down by domain responsibilities.
- `packages/assistant-tools/opencode/plugins/memory-context.ts` combines session lifecycle, memory retrieval, hygiene, synthesis, logging, and feedback coordination in one file.
- `packages/admin/src/lib/api.ts` has grown into a catch-all transport layer and likely needs domain-based submodules.

## Type Hygiene Findings

### Suppressions

`@ts-ignore` matches found:

- `packages/admin/src/lib/server/vite-asset-provider.ts:10`
- `packages/admin/src/lib/server/vite-asset-provider.ts:12`
- `packages/admin/src/lib/server/vite-asset-provider.ts:14`
- `packages/admin/src/lib/server/vite-asset-provider.ts:16`
- `packages/admin/src/lib/server/vite-asset-provider.ts:18`
- `packages/admin/src/lib/server/vite-asset-provider.ts:20`
- `packages/admin/src/lib/server/vite-asset-provider.ts:22`
- `packages/admin/src/lib/server/vite-asset-provider.ts:24`

Assessment:

- These appear intentional and localized to Vite raw-asset imports, but they would be better replaced with module declarations or a typed import helper.

### Explicit `any`

Observed runtime-code examples:

- `packages/admin/src/lib/voice/voice-state.svelte.ts:20`
- `packages/admin/src/lib/voice/voice-state.svelte.ts:30`
- `packages/admin/src/lib/voice/voice-state.svelte.ts:64`
- `packages/admin/src/lib/voice/voice-state.svelte.ts:71`
- `core/memory/src/server.ts:42`

Most other `any` usage appears in tests.

Assessment:

- Runtime `any` usage is not yet widespread, but the remaining cases sit at browser or config parsing boundaries where explicit narrowing would improve safety and maintainability.

## Recommended Remediation Order

### Phase 1: Fix correctness and runtime-boundary issues

1. `core/guardian`
2. `packages/cli`
3. `packages/memory` and `core/memory`
4. `packages/channel-slack`
5. `packages/channel-discord`

### Phase 2: Fix plugin API drift

1. `packages/assistant-tools`
2. `packages/admin-tools`
3. `packages/scheduler` test mocks

### Phase 3: Improve static-analysis infrastructure

1. Add `tsconfig.json` to packages still missing one
2. Add package-local `check` or `typecheck` scripts
3. Standardize Bun / asset import typing where needed

### Phase 4: Reduce maintainability risk

1. Split `packages/cli/src/setup-wizard/wizard.js`
2. Split `packages/lib/src/control-plane/setup.ts`
3. Split `packages/assistant-tools/opencode/plugins/memory-context.ts`
4. Split `packages/admin/src/lib/api.ts`
5. Break oversized test files into smaller focused suites

## Conclusion

The repository has a strong baseline in several packages, but static analysis shows clear drift in three areas:

- package-local type-check infrastructure is incomplete
- plugin-facing packages have fallen behind their current TypeScript contracts
- a handful of central orchestration files have accumulated too much responsibility

The highest-value next step is to fix the runtime-boundary type failures first, then add package-local `tsconfig` coverage so these issues become easier to catch and maintain.
