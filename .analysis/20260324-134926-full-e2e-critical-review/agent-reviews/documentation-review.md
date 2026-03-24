# Documentation & Information Architecture Review

**Date:** 2026-03-24
**Branch:** release/0.10.0
**Reviewer:** Documentation & Information Architecture Agent

---

## Executive Summary

The documentation system has serious structural problems. The most damaging issue is a pervasive broken link to the project's most important document (`core-principles.md`), referenced incorrectly in 44 files including CLAUDE.md and the root README. Beyond that, the root AGENTS.md is severely outdated and describes an architecture from a prior version. There is significant content duplication across 5+ documents that all describe the same mounts, env vars, and directory layout, creating a maintenance burden and divergence risk. Several vault/filesystem claims in documentation contradict the actual shipped `.openpalm/` bundle. Package metadata across most packages is missing descriptions.

**Critical issues:** 4
**High issues:** 9
**Medium issues:** 10
**Low issues:** 6

---

## 1. CLAUDE.md Analysis

### 1.1 Broken Link to Core Principles -- CRITICAL

**File:** `/CLAUDE.md` lines 10, 165, 192, 210
**Also:** `/README.md` lines 103, 121

CLAUDE.md references `docs/technical/core-principles.md` (4 occurrences) and the root README references it twice. This file does not exist at that path. The actual location is `docs/technical/authoritative/core-principles.md`. This is the single most important document in the project according to CLAUDE.md itself ("authoritative source of architectural rules"). 44 files across the repo use this broken path, while only 12 use the correct one.

**Impact:** Every AI agent and contributor following CLAUDE.md is directed to a non-existent file for the project's foundational rules.

### 1.2 Broken Link to Docker Dependency Resolution -- CRITICAL

**File:** `/CLAUDE.md` lines 181, 195, 211

CLAUDE.md references `docs/technical/docker-dependency-resolution.md` in three places. This file does not exist at that path. The actual location is `docs/technical/authoritative/docker-dependency-resolution.md`.

### 1.3 Docker Compose Manual Command is Wrong -- HIGH

**File:** `/CLAUDE.md` lines 61-68

The manual Docker compose command shown in CLAUDE.md is:
```
docker compose --project-directory . \
  -f .openpalm/stack/core.compose.yml \
  -f compose.dev.yaml \
  --env-file .dev/vault/stack/stack.env \
  --env-file .dev/vault/user/user.env \
  up --build -d
```

The actual `dev:build` script in `package.json` is:
```
docker compose --project-directory . \
  -f .openpalm/stack/core.compose.yml \
  -f .openpalm/stack/addons/admin/compose.yml \
  -f compose.dev.yaml \
  --env-file .dev/vault/stack/stack.env \
  --env-file .dev/vault/stack/services/memory/managed.env \
  --env-file .dev/vault/user/user.env \
  up --build -d
```

Missing: the admin compose overlay (`-f .openpalm/stack/addons/admin/compose.yml`) and the memory managed env file (`--env-file .dev/vault/stack/services/memory/managed.env`). Running the CLAUDE.md version would produce a stack without admin and potentially misconfigured memory.

### 1.4 wizard:dev Command Description is Inaccurate -- MEDIUM

**File:** `/CLAUDE.md` line 56

CLAUDE.md says `wizard:dev` runs "install --no-start --force with OP_HOME=.dev". The actual script is:
```
rm -rf /tmp/openpalm/.dev && OP_HOME=/tmp/openpalm/.dev bun run packages/cli/src/main.ts install --no-start
```

Three inaccuracies: (1) `OP_HOME` is `/tmp/openpalm/.dev`, not `.dev`; (2) there is no `--force` flag; (3) the script cleans `/tmp/openpalm/.dev` first.

### 1.5 Memory Environment Variables in Foundations Doc are Outdated -- MEDIUM

**File:** `/docs/technical/authoritative/foundations.md` lines 79-85

`foundations.md` lists memory key env as `OPENAI_API_KEY` and `OPENAI_BASE_URL`. The actual compose file now uses `OP_CAP_*` capability variables (`OP_CAP_LLM_PROVIDER`, `OP_CAP_LLM_MODEL`, `OP_CAP_LLM_BASE_URL`, `OP_CAP_LLM_API_KEY`, `OP_CAP_EMBEDDINGS_*`). The `OPENAI_*` vars are also still present in compose but the documentation fails to mention the `OP_CAP_*` variables at all, which are the primary configuration mechanism.

