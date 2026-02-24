# Over-Engineering & Gold Plating Review: Docker Compose & Container Management

**Scope**: All code related to managing the docker-compose file, managing containers, and the install/setup processes.

**Files reviewed** (~4,400 lines across 25 files):
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
- Various types files

---

## Executive Summary

The stated goal is a **thin wrapper on top of existing tools** (Docker Compose, Caddy, etc.) that is **simple, easy to understand, and easy to maintain**. The actual codebase deviates significantly from this goal. What should be ~800-1000 lines of "call docker compose with the right flags" has become a ~4,400-line system with its own deployment engine, rollback orchestrator, drift detector, impact planner, health gate poller, fallback recovery system, and multiple layers of indirection. Many of these features duplicate capabilities that Docker Compose, container runtimes, and reverse proxies already provide natively.

---

## Finding 1: Two Parallel Compose Runner Implementations (CRITICAL)

There are **two completely separate compose runner systems** that do the same thing:

| File | Used by | Approach |
|------|---------|----------|
| `packages/lib/src/compose-runner.ts` (88 lines) | CLI (`install.ts`, `start.ts`, `stop.ts`, etc.) | Error classification, retry logic, timeout handling |
| `packages/lib/src/compose.ts` (164 lines) | CLI commands | Thin wrappers calling the above |
| `packages/lib/src/admin/compose-runner.ts` (358 lines) | Admin server (UI, stack-apply-engine) | Completely separate implementation with its own override system |

**The problem**: The CLI has one way to call `docker compose up` and the admin server has a completely different way. Both ultimately do the same thing — spawn `docker compose` with arguments. The admin version (`admin/compose-runner.ts`) has accumulated:

- 5 separate `*WithOverride` wrapper functions (`composeActionWithOverride`, `composeExecWithOverride`, `composeActionForFileWithOverride`, `composeConfigValidateForFileWithOverride`, `composeConfigValidateWithOverride`)
- 3 separate override registries (`composeOverrides`, `composeArtifactOverrides`, plus individual overrides for `composeList`, `composePs`, `composeConfigServices`)
- Module-level mutable state for test overrides (`let composeListOverride`, `let composePsOverride`, `let composeConfigServicesOverride`)
- A hand-rolled YAML parser that regex-matches service names from compose files (`parseServiceNamesFromComposeFile` at line 74) instead of just calling `docker compose config --services`

**What a thin wrapper looks like**: One `runCompose(args)` function, used everywhere.

---

## Finding 2: Custom Deployment Orchestrator Reimplements Docker Compose (CRITICAL)

`stack-apply-engine.ts` (422 lines) is a custom deployment orchestrator that does what `docker compose up -d` already does:

1. **Phased rollout** (lines 264-281): Manually divides services into "foundational" and "second phase" and starts them sequentially. Docker Compose's `depends_on` with health conditions already handles startup ordering.

2. **Safe rollout mode with health gating** (lines 276-309): After starting each service individually, polls `docker compose ps` in a loop until the service reports healthy. Docker Compose's `depends_on: condition: service_healthy` already does this.

3. **Artifact staging with temp files** (`renderArtifactsToTemp`, lines 220-298 of `stack-manager.ts`): Writes all artifacts to `.next` files, validates, then atomically renames. This is a transactional write system for config files. For a tool that writes a compose YAML and calls `docker compose up`, this is aerospace-grade file management.

4. **Full rollback system** (lines 321-341): On failure, restores previous artifacts from `.prev` backups, validates the rollback compose file, then re-starts every core service individually. If rollback fails, falls to a "fallback mode" (see Finding 3).

5. **Apply lock** (lines 352-376): A file-based mutex with PID and timestamp, 10-minute timeout. This protects against concurrent `applyStack` calls — a scenario that is unlikely in a single-user personal assistant tool.

**What a thin wrapper looks like**: `docker compose up -d --remove-orphans`. If that fails, show the error.

---

## Finding 3: Three-Tier Failure Recovery System (SEVERE)

The system implements a three-tier failure recovery cascade:

1. **Normal apply** → if it fails →
2. **Full rollback** (restore `.prev` files, re-up all 8 core services) → if that fails →
3. **Fallback bundle** (a checksummed, integrity-verified minimal compose file that only runs admin+caddy)

The fallback bundle system alone spans 3 files:
- `fallback-bundle.ts` — SHA-256 checksum verification of fallback compose + caddy files
- `fallback-bundle-checksums.ts` — hardcoded checksums
- `stack-apply-engine.ts:fallbackToAdminAndCaddy()` — the recovery function

The fallback bundle is **integrity-checked via SHA-256 checksums** (`fallback-bundle.ts`). If the checksum doesn't match, the fallback itself fails. This is a supply-chain integrity check for a compose file that the tool itself wrote.

Additionally, `selfTestFallbackBundle()` is called **after every successful apply** (line 344-347 of `stack-apply-engine.ts`) to verify the fallback bundle is still valid. This is post-deployment self-testing of the disaster recovery system.

