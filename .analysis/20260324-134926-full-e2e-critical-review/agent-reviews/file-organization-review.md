# File Organization & Convention Review

**Date:** 2026-03-24
**Branch:** release/0.10.0
**Total non-generated files:** ~727

---

## 1. Top-Level Structure

**Severity: MEDIUM -- Root is moderately cluttered with artifacts that do not belong.**

Root listing (18 visible entries plus dotfiles):

| Entry | Verdict |
|-------|---------|
| `packages/`, `core/`, `.openpalm/`, `docs/`, `scripts/` | Correct -- core project directories |
| `package.json`, `bun.lock`, `.npmrc`, `.gitignore`, `.dockerignore` | Correct -- standard project config |
| `README.md`, `LICENSE`, `CHANGELOG.md` | Correct -- standard project files |
| `CLAUDE.md`, `AGENTS.md` | Acceptable -- AI agent instructions |
| `compose.dev.yaml` | Acceptable -- dev override |
| `.env`, `.env.example` | Acceptable but `.env` should not be tracked (it is tracked via gitignore exception scope) |
| `fta.json` | Questionable -- FTA (file complexity analysis) config. Niche tool, adds clutter. Could live in a `.config/` or be removed. |
| **`before-navigate.png`** | **Dead file. Git-tracked. Not referenced anywhere in the codebase. Must be removed.** |
| **`test-results/`** | **Should not exist at root. Contains only `.last-run.json`. Playwright artifact leaked to root level. Gitignored but directory was created.** |
| **`.dev-0.9.0/`** | **Old dev environment snapshot. Must be removed. Not gitignored properly (it IS ignored by `.dev-*` pattern but still sitting on disk).** |
| **`.dev-tmp3/`** | **Same -- stale temp dev directory.** |
| **`.private/`** | **Contains 371KB zip file (`voice-avatar-tauri-app-streaming.zip`), release scripts, audits, plans. This directory is gitignored but bloated. The zip file especially should not live here.** |

**Recommendations:**
1. Delete `before-navigate.png` from git tracking immediately.
2. Clean up `.dev-0.9.0/` and `.dev-tmp3/` from disk.
3. Move `fta.json` to a `.config/` directory or remove it.
4. Add `test-results/` to root `.gitignore` if not already caught (it has its own entry but the directory was created anyway).

---

## 2. packages/ vs core/ Split

**Severity: HIGH -- The split rationale is unclear and the naming creates confusion.**

### What is where:

**`packages/` (13 directories):**
- `lib` -- shared control-plane library
- `admin` -- SvelteKit admin UI + API
- `cli` -- host-side CLI
- `memory` -- memory library (@openpalm/memory)
- `scheduler` -- scheduler logic + server
- `channels-sdk` -- shared channel SDK
- `channel-api`, `channel-chat`, `channel-discord`, `channel-slack`, `channel-voice` -- channel adapters
- `admin-tools`, `assistant-tools` -- OpenCode plugins

**`core/` (6 directories):**
- `admin` -- Dockerfile + entrypoint.sh (Docker build context)
- `assistant` -- Dockerfile + entrypoint.sh + opencode config
- `channel` -- Dockerfile + start.sh (unified channel image)
- `guardian` -- Dockerfile + **full src/ with 7 TypeScript files** (it is ALSO a workspace member)
- `memory` -- Dockerfile + **full src/ with 3 TypeScript files** (ALSO a workspace member)
- `scheduler` -- Dockerfile only (no src)

### Critical Problems:

**Problem 1: Three names appear in BOTH `core/` and `packages/`: `admin`, `memory`, `scheduler`.**

This creates genuine confusion:
- `packages/memory` is `@openpalm/memory` (the library -- embeddings, vector stores, etc.)
- `core/memory` is `@openpalm/memory-server` (the HTTP server wrapping the library)
- `packages/scheduler` is `@openpalm/scheduler` (the scheduler logic)
- `core/scheduler` contains only a Dockerfile that builds from `packages/scheduler`

The naming collision is a cognitive tax on every developer.

**Problem 2: `core/guardian` and `core/memory` are workspaces with TypeScript source AND Docker contexts.**