### 1.6 CLAUDE.md Key Files Table is Duplicated -- LOW

**File:** `/CLAUDE.md`

There are two "Key Files" sections (lines 135-147 and lines 206-235). The second is a superset of the first. This is confusing and creates a maintenance burden.

---

## 2. Root README.md Analysis

### 2.1 Broken Links to Non-Existent Files -- CRITICAL

**File:** `/README.md`

| Link text | Referenced path | Actual path |
|---|---|---|
| Core Principles (line 121) | `docs/technical/core-principles.md` | `docs/technical/authoritative/core-principles.md` |
| Manual Setup (line 118) | `docs/manual-setup.md` | `docs/technical/manual-setup.md` |
| Community Channels (line 123) | `docs/community-channels.md` | `docs/channels/community-channels.md` |
| Registry (line 142) | `registry/README.md` | Directory does not exist |

Four broken links in the project's front door. The `registry/` directory has been removed entirely but the README still references it.

### 2.2 Getting Started Command Missing guardian.env -- HIGH

**File:** `/README.md` lines 64-71

The README's quick-start compose command does not include `--env-file ../vault/stack/guardian.env`, but every other compose invocation document (the runbook, the stack README, the foundations doc) includes it as a required third env file. Additionally, `guardian.env` does not exist in the shipped `.openpalm/vault/stack/` bundle (see finding 4.1), so the README's omission might be intentionally avoiding a missing-file error, but this is undocumented and inconsistent.

---

## 3. Root AGENTS.md Analysis

### 3.1 AGENTS.md is Severely Outdated -- CRITICAL

**File:** `/AGENTS.md`

The root AGENTS.md is a historical artifact from an earlier version and contains numerous factual errors:

| Line | Claim | Reality |
|---|---|---|
| 12 | "built on Docker Compose, Caddy, and OpenCode" | Caddy has been retired (per MEMORY.md); no Caddy in shipped compose |
| 13 | `channels/chat/` | Directory does not exist; actual path is `packages/channel-chat/` |
| 32 | "Run UI dev server (port 5173)" | Admin dev server runs on port 8100 per CLAUDE.md |
| 40 | "cd channels/chat && bun run server.ts" | `channels/` directory does not exist |
| 58 | "No test files exist yet" | Hundreds of tests exist across multiple suites |
| 116 | `$assets` and `$registry` Vite aliases | These aliases do not exist in the current `vite.config.ts` |
| 183 | "dropping a `.yml` compose overlay (+ optional `.caddy` snippet) into `channels/`" | Caddy is retired; path is `stack/addons/<name>/` |
| 209 | `packages/admin/src/lib/server/control-plane.ts` | File does not exist |
| 214 | `assets/` directory | Directory does not exist |
| 175 | Uses `CONFIG_HOME` terminology | Current docs use `config/` or `~/.openpalm/config/` |

This file is actively misleading any AI agent or contributor that reads it. It describes an architecture that no longer exists.

---

## 4. Vault/Filesystem Discrepancies

### 4.1 guardian.env and auth.json Missing from Shipped Bundle -- HIGH

**Files:** `.openpalm/vault/stack/`, multiple docs

Every technical document (`foundations.md`, `environment-and-mounts.md`, `directory-structure.md`, `core-principles.md`, `manual-compose-runbook.md`) describes `vault/stack/guardian.env` as a required file loaded by the guardian. The core compose file references it in 4 places (env_file, volume mount, env var). But the shipped `.openpalm/vault/stack/` directory contains only `stack.env` and `stack.env.schema`. There is no `guardian.env` or `auth.json`.

The compose file marks `guardian.env` as `required: false`, so the stack will start, but the documentation never mentions this fallback. Similarly, `auth.json` is mounted into the assistant but does not exist in the shipped bundle. These files are presumably created by the CLI installer, but the documentation around manual setup does not make this clear.

### 4.2 Vault README Contradicts Core Principles on Assistant Mount -- HIGH

**File:** `.openpalm/vault/README.md` line 37

The vault README states: "Assistant mounts only `vault/user/user.env` (read-only)."

This is wrong on two counts:
1. The compose file mounts the entire `vault/user/` directory: `${OP_HOME}/vault/user:/etc/vault` (no `:ro` flag).
2. `core-principles.md` correctly states: "assistant mounts `vault/user/` (the directory, rw)."