**What a thin wrapper looks like**: If `docker compose up` fails, print the error. The user runs `docker compose up` again.

---

## Finding 4: Impact Planning System (MODERATE)

`impact-plan.ts` (64 lines) + `deriveImpact()` in `stack-apply-engine.ts` (~60 lines) implement a change-detection and impact-analysis system:

- Diffs every artifact (compose file, caddy JSON, each service's env file)
- Computes which services need reload vs. restart vs. up vs. down
- Classifies changes as "caddy changed", "gateway secrets changed", "channel config changed", etc.
- Runs `docker compose config --services` on both old and new compose files to diff service sets
- Filters out "up" services from the "restart" list to avoid redundant operations

This is a custom-built blue-green deployment planner. Docker Compose already handles all of this: if you change a service's config and run `docker compose up -d`, it recreates exactly the services that changed.

---

## Finding 5: Drift Detection System (MODERATE)

`compose-runner.ts:computeDriftReport()` (lines 157-196) implements drift detection:

- Compares expected services to running containers
- Checks for exited containers
- Verifies env files exist
- **SHA-256 hashes the compose file and caddy config** and compares them to "intended" hashes
- Persists the drift report as a JSON file

This runs **before every apply** (line 236 of `stack-apply-engine.ts`). The tool is checking whether its own generated files have been tampered with since the last apply. For a local development tool, this is solving a problem that doesn't exist.

---

## Finding 6: Preflight Check System (MODERATE)

`preflight-checks.ts` (113 lines) runs before every stack apply:

- Checks Docker socket exists and is accessible
- Checks Docker daemon is reachable (runs `docker info`)
- Parses compose file to extract all published ports, then runs `ss -tln` to check each port
- Checks that state directory paths are writable
- Pulls images for new services as a "preflight"

There is also a **separate** preflight system for the CLI install (`packages/lib/src/preflight.ts`, referenced in `install.ts`). So there are two preflight systems.

Port checking via `ss -tln` parsing is fragile and platform-dependent. Docker itself will report clear errors if a port is in use when you try to bind it. The writable-mount check is redundant — the tool just wrote files to those paths moments earlier.

---

## Finding 7: Schema Validation Done Three Ways (MODERATE)

Stack spec validation is implemented in three separate places:

1. **`stack-spec.ts:parseStackSpec()`** (411 lines) — hand-written runtime validator with manual field-by-field type checking and regex patterns
2. **`schemas/stack-spec.schema.ts`** (123 lines) — JSON Schema definition that duplicates all the same rules in a different format
3. **`schema-validation.ts:validateStackSpec()`** — wraps `parseStackSpec()` into a `ValidationResult` type

Similarly, compose file validation exists in multiple forms:
- `compose-spec-serializer.ts:validateComposeSpec()` — checks every service has `restart` and `healthcheck`
- `schema-validation.ts:validateComposeFile()` — parses YAML and validates service keys against a hardcoded allowlist
- `compose-runner.ts:composeConfigValidate()` — calls `docker compose config` (the actual tool)
- `stack-generator.ts:validateGeneratedCompose()` — grep-checks the generated YAML string for `restart: unless-stopped` and `healthcheck:`

**What a thin wrapper looks like**: Call `docker compose config` to validate. Done.

---

## Finding 8: Caddy JSON Config Generator (MODERATE)

`stack-generator.ts` contains ~170 lines of Caddy JSON API config generation (lines 59-341). This builds a complex nested JSON structure for Caddy's reverse proxy configuration including:

- IP-based access control with LAN range computation
- Subroutes with path stripping and rewriting
- Domain-based TLS routes on a separate `:443` server
- Guard handlers with 403 responses

This is a programmatic Caddy config builder. Caddy has a much simpler Caddyfile format that is human-readable and could be templated in ~20 lines. The JSON API format was chosen, and a full builder was written, adding significant complexity for something that could be a simple template.

---

## Finding 9: Override/Testability Pattern Explosion (MODERATE)

`admin/compose-runner.ts` uses module-level mutable globals for test overrides:

```typescript
let composeListOverride: ComposeListFn | null = null;
let composePsOverride: ComposePsFn | null = null;
let composeConfigServicesOverride: ComposeConfigServicesFn | null = null;
let composeOverrides: ComposeRunnerOverrides = {};
let composeArtifactOverrides: ComposeRunnerArtifactOverrides = {};
```

Each has a corresponding `set*Override()` setter and `*WithOverride()` caller. This creates 5 override registries with 5 setters and 5 wrapper functions — 15 functions total just to make compose calls mockable in tests.

A simpler pattern: pass the compose runner as a constructor parameter or use dependency injection at a single point.

---

## Finding 10: `StackManager` Does Too Many Things (MODERATE)

`StackManager` (510 lines) is a god class that manages:

- Stack spec read/write with atomic writes
- Channel access/config CRUD
- Secret management (upsert, delete, validation, usage tracking)
- Automation CRUD (with cron validation)
- Artifact rendering (compose files, env files, caddy config)
- Artifact staging to temp files with promote/rollback
- Drift report computation
- Fallback bundle seeding
- Render report generation

A "thin wrapper" StackManager would: read a YAML spec, render a compose file, write it. The secret manager, automation manager, and artifact staging system should either be separate concerns or not exist at all.

---

## Finding 11: `listSecretManagerState()` Over-Design (MINOR)

`StackManager.listSecretManagerState()` (lines 323-375) builds a rich data model for each secret including:

```typescript
{
  name, configured, usedBy,
  purpose: "credential_or_shared_secret" | "runtime_config",  // inferred from name
  constraints: { min_length: 32 },  // only if name includes "SECRET"
  rotation: { recommendedDays: 90, lastRotated: null },  // always null, never tracked
}
```

The `purpose` field is guessed from the secret name. The `constraints` field applies a minimum length only if the name contains "SECRET". The `rotation` object has a `recommendedDays: 90` recommendation with `lastRotated: null` — rotation is never tracked, so this field is always `null`. This is designing a secret rotation feature that doesn't exist.

---

## Finding 12: `SetupManager` Excessive Sanitization (MINOR)

`setup-manager.ts` (232 lines) has 6 sanitization functions for a JSON file that the tool itself writes:

- `sanitizeStringArray()`
- `uniqueStrings()`
- `sanitizeServiceInstances()`
- `sanitizeSmallModel()`
- `sanitizeSteps()`
- `sanitizeProfile()`

These guard against malformed JSON in a file the tool controls. The `normalizeState()` function defensively checks every single field type. This is over-validating internal state.

---

## Finding 13: `previewComposeOperations()` (MINOR)

`stack-apply-engine.ts:previewComposeOperations()` (lines 396-422) builds a data structure that maps each service to whether it should be "reloaded" or "restarted". It calls `composeServiceNames()` to get the service list, validates a tail limit of 50, then builds a hardcoded semantics map. The function is called `preview` but doesn't actually preview anything — it returns static metadata.

---

## Finding 14: `validateGeneratedCompose()` String Grep (MINOR)

`stack-generator.ts:validateGeneratedCompose()` (lines 574-580) validates a compose file the tool just generated by grepping the YAML string:

```typescript
if (!compose.includes("restart: unless-stopped")) errors.push("missing_restart_policy");
if (!compose.includes("healthcheck:")) errors.push("missing_healthchecks");
```

The tool generated this compose file. It knows exactly what's in it. Validating the output by string searching is both fragile and unnecessary.

---

## Finding 15: Hand-Rolled YAML Service Name Parser (MINOR)

`admin/compose-runner.ts:parseServiceNamesFromComposeFile()` (lines 74-91) parses compose files with a hand-written line-by-line regex parser to extract service names:

```typescript
if (line.trim() === "services:") inServices = true;
const match = /^\s{2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
```

This is fragile — it assumes exactly 2-space indentation and no comments. `docker compose config --services` does this correctly. The function `composeConfigServices()` already calls `docker compose config --services` 14 lines later.

---

## Finding 16: Snippet Discovery System Scope Creep (NOTE)

`snippet-discovery.ts` (236 lines) implements a GitHub topic discovery service that searches for community plugins by:
- Fetching a curated YAML index via HTTP
- Searching GitHub's API for repos with specific topics
- Fetching `openpalm-snippet.yaml` from each discovered repo
- Deduplicating by name with trust-tier priority (official > curated > community)
- Caching results for 15 minutes

This is a plugin marketplace discovery system. While potentially useful, it's a significant feature with network dependencies, caching, and trust tiers — far beyond "thin wrapper" territory for what is part of the Docker Compose management layer.

---

## Recommendations

### To achieve "thin wrapper" goals:

1. **Merge the two compose runner implementations** into one. The CLI and admin should share the exact same `runCompose()` function.

2. **Remove the custom deployment orchestrator**. Replace `applyStack()` with: render compose file → write it → `docker compose up -d --remove-orphans`. Docker Compose handles service ordering, health checking, and recreation of changed services.

3. **Remove the three-tier failure recovery system**. If `docker compose up` fails, report the error. Users can fix the issue and retry. The fallback bundle with SHA-256 integrity checking is solving a theoretical problem.

4. **Remove the impact planning system**. Docker Compose already knows which services changed and need recreation. Don't re-implement its logic.

5. **Remove drift detection**. The tool generates the compose file. It doesn't need to verify its own output hasn't been tampered with before applying changes.

6. **Consolidate validation to one approach**. Use `docker compose config` for compose validation. Use one validation pass for stack spec (either the hand-written parser or JSON Schema, not both).

7. **Simplify the override pattern**. Replace 5 module-level override registries with a single injected interface.

8. **Consider Caddyfile over Caddy JSON API**. The Caddyfile format is far more readable and could be templated instead of programmatically constructed.

### Estimated line reduction:
Current: ~4,400 lines
Target for thin wrapper: ~1,000-1,500 lines
Reduction: ~65-75%