The stated convention is "core/ contains container/runtime assembly assets and image build contexts" but `core/guardian` has a full `src/` directory with application logic. It is listed as a workspace in `package.json`. This contradicts the convention. Meanwhile `packages/scheduler` has its source in `packages/` with just a Dockerfile in `core/` -- inconsistent with guardian's approach.

**Problem 3: The split is arbitrary.**

| Service | Source location | Docker context | Consistent? |
|---------|----------------|----------------|-------------|
| admin | `packages/admin` | `core/admin` | Yes (separate) |
| guardian | `core/guardian` (source + docker) | `core/guardian` | **No -- source mixed with docker context** |
| memory-server | `core/memory` (source + docker) | `core/memory` | **No -- source mixed with docker context** |
| memory-lib | `packages/memory` | N/A | N/A |
| scheduler | `packages/scheduler` | `core/scheduler` | Yes (separate) |
| assistant | N/A (config only) | `core/assistant` | N/A |
| channel | N/A (startup script) | `core/channel` | N/A |

Guardian and memory-server break the stated pattern. Either:
- Move guardian source to `packages/guardian` (matching scheduler pattern), or
- Accept that `core/` is where some services have BOTH source and Docker context, and update the documentation

**Recommendation:** The simplest fix is to move `core/guardian/src/` to `packages/guardian/src/` and `core/memory/src/` to `packages/memory-server/src/`, keeping `core/` as pure Docker build contexts. This eliminates the naming collisions and makes the convention real.

---

## 3. .openpalm/ Directory

**Severity: LOW -- Well-organized with minor naming inconsistencies.**

Structure:
```
.openpalm/
  config/
    stack.yaml           (.yaml extension)
    host.yaml            (.yaml extension)
    automations/         (7 .yml files)
    assistant/opencode.json
    memory/default_config.json
    guardian/.gitkeep
  stack/
    core.compose.yml     (.yml extension)
    addons/
      <8 addon dirs>/    (each: compose.yml + .env.schema)
  vault/
    user/user.env.schema + user.env
    stack/stack.env.schema + stack.env
    redact.env.schema
  data/
  backups/
  logs/
```

**Issue: Mixed YAML extensions.** Config files use `.yaml` (stack.yaml, host.yaml) while automations and compose files use `.yml`. Docker Compose convention favors `.yml` but the YAML spec says `.yaml` is preferred. Pick one and be consistent.

**Issue: `config/guardian/.gitkeep`** is the only `.gitkeep` in the entire `.openpalm/` tree. Either there is a plan for guardian config files here, or this placeholder should be removed.

Otherwise the structure is logical and well-separated.

---

## 4. Naming Conventions

**Severity: MEDIUM -- Mostly consistent with one notable exception.**

### File naming:

- **TypeScript files:** Overwhelmingly kebab-case (`server.ts`, `stack-spec.ts`, `config-persistence.ts`). This is correct and consistent.
- **One exception:** `ConnectionForm.svelte.spec.ts` uses PascalCase, which follows the Svelte component naming convention (the component is `ConnectionForm.svelte`). This is acceptable since it follows Svelte community convention.
- **No snake_case TypeScript files found.** Good.

### Directory naming:

- Packages use kebab-case consistently (`channel-api`, `admin-tools`, `channels-sdk`).
- SvelteKit route directories use kebab-case with bracket params (`[id]`, `[name]`). Standard.

### Package name inconsistency:

- `packages/channels-sdk` -- note the **plural** "channels"
- `packages/channel-api`, `packages/channel-chat` -- note the **singular** "channel"

This is mildly confusing. The SDK serves multiple channels, so plural makes sense, but it means you search for "channel" and must also remember "channels".

### Import patterns:

Three import styles are used, all appropriately:
1. **`@openpalm/lib`** -- package imports for the shared library (correct)
2. **`$lib/`** -- SvelteKit alias imports within admin (correct, SvelteKit convention)
3. **Relative imports** -- within the same package (correct)

No concerns here.

---

## 5. Package Structure Consistency

**Severity: HIGH -- Inconsistent across packages.**