The vault README contradicts both the compose file and the authoritative core-principles document.

### 4.3 Scheduler Mounts Underdocumented -- MEDIUM

**Files:** `docs/technical/directory-structure.md` line 107, `docs/technical/authoritative/foundations.md` lines 253-255

Both documents claim the scheduler mounts only `$OP_HOME/config -> /openpalm/config:ro`. The actual compose file (lines 164-167) shows the scheduler also mounts:
- `${OP_HOME}/logs:/openpalm/logs`
- `${OP_HOME}/data:/openpalm/data`

The scheduler has read-write access to the entire `logs/` and `data/` trees. This is a significant underdocumentation of the scheduler's filesystem access.

### 4.4 services/ Subdirectory Referenced but Missing -- MEDIUM

**File:** `docs/technical/authoritative/core-principles.md` line 109

Core principles states: "Guardian, scheduler, and memory receive secrets exclusively through ${VAR} substitution...and optional service-specific managed env files located under `vault/stack/services/<service-name>/`."

The `vault/stack/services/` directory does not exist in the shipped `.openpalm/` bundle. The `dev:build` and `dev:stack` scripts reference `.dev/vault/stack/services/memory/managed.env`, suggesting this is created at dev setup time, but the documentation presents it as a standard feature without explaining when it gets created.

---

## 5. Documentation Duplication & Overlap

### 5.1 Mount/Env/Directory Information Repeated Across 5+ Files -- HIGH

The following documents all describe the same mounts, environment variables, directory layout, and network topology with varying levels of detail and accuracy:

1. `docs/technical/directory-structure.md` (175 lines)
2. `docs/technical/authoritative/foundations.md` (367 lines)
3. `docs/technical/environment-and-mounts.md` (355 lines)
4. `docs/technical/authoritative/core-principles.md` (291 lines, partial overlap)
5. `docs/technical/opencode-configuration.md` (122 lines, partial overlap)
6. `.openpalm/stack/README.md` (69 lines, partial overlap)

`directory-structure.md` is almost entirely a subset of `foundations.md` and `environment-and-mounts.md`. When one of these files gets updated (e.g., the scheduler gains new volume mounts), the others do not get updated, leading to contradictions like the scheduler mount discrepancy in finding 4.3.

### 5.2 Two Manual Setup Docs -- MEDIUM

There are two manual setup documents:
- `docs/technical/manual-setup.md` (174 lines) -- focuses on copy-bundle-and-start flow
- `docs/operations/manual-compose-runbook.md` (410 lines) -- full compose command reference

The `manual-setup.md` file references the runbook extensively and defers all actual compose commands to it. The user flow requires reading both files. This could be consolidated.

### 5.3 Authoritative Directory Adds Unnecessary Hierarchy -- MEDIUM

The `docs/technical/authoritative/` subdirectory contains 4 files (`core-principles.md`, `docker-dependency-resolution.md`, `design-intent.md`, `foundations.md`). The `authoritative/` nesting creates path confusion since 44 files across the repo reference the wrong path (`docs/technical/core-principles.md` instead of `docs/technical/authoritative/core-principles.md`). The "authoritative" designation is handled by a header note in each file, making the subdirectory redundant.

---

## 6. Technical Doc Accuracy

### 6.1 environment-and-mounts.md: Memory Env Vars Partially Outdated -- MEDIUM

**File:** `docs/technical/environment-and-mounts.md` lines 80-88

Lists `OPENAI_API_KEY` and `OPENAI_BASE_URL` as key memory env vars but omits the `OP_CAP_*` capability variables (`SYSTEM_LLM_PROVIDER`, `SYSTEM_LLM_MODEL`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, etc.) that are the primary configuration mechanism in the current compose file. The `OPENAI_*` vars are still present but are secondary.

### 6.2 directory-structure.md: openviking Listed in Tree -- LOW

**File:** `docs/technical/directory-structure.md` line 57

The directory tree shows `openviking` as an addon. The recent commit `3b1a6439` was "chore: remove deprecated OpenViking configuration file", but the addon itself still exists in `.openpalm/stack/addons/openviking/`. The directory-structure doc is technically correct for now, but this may become stale.

### 6.3 testing-workflow.md: Test Count Mismatch with MEMORY.md -- LOW

