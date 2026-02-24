# Over-Engineering & Gold Plating Review: Docker Compose & Container Management

## Product Context

OpenPalm is an **integration and management tool** for non-technical users. It makes it easy to manage a Docker Compose stack by:
- Enabling/configuring channels and services that communicate with core containers (gateway, admin, assistant, openmemory and its dependencies)
- Searching for compatible "snippets" users can include to enable new features
- Providing a setup wizard and admin UI so users never need to touch YAML or the terminal

The meta-goal is to keep the solution **lightweight**, leveraging existing tech (Docker Compose, Caddy, etc.) so that OpenPalm is basically a configuration layer on top of battle-tested infrastructure.

**Key architectural decision**: Caddy JSON API format was chosen over Caddyfile to handle dynamic proxy configuration programmatically without regex/replace string manipulation. This is a defensible choice.

---

## Scope

All code related to managing the docker-compose file, managing containers, and the install/setup processes.

**Files reviewed** (~4,400 lines across 25+ files):
- `packages/lib/src/admin/compose-runner.ts` (358 lines)
- `packages/lib/src/compose-runner.ts` (88 lines)
- `packages/lib/src/compose.ts` (164 lines)
- `packages/lib/src/admin/stack-manager.ts` (510 lines)
- `packages/lib/src/admin/stack-generator.ts` (644 lines)
- `packages/lib/src/admin/stack-apply-engine.ts` (422 lines)
- `packages/lib/src/admin/impact-plan.ts` (64 lines)
- `packages/lib/src/admin/health-gate.ts` (72 lines)
- `packages/lib/src/admin/setup-manager.ts` (232 lines)
- `packages/lib/src/admin/schema-validation.ts` (156 lines)
- `packages/lib/src/admin/preflight-checks.ts` (113 lines)
- `packages/lib/src/admin/fallback-bundle.ts` (29 lines)
- `packages/lib/src/admin/fallback-bundle-checksums.ts` (6 lines)
- `packages/lib/src/admin/core-services.ts` (105 lines)
- `packages/lib/src/admin/compose-spec.ts` (28 lines)
- `packages/lib/src/admin/compose-spec-serializer.ts` (15 lines)
- `packages/lib/src/admin/stack-spec.ts` (411 lines)
- `packages/lib/src/admin/schemas/stack-spec.schema.ts` (123 lines)
- `packages/lib/src/admin/schemas/compose-helpers.ts` (10 lines)
- `packages/lib/src/admin/runtime-env.ts` (93 lines)
- `packages/lib/src/admin/extensions.ts` (37 lines)
- `packages/lib/src/admin/snippet-discovery.ts` (236 lines)
- `packages/lib/src/admin/cron.ts` (54 lines)
- `packages/cli/src/commands/install.ts` (465 lines)
- `packages/ui/src/routes/command/+server.ts` (607 lines)
- Various types/support files

---

## Executive Summary

OpenPalm's core value proposition is: non-technical user clicks buttons in a UI, OpenPalm generates the right compose/caddy/env files, and calls `docker compose up`. The **spec parsing, config generation, and snippet discovery** systems are aligned with this mission — they're the product. But the deployment pipeline around them has grown into its own orchestration platform, reimplementing capabilities that Docker Compose already provides.

The code that *understands the user's intent* (stack spec, channel config, snippet import, Caddy route building) is valuable domain logic. The code that *executes compose commands* should be a thin passthrough. Currently, the execution layer is roughly as complex as the domain logic layer, and that's where the over-engineering lives.

### What's Working Well

These components are aligned with the "integration tool" mission and are appropriately scoped:

- **Stack spec parsing** (`stack-spec.ts`) — Defines OpenPalm's configuration model. This is the product.
- **Stack generator** (`stack-generator.ts`) — Translates user intent into compose/env/caddy artifacts. Core domain logic.
- **Caddy JSON builder** — Programmatic generation avoids brittle string manipulation. Correct choice for dynamic route generation with IP guards, path rewrites, and domain-based routing.
- **Snippet discovery** (`snippet-discovery.ts`) — Helps non-technical users find compatible add-ons. This is a product feature, not infrastructure. Appropriately scoped.
- **Setup manager** (`setup-manager.ts`) — Tracks wizard progress for first-boot UX. Simple state file.
- **CLI install flow** (`install.ts`) — Linear, readable, good UX messaging.
- **CLI commands** (`start.ts`, `stop.ts`, `restart.ts`, `status.ts`, `update.ts`) — Properly thin wrappers. These are the model for how compose interaction should work.