| Package | `tsconfig.json` | Test dir | Test pattern | `dist/` | README |
|---------|:---:|:---:|:---:|:---:|:---:|
| admin | Yes | `e2e/` + colocated `.test.ts` | Vitest + Playwright | build/ | Yes |
| admin-tools | **No** | `tests/` | bun test | dist/ (tracked in git!) | Yes |
| assistant-tools | **No** | `tests/` | bun test | dist/ (1 file tracked!) | Yes |
| channel-api | **No** | Colocated `src/index.test.ts` | bun test | N/A | Yes |
| channel-chat | **No** | Colocated `src/index.test.ts` | bun test | N/A | Yes |
| channel-discord | **No** | Colocated in `src/` | bun test | N/A | Yes |
| channel-slack | Yes | Colocated in `src/` | bun test | N/A | Yes |
| channel-voice | Yes | `e2e/` + colocated | Playwright + bun | N/A | Yes |
| channels-sdk | **No** | Colocated in `src/` | bun test | N/A | Yes |
| cli | **No** | `e2e/` + colocated | Playwright + bun | dist/ | Yes |
| lib | Yes | Colocated in `src/control-plane/` | bun test | N/A | Yes |
| memory | Yes | `__tests__/` + `benchmark-tests/` + `parity-tests/` | bun test | N/A | Yes |
| scheduler | Yes | Colocated in `src/` | bun test | N/A | Yes |

**Problems:**

1. **`tsconfig.json` presence is inconsistent.** 6 of 13 packages have it, 7 do not. Either all Bun-based packages need one or none do. Having it in some but not others suggests drift.

2. **Test location is wildly inconsistent.** Five different patterns:
   - Colocated next to source (`src/*.test.ts`) -- channels, sdk, lib, scheduler
   - Separate `tests/` directory -- admin-tools, assistant-tools
   - Separate `__tests__/` directory (Jest convention) -- memory
   - Separate `e2e/` directory -- admin, cli, channel-voice
   - Separate `benchmark-tests/` and `parity-tests/` -- memory

   The colocated vs. `tests/` vs. `__tests__` split has no justification. Pick a convention.

3. **`dist/` tracked in git for `assistant-tools`.** Build artifacts should never be committed. The `.gitignore` has `packages/admin-tools/dist/index.js` (singular file exception) but `packages/assistant-tools/dist/` has a tracked file.

4. **`channel-discord` has its own `docs/` directory** with a single `plan.md` file inside. No other channel has this. This is orphaned planning material.

---

## 6. scripts/ Directory

**Severity: LOW -- Reasonable but could use minor cleanup.**

Contents (14 files):
- `dev-setup.sh` -- dev environment setup
- `dev-e2e-test.sh` -- e2e test runner
- `release-e2e-test.sh` -- release test runner
- `test-tier.sh`, `run-all-tiers.sh` -- tiered test runners
- `upgrade-test.sh` -- upgrade test runner
- `release.sh`, `bump-platform.sh` -- release scripts
- `install-hooks.sh` -- git hooks installer
- `validate-registry.sh` -- registry validation
- `setup.sh`, `setup.ps1`, `pass-init.sh` -- setup scripts
- `README.md` -- documentation
- `hooks/` -- git hook scripts
- `iso/` -- Debian kiosk ISO builder

The `iso/` directory (kiosk ISO builder) is a significant sub-project with its own file tree. It is somewhat surprising to find inside `scripts/`. If this is an active feature, it might warrant its own top-level directory or at minimum more documentation about its relationship to the main project.

The script naming is consistent (kebab-case with `.sh` extension). The PowerShell script (`setup.ps1`) is the Windows equivalent of `setup.sh`.

---

## 7. docs/ Directory

**Severity: MEDIUM -- Confusing dual-location for authoritative docs.**