**File:** `docs/technical/testing-workflow.md`

The testing workflow doc does not include specific test counts, but CLAUDE.md's MEMORY section claims "Admin unit tests: 592 pass" and "Non-admin unit tests: 112 pass". These numbers will drift as tests are added/removed. The testing-workflow doc wisely avoids specific counts, but the MEMORY.md numbers are likely stale.

### 6.4 api-spec.md: Scheduler Listed as Allowed Core Service -- LOW

**File:** `docs/technical/api-spec.md` lines 216-219

The API spec lists allowed core services for container operations as: `assistant`, `guardian`, `memory`, `admin`. It does not list `scheduler`, even though the scheduler is a core service in the compose file. The omission may be intentional (scheduler is always running) but is not explained.

---

## 7. Package Metadata

### 7.1 Most Packages Missing Descriptions -- HIGH

**Finding:** 9 out of 14 packages have no `description` field in their `package.json`:

- `@openpalm/admin` -- no description
- `@openpalm/scheduler` -- no description
- `@openpalm/channels-sdk` -- no description
- `@openpalm/channel-chat` -- no description
- `@openpalm/channel-api` -- no description
- `@openpalm/channel-discord` -- no description
- `@openpalm/channel-slack` -- no description
- `@openpalm/channel-voice` -- no description
- `@openpalm/guardian` -- no description

This is especially problematic for `@openpalm/channels-sdk` and `@openpalm/guardian`, which are npm-published or externally referenced packages.

---

## 8. AGENTS.md Files (Assistant Persona)

### 8.1 Root AGENTS.md is Dangerously Stale (see 3.1 above) -- CRITICAL

Already covered above. The root `AGENTS.md` is the worst documentation artifact in the repo.

### 8.2 assistant-tools AGENTS.md References Broken Doc Path -- MEDIUM

**File:** `packages/assistant-tools/AGENTS.md` line 60

References `docs/technical/docker-dependency-resolution.md` which does not exist. The correct path is `docs/technical/authoritative/docker-dependency-resolution.md`.

### 8.3 core/assistant/opencode/AGENTS.md Mentions Tools Not Described -- LOW

**File:** `core/assistant/opencode/AGENTS.md` line 20

References `memory-feedback`, `memory-exports_*`, and `memory-events_get` tools but provides no documentation on what these do or what arguments they take, unlike the better-documented `memory-search`, `memory-add`, `memory-update`, and `memory-delete`.

---

## 9. Inline Code Comments (Sampling)

### 9.1 Core Compose File Comments are Accurate -- PASS

**File:** `.openpalm/stack/core.compose.yml`

The header comments (lines 1-16) accurately describe the three env files, the directory model, and the service layout. The inline comments for each service are accurate and helpful.

### 9.2 Vault README Comments Inaccurate -- Already Covered (4.2)

---

## 10. Missing Documentation

### 10.1 No Documentation for OP_CAP_* Capability System -- HIGH

The `OP_CAP_*` environment variables (`OP_CAP_LLM_PROVIDER`, `OP_CAP_LLM_MODEL`, `OP_CAP_LLM_BASE_URL`, `OP_CAP_LLM_API_KEY`, `OP_CAP_EMBEDDINGS_*`) are used extensively in the compose file for both memory and assistant services. MEMORY.md mentions "Declarative Capability Injection (v0.11.0)" with a reference to a project memory file, but no technical document in `docs/` explains this system. The `stack.env.schema` may describe individual variables, but there is no conceptual documentation explaining how capabilities are resolved, what `OP_CAP_*` prefix means, or how providers map to capabilities.

### 10.2 No Documentation for Registry System -- MEDIUM

The root README links to `registry/README.md` (which does not exist; the `registry/` directory was removed). The admin API has a full `/admin/registry/*` endpoint set, and multiple AGENTS.md files reference installing from the registry. But there is no documentation explaining what the registry is, how it works, or how to use it.

---

## 11. Cross-Document Contradiction Summary