---

## Findings: Over-Engineering

### Finding 1: Two Parallel Compose Runner Implementations (CRITICAL)

There are **two completely separate compose runner systems** that do the same thing:

| File | Used by | Approach |
|------|---------|----------|
| `packages/lib/src/compose-runner.ts` (88 lines) | CLI (`install.ts`, `start.ts`, `stop.ts`, etc.) | Error classification, retry logic, timeout handling |
| `packages/lib/src/compose.ts` (164 lines) | CLI commands | Thin wrappers calling the above |
| `packages/lib/src/admin/compose-runner.ts` (358 lines) | Admin server (UI, stack-apply-engine) | Completely separate implementation with its own override system |

The CLI has one way to call `docker compose up` and the admin server has a completely different way. Both ultimately spawn `docker compose` with arguments. The admin version has accumulated:

- 5 separate `*WithOverride` wrapper functions
- 3 separate override registries (`composeOverrides`, `composeArtifactOverrides`, plus individual overrides for `composeList`, `composePs`, `composeConfigServices`)
- Module-level mutable state for test overrides
- A hand-rolled YAML parser that regex-matches service names from compose files (`parseServiceNamesFromComposeFile`) instead of calling `docker compose config --services`

**Impact**: A non-technical user who encounters a compose error sees different behavior depending on whether they triggered it from the CLI or the admin UI. Bugs get fixed in one path but not the other.

**Recommendation**: Merge into one `runCompose(args)` function used by both CLI and admin. The CLI's compose runner + thin wrapper pattern (`compose.ts`) is already the right model.

---

### Finding 2: Custom Deployment Orchestrator Reimplements Docker Compose (CRITICAL)

`stack-apply-engine.ts` (422 lines) is a custom deployment orchestrator that duplicates what `docker compose up -d` already does:

1. **Phased rollout** (lines 264-281): Manually divides services into "foundational" and "second phase" and starts them sequentially. Docker Compose's `depends_on` with health conditions already handles startup ordering.

2. **Safe rollout mode with health gating** (lines 276-309): After starting each service individually, polls `docker compose ps` in a loop until the service reports healthy. Docker Compose's `depends_on: condition: service_healthy` already does this.

3. **Artifact staging with temp files** (`renderArtifactsToTemp`, ~80 lines in `stack-manager.ts`): Writes all artifacts to `.next` files, validates, then atomically renames with `.prev` backups. This is a transactional write system for config files.

4. **Full rollback system** (lines 321-341): On failure, restores previous artifacts from `.prev` backups, validates the rollback compose file, then re-starts every core service individually. If rollback fails, falls to "fallback mode" (Finding 3).

5. **Apply lock** (lines 352-376): A file-based mutex with PID and timestamp, 10-minute timeout.

**Why this matters for non-technical users**: This complexity doesn't help them — it adds failure modes they can't debug. If the rollback itself fails (which has its own error paths), the user sees cryptic error chains like `rollback_compose_up_failed:gateway:...` that are harder to understand than the original compose error.

**Recommendation**: Replace `applyStack()` with: render artifacts → write them → `docker compose up -d --remove-orphans`. The compose file already has `depends_on: condition: service_healthy` which handles ordering. If it fails, surface Docker's own error message — those are well-documented and Google-able. Keep the render + validate step (that's domain logic), but remove the custom orchestration.

---

### Finding 3: Three-Tier Failure Recovery System (SEVERE)

The system implements a three-tier failure recovery cascade:

1. **Normal apply** → if it fails →
2. **Full rollback** (restore `.prev` files, re-up all 8 core services) → if that fails →
3. **Fallback bundle** (a SHA-256 integrity-verified minimal compose file that only runs admin+caddy)

The fallback bundle system spans 3 files:
- `fallback-bundle.ts` — SHA-256 checksum verification
- `fallback-bundle-checksums.ts` — hardcoded checksums
- `stack-apply-engine.ts:fallbackToAdminAndCaddy()` — the recovery function

`selfTestFallbackBundle()` runs **after every successful apply** to verify the fallback bundle is still valid.

**Why this doesn't serve the mission**: The recovery system is more complex than the thing it's recovering from. The fallback bundle's SHA-256 integrity check is verifying files the tool itself wrote — it's protecting against a corruption scenario that doesn't happen in practice. If a stack apply fails, the simplest recovery for a non-technical user is: the admin UI shows the error and a "retry" button. The admin container itself is already running (it's the one processing the request).