Structure:
```
docs/
  README.md
  backup-restore.md
  how-it-works.md
  installation.md
  managing-openpalm.md
  password-management.md
  setup-guide.md
  setup-walkthrough.md
  system-requirements.md
  troubleshooting.md
  channels/
    community-channels.md
    discord-setup.md
    slack-setup.md
  operations/
    manual-compose-runbook.md
  technical/
    api-spec.md
    architecture.svg
    bunjs-rules.md
    code-quality-principles.md
    directory-structure.md
    environment-and-mounts.md
    manual-setup.md
    memory-privacy.md
    opencode-configuration.md
    package-management.md
    sveltekit-rules.md
    testing-workflow.md
    authoritative/
      core-principles.md
      design-intent.md
      docker-dependency-resolution.md
      foundations.md
```

**Problem 1: CLAUDE.md references are broken.**

`CLAUDE.md` references `docs/technical/core-principles.md` and `docs/technical/docker-dependency-resolution.md` multiple times, but these files actually live at `docs/technical/authoritative/core-principles.md` and `docs/technical/authoritative/docker-dependency-resolution.md`. This means every agent instruction pointing to these "authoritative" documents is a dead link. This is especially ironic given that `CLAUDE.md` calls `core-principles.md` "the authoritative source of architectural rules."

`AGENTS.md` correctly references the `authoritative/` subdirectory path, making the inconsistency between the two agent instruction files even more confusing.

**Problem 2: The `authoritative/` subdirectory creates confusion.**

Having `docs/technical/code-quality-principles.md` (non-authoritative) alongside `docs/technical/authoritative/core-principles.md` (authoritative) implies a hierarchy of trust that is not clearly explained. Why are some technical docs authoritative and others not? Who decides? If `core-principles.md` and `docker-dependency-resolution.md` are the only truly binding documents, they should be more prominent, not buried one level deeper.

**Problem 3: `.github/roadmap/` contains 41 planning files.**

This is a significant amount of planning material living in `.github/` which is typically reserved for workflows, templates, and community health files. The roadmap documents (agent reports, cleanup plans, implementation plans) might be better served in `docs/roadmap/` or a dedicated planning directory. Having 41 files in `.github/` makes it harder to find the actual CI/CD configuration.

---

## 8. Test File Organization

**Severity: MEDIUM -- Already covered in Section 5 but worth summarizing.**

Five distinct test placement patterns exist:

1. **Colocated (`src/foo.test.ts`)** -- lib, channels-sdk, channel-*, scheduler, cli (partial)
2. **Separate `tests/`** -- admin-tools, assistant-tools
3. **Separate `__tests__/`** -- memory (Jest convention in a Bun project)
4. **Separate `e2e/`** -- admin, cli, channel-voice
5. **Specialized dirs** (`benchmark-tests/`, `parity-tests/`) -- memory

The memory package alone has THREE different test directories (`src/__tests__/`, `benchmark-tests/`, `parity-tests/`). This is the worst offender.

Tests in `core/guardian/src/` and `core/memory/src/` follow the colocated pattern, which is fine, but reinforces the problem of these being application source in a "Docker build context" directory.

**Recommendation:** Standardize on colocated tests for unit tests (`foo.test.ts` next to `foo.ts`) and a top-level `e2e/` directory for integration/E2E tests. Rename `__tests__/` to match.

---

## 9. Config File Sprawl

**Severity: LOW-MEDIUM -- Reasonable for a monorepo but some consolidation possible.**

Counts:
- **7 tsconfig.json** files (6 in packages + 1 generated by SvelteKit)
- **17 package.json** files (1 root + 13 packages + 2 core workspaces + 1 .opencode)
- **12 publish workflow files** (one per package, though `publish-npm-package.yml` is a reusable workflow)
- **11 .env.schema** files (well-organized in `.openpalm/`)
- **18 compose YAML files** (1 core + 8 addons + 1 dev overlay + 1 benchmark)

The 12 individual publish workflows could potentially be consolidated using a matrix strategy in a single workflow, but since `publish-npm-package.yml` already exists as the reusable base, the current approach has some justification (per-package path triggers).

**Issue: The dev compose overlay (`compose.dev.yaml`) at root uses `.yaml` while ALL stack compose files use `.yml`.** Pick one.

---

## 10. Dead Files and Artifacts

**Severity: HIGH -- Several confirmed dead/stale items.**