| Topic | Document A | Document B | Contradiction |
|---|---|---|---|
| Assistant vault mount | `vault/README.md`: "mounts `vault/user/user.env` (read-only)" | `core-principles.md`: "mounts `vault/user/` (the directory, rw)" | Mount target (file vs directory) and mode (ro vs rw) both differ |
| Scheduler mounts | `directory-structure.md`: config:ro only | `core.compose.yml`: config:ro + logs + data | Missing 2 mounts in docs |
| Memory env vars | `foundations.md`: OPENAI_API_KEY, OPENAI_BASE_URL | `core.compose.yml`: OP_CAP_* + OPENAI_* | Primary config mechanism undocumented |
| Core principles path | CLAUDE.md: `docs/technical/core-principles.md` | Filesystem: `docs/technical/authoritative/core-principles.md` | Path mismatch in 44 files |
| Docker dep path | CLAUDE.md: `docs/technical/docker-dependency-resolution.md` | Filesystem: `docs/technical/authoritative/docker-dependency-resolution.md` | Path mismatch |
| guardian.env existence | All docs: assume it exists | `.openpalm/vault/stack/`: not shipped | File missing from bundle |

---

## 12. Recommendations (Prioritized)

### Immediate (blocks contributors)

1. **Fix CLAUDE.md core-principles path** -- Change all 4 references from `docs/technical/core-principles.md` to `docs/technical/authoritative/core-principles.md`. Do the same for the docker-dependency-resolution path. Fix the same in README.md (2 references).

2. **Rewrite or delete root AGENTS.md** -- It references Caddy (retired), `channels/` (removed), `assets/` (removed), `control-plane.ts` (removed), claims no tests exist (hundreds exist), and describes stale architecture. Either rewrite it to match CLAUDE.md's content or delete it and let CLAUDE.md serve as the authoritative project-level instruction file.

3. **Fix README.md broken links** -- Fix `docs/manual-setup.md` to `docs/technical/manual-setup.md`, `docs/community-channels.md` to `docs/channels/community-channels.md`, remove `registry/README.md` link.

### Short-term (reduces confusion)

4. **Update CLAUDE.md dev:build command** -- Add the missing `-f .openpalm/stack/addons/admin/compose.yml` and `--env-file .dev/vault/stack/services/memory/managed.env`.

5. **Fix vault/README.md mount claim** -- Change "mounts only `vault/user/user.env` (read-only)" to "mounts `vault/user/` directory (read-write)".

6. **Update scheduler mount documentation** in `directory-structure.md` and `foundations.md` to include `logs/` and `data/` mounts.

7. **Add package.json descriptions** to all 9 packages missing them.

### Medium-term (reduces maintenance burden)

8. **Consolidate duplicate docs** -- `directory-structure.md` should be deleted or reduced to a cross-reference, since `foundations.md` and `environment-and-mounts.md` are strict supersets.

9. **Consider flattening `authoritative/`** -- Move the 4 files from `docs/technical/authoritative/` up to `docs/technical/` to eliminate the path confusion causing 44 broken references. The "authoritative" header note in each file is sufficient.

10. **Document the OP_CAP_* capability system** -- Add a section to `environment-and-mounts.md` or a new doc explaining how capabilities map from provider selections to OP_CAP_* env vars.

---

## Appendix: File Existence Verification

### Files Referenced in CLAUDE.md/README.md That Do Not Exist

| Referenced path | Status | Correct path |
|---|---|---|
| `docs/technical/core-principles.md` | MISSING | `docs/technical/authoritative/core-principles.md` |
| `docs/technical/docker-dependency-resolution.md` | MISSING | `docs/technical/authoritative/docker-dependency-resolution.md` |
| `docs/manual-setup.md` | MISSING | `docs/technical/manual-setup.md` |
| `docs/community-channels.md` | MISSING | `docs/channels/community-channels.md` |
| `registry/README.md` | MISSING | Directory removed |

### Files Referenced in Root AGENTS.md That Do Not Exist

| Referenced path | Status |
|---|---|
| `packages/admin/src/lib/server/control-plane.ts` | MISSING (removed in restructure) |
| `channels/chat/` directory | MISSING (now `packages/channel-chat/`) |
| `assets/` directory | MISSING (now `.openpalm/`) |

### Files Referenced in Docs That Do Not Exist in Shipped Bundle

| Referenced path | Status | Notes |
|---|---|---|
| `vault/stack/guardian.env` | NOT SHIPPED | Compose marks as `required: false`; created by installer |
| `vault/stack/auth.json` | NOT SHIPPED | Created by installer |
| `vault/stack/services/` | NOT SHIPPED | Created by dev-setup.sh |