**Recommendation**: Remove the three-tier recovery. The admin+caddy are already running when `applyStack()` is called (the request came through them). If compose-up fails, return the error to the UI. The user's admin panel is still accessible. Add a simple "the last apply failed, click to retry" UI state instead of an invisible automated recovery system.

---

### Finding 4: Impact Planning System (MODERATE)

`impact-plan.ts` (64 lines) + `deriveImpact()` in `stack-apply-engine.ts` (~60 lines) implement change-detection and impact-analysis:

- Diffs every artifact (compose file, caddy JSON, each service's env file)
- Computes which services need reload vs. restart vs. up vs. down
- Classifies changes by type (caddy, gateway secrets, channel config, etc.)
- Runs `docker compose config --services` on both old and new compose files to diff service sets
- Filters out "up" services from the "restart" list

Docker Compose already handles this. When you run `docker compose up -d`, it compares the current state to the compose file and only recreates services whose configuration changed. The one exception is Caddy reload (exec into the container), which is a ~5 line special case, not a 120-line impact planning system.

**Recommendation**: Remove the impact planner. Use `docker compose up -d --remove-orphans` and handle the Caddy reload special case directly:
```typescript
await runCompose(["up", "-d", "--remove-orphans"]);
if (caddyConfigChanged) await runCompose(["exec", "caddy", "caddy", "reload", ...]);
```

---

### Finding 5: Drift Detection System (MODERATE)

`compose-runner.ts:computeDriftReport()` (lines 157-196):

- Compares expected services to running containers
- Checks for exited containers
- Verifies env files exist
- SHA-256 hashes the compose file and caddy config against "intended" hashes
- Persists the drift report as a JSON file
- Runs before every apply AND is exposed as a standalone API endpoint

**The useful part**: Showing a non-technical user "these containers are stopped" or "something is wrong" in the dashboard is genuinely helpful. That's just `docker compose ps`.

**The over-engineering**: SHA-256 hashing artifacts to detect whether the tool's own generated files have been modified since the last apply. File-existence checks on env files the tool just wrote.

**Recommendation**: Keep a simple "container status" check (basically `compose ps` parsed into a friendly format for the UI). Remove the artifact hashing and env-file-existence checks. If the user needs to know "is the stack healthy?", show them which containers are running/stopped/unhealthy.

---

### Finding 6: Two Separate Preflight Check Systems (MODERATE)

There are two preflight systems:
1. `packages/lib/src/preflight.ts` — used by CLI install
2. `packages/lib/src/admin/preflight-checks.ts` (113 lines) — used by admin apply

The admin preflight runs before every stack apply and:
- Checks Docker socket exists and is accessible
- Runs `docker info` to check daemon reachability
- Parses compose file to extract published ports, then runs `ss -tln` to check each port
- Checks that state directory paths are writable
- Pulls images for new services as a "preflight"

**Issues**:
- Port checking via `ss -tln` parsing is fragile and Linux-only. Docker itself reports clear errors if a port is in use.
- Writable-mount checks are redundant — the tool just wrote files to those paths.
- Running image pulls as a "preflight check" conflates validation with execution. Pulling images IS the deployment, not a pre-check.

**Recommendation**: Keep the install-time preflight (it runs once and helps with first-boot troubleshooting). Remove the per-apply preflight — let Docker report its own errors. If Docker can't connect to its daemon, the compose command itself will fail with a clear message.

---

### Finding 7: Schema Validation Done Three+ Ways (MODERATE)

Stack spec validation exists in three places:

1. **`stack-spec.ts:parseStackSpec()`** (411 lines) — hand-written runtime validator
2. **`schemas/stack-spec.schema.ts`** (123 lines) — JSON Schema that duplicates the same rules
3. **`schema-validation.ts:validateStackSpec()`** — wraps `parseStackSpec()` into a `ValidationResult`

Compose validation exists in four forms:
- `compose-spec-serializer.ts:validateComposeSpec()` — checks restart + healthcheck
- `schema-validation.ts:validateComposeFile()` — YAML parse + key allowlist
- `compose-runner.ts:composeConfigValidate()` — calls `docker compose config`
- `stack-generator.ts:validateGeneratedCompose()` — string-greps for `restart:` and `healthcheck:`

**The needed validation**: `parseStackSpec()` is essential — it's the boundary where user/snippet input enters the system and must be validated. The JSON Schema is useful for test-time verification.

**The waste**: Validating the compose file the tool just generated, in three different ways, is verifying our own output. `docker compose config` is the authority and catches real problems.

**Recommendation**: Keep `parseStackSpec()` (input validation) and `docker compose config` (output validation). Remove `validateComposeFile()`, `validateComposeSpec()`, and `validateGeneratedCompose()`. Remove the JSON Schema if it's only used in tests that mirror what `parseStackSpec()` already covers. If it's used for documentation or external tooling, keep it but mark it as the single source of truth and delete the hand-written parser.

---

### Finding 8: Override/Testability Pattern Explosion (MODERATE)

`admin/compose-runner.ts` uses module-level mutable globals for test overrides:

```typescript
let composeListOverride: ComposeListFn | null = null;
let composePsOverride: ComposePsFn | null = null;
let composeConfigServicesOverride: ComposeConfigServicesFn | null = null;
let composeOverrides: ComposeRunnerOverrides = {};
let composeArtifactOverrides: ComposeRunnerArtifactOverrides = {};
```

That's 5 override registries, 5 setters, and 5 wrapper functions — 15 exports just for test mockability. This pattern scales linearly with every new compose operation.

**Recommendation**: Pass a `ComposeRunner` interface (or just a `runCompose` function) as a parameter where needed. One injection point replaces 15 functions. This also naturally resolves Finding 1 — the same interface serves both CLI and admin.

---

### Finding 9: `StackManager` God Class (MODERATE)

`StackManager` (510 lines) handles:

- Stack spec read/write with atomic writes
- Channel access/config CRUD
- Secret management (upsert, delete, validation, usage tracking)
- Automation CRUD (with cron validation)
- Artifact rendering (compose files, env files, caddy config)
- Artifact staging to temp files with promote/rollback
- Drift report computation
- Fallback bundle seeding
- Render report generation

**What belongs here**: Spec CRUD, channel/service config, artifact rendering. This is the core domain — "user changes config, tool generates files."

**What doesn't**: Secret lifecycle management with usage tracking, artifact staging/promote/rollback (Finding 2), drift computation (Finding 5), fallback bundle management (Finding 3). These are either separate concerns or over-engineering that should be removed entirely.

**Recommendation**: After removing the over-engineering identified in Findings 2-5, StackManager naturally shrinks to: spec CRUD + artifact rendering + secrets read/write. That's a reasonable scope for one class.

---

### Finding 10: `listSecretManagerState()` Over-Design (MINOR)

`StackManager.listSecretManagerState()` (lines 323-375) builds a rich data model for each secret:

```typescript
{
  name, configured, usedBy,
  purpose: "credential_or_shared_secret" | "runtime_config",  // guessed from name
  constraints: { min_length: 32 },  // only if name includes "SECRET"
  rotation: { recommendedDays: 90, lastRotated: null },  // always null
}
```

The `purpose` is inferred from naming patterns. The `rotation.lastRotated` is always `null` — rotation tracking doesn't exist. The `constraints` field applies minimum length only if the name contains "SECRET".

**Recommendation**: Return `{ name, configured, usedBy }`. Drop `purpose`, `constraints`, and `rotation` — they're speculative features that don't exist. If/when rotation tracking is built, add it then.

---

### Finding 11: `SetupManager` Defensive Sanitization (MINOR)

`setup-manager.ts` (232 lines) has 6 sanitization functions (`sanitizeStringArray`, `uniqueStrings`, `sanitizeServiceInstances`, `sanitizeSmallModel`, `sanitizeSteps`, `sanitizeProfile`) for a JSON file that the tool itself writes.

**Context that partially justifies this**: The setup state file lives on disk and could theoretically be hand-edited or corrupted. For a tool targeting non-technical users, defensive reads of persisted state aren't unreasonable — a corrupted state file shouldn't crash the admin server.

**The over-engineering**: Each nested object has its own sanitization function with per-field type checking. A simpler approach: parse with a try/catch, return defaults if parsing fails.

**Recommendation**: Replace the 6 sanitization functions with: try to parse the JSON; if any field is wrong type or missing, return `DEFAULT_STATE`. Non-technical users won't hand-edit this file, and if corruption happens, starting fresh is the right behavior.

---

### Finding 12: `validateGeneratedCompose()` String Grep (MINOR)

`stack-generator.ts:validateGeneratedCompose()` (lines 574-580):

```typescript
if (!compose.includes("restart: unless-stopped")) errors.push("missing_restart_policy");
if (!compose.includes("healthcheck:")) errors.push("missing_healthchecks");
```

The tool just generated this compose file from typed data structures. It knows `restart: "unless-stopped"` is set on every service because `renderChannelComposeService()`, `renderAdminComposeService()`, etc. all hardcode it.

**Recommendation**: Remove. The typed render functions guarantee these properties. If you want a safety net, `docker compose config` catches real structural issues.

---

### Finding 13: Hand-Rolled YAML Service Name Parser (MINOR)

`admin/compose-runner.ts:parseServiceNamesFromComposeFile()` (lines 74-91) parses compose files with regex:

```typescript
if (line.trim() === "services:") inServices = true;
const match = /^\s{2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
```

Fragile — assumes 2-space indentation, no comments, no multi-line values. `composeConfigServices()` already calls `docker compose config --services` 14 lines later and does this correctly.

**Recommendation**: Remove `parseServiceNamesFromComposeFile()`. Use `docker compose config --services` exclusively.

---

### Finding 14: `previewComposeOperations()` Dead-ish Code (MINOR)

`stack-apply-engine.ts:previewComposeOperations()` (lines 396-422) builds a hardcoded map of service-to-reload/restart semantics and validates a tail limit of 50. It's called `preview` but returns static metadata. The tail limit validation is unrelated to previewing.

**Recommendation**: Remove if unused in the UI. If it serves a UI need, simplify to just return the service list.

---

## Summary Table

| # | Finding | Severity | Lines | Action |
|---|---------|----------|-------|--------|
| 1 | Two parallel compose runners | CRITICAL | ~610 | Merge into one shared implementation |
| 2 | Custom deployment orchestrator | CRITICAL | ~422 | Replace with `docker compose up -d` |
| 3 | Three-tier failure recovery | SEVERE | ~100 | Remove; admin is already running |
| 4 | Impact planning system | MODERATE | ~124 | Remove; Docker Compose handles this |
| 5 | Drift detection (artifact hashing) | MODERATE | ~50 | Keep container status; remove hashing |
| 6 | Two preflight systems | MODERATE | ~113 | Keep install preflight; remove per-apply |
| 7 | Validation done 3+ ways | MODERATE | ~280 | Keep parseStackSpec + docker compose config |
| 8 | Override pattern explosion | MODERATE | ~100 | Single injected interface |
| 9 | StackManager god class | MODERATE | ~100* | Shrinks naturally after 2-5 |
| 10 | Secret rotation fields | MINOR | ~30 | Return only what exists |
| 11 | SetupManager sanitization | MINOR | ~50 | Simplify to try/catch + defaults |
| 12 | String-grep validation | MINOR | ~10 | Remove |
| 13 | Hand-rolled YAML parser | MINOR | ~20 | Remove; use docker compose config |
| 14 | previewComposeOperations | MINOR | ~30 | Remove or simplify |

*Lines saved by StackManager depend on other removals.

---

## Recommendations

### Keep and improve:
1. **Stack spec parsing** — This is the product's core. Keep `parseStackSpec()`.
2. **Stack generator** — Translating spec to compose/env/caddy artifacts is the product's job.
3. **Caddy JSON builder** — Correct choice for dynamic config. Could be slightly simplified but the approach is right.
4. **Snippet discovery** — Core product feature for non-technical users. Well-scoped.
5. **Setup manager** — Simple wizard state tracking. Consider simplifying sanitization.
6. **CLI commands** (`start.ts`, `stop.ts`, etc.) — Already thin wrappers. Model for the admin side.

### Remove or drastically simplify:
1. **Merge compose runners** — One `runCompose()`, used by CLI and admin.
2. **Replace stack-apply-engine orchestration** — Render artifacts → write → `docker compose up -d --remove-orphans`. Handle Caddy reload as a ~5-line special case.
3. **Remove three-tier recovery** — Admin is already running when apply is called.
4. **Remove impact planner** — Docker Compose diffs service state natively.
5. **Simplify drift to container status** — `docker compose ps` formatted for the UI.
6. **Consolidate validation** — Input: `parseStackSpec()`. Output: `docker compose config`.
7. **One compose interface for testability** — Replace 15 override functions with one injected interface.

### Estimated reduction:
- Current: ~4,400 lines of compose/container management code
- After simplification: ~1,800-2,200 lines
- Reduction: ~50-60%
- The remaining code is primarily domain logic (spec, generator, caddy, snippets) — the actual product.