| File/Dir | Status | Action |
|----------|--------|--------|
| `before-navigate.png` (root) | **Git-tracked, zero references** | Delete from repo |
| `.private/voice-avatar-tauri-app-streaming.zip` (371KB) | Not tracked but sitting on disk | Remove from disk |
| `.private/index` | Empty file (0 bytes) | Remove |
| `packages/channel-discord/docs/plan.md` | Orphaned planning doc, only channel with its own docs/ | Move to `.github/roadmap/` or delete |
| `packages/assistant-tools/dist/` | Build artifact tracked in git (1 file) | Remove from git tracking |
| `.dev-0.9.0/`, `.dev-tmp3/` | Stale dev environment snapshots | Remove from disk |
| `test-results/` (root) | Playwright artifact directory | Already gitignored but directory exists; clean up |
| `compose.dev.yaml` | Named `.yaml` while all stack files use `.yml` | Rename to `compose.dev.yml` for consistency |

---

## 11. CLAUDE.md vs AGENTS.md Inconsistency

**Severity: HIGH -- These two files disagree on critical paths.**

Both files serve as agent instructions. They should be consistent.

| Aspect | CLAUDE.md | AGENTS.md |
|--------|-----------|-----------|
| Core principles path | `docs/technical/core-principles.md` (WRONG) | `docs/technical/authoritative/core-principles.md` (CORRECT) |
| Repo layout | Detailed directory tables | Brief one-liner |
| Channel references | `channels/chat/` (old path?) | Matches current structure |

`CLAUDE.md` is 16,471 bytes and extremely detailed. `AGENTS.md` is 9,716 bytes with some overlap. The duplication between them creates maintenance burden and, as demonstrated, drift. The broken path in `CLAUDE.md` is the most dangerous instance.

---

## Summary of Findings by Severity

### HIGH
1. **`packages/` vs `core/` split is inconsistent** -- guardian and memory-server have source code in `core/` despite convention saying `core/` is for Docker contexts only. Three name collisions between the two directories.
2. **CLAUDE.md contains broken references** to `docs/technical/core-principles.md` and `docs/technical/docker-dependency-resolution.md` -- these files live in `docs/technical/authoritative/`.
3. **`before-navigate.png` is a dead, git-tracked file** at the repo root.
4. **Package structure is inconsistent** -- tsconfig presence, test directory placement, and dist tracking all vary without justification.

### MEDIUM
5. **Root clutter** -- `fta.json`, stray screenshot, test-results directory.
6. **YAML extension inconsistency** -- `.yml` for compose/automations, `.yaml` for config files, `.yaml` for the dev compose override.
7. **`docs/technical/authoritative/` creates confusion** about which docs matter.
8. **`.github/roadmap/` has 41 planning files** that are not GitHub-specific.
9. **Test organization** uses five different patterns across packages.

### LOW
10. `.openpalm/` directory is well-organized.
11. `scripts/` directory is reasonable.
12. File naming conventions are mostly consistent (kebab-case).
13. Import patterns are clean and appropriate.

---

## Top 5 Concrete Actions

1. **Fix CLAUDE.md references.** Update all occurrences of `docs/technical/core-principles.md` to `docs/technical/authoritative/core-principles.md` (and same for `docker-dependency-resolution.md`). This is the highest-impact, lowest-effort fix.

2. **Delete `before-navigate.png` from git.** `git rm before-navigate.png && git commit`.

3. **Standardize the `core/` vs `packages/` split.** Move `core/guardian/src/` to `packages/guardian/src/` and `core/memory/src/` to a new `packages/memory-server/src/`. Keep `core/` as pure Docker build contexts. Update workspace declarations.

4. **Pick a YAML extension and enforce it.** Recommend `.yml` (shorter, Docker Compose convention). Rename `stack.yaml` to `stack.yml`, `host.yaml` to `host.yml`, and `compose.dev.yaml` to `compose.dev.yml`.

5. **Standardize test placement.** Adopt colocated `*.test.ts` for unit tests everywhere. Rename `packages/memory/src/__tests__/` to colocated files. Keep `e2e/` for integration tests.
