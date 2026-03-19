# v0.10.0 Agent Review — Consolidated Voting Results

Generated 2026-03-18 from 5 review agents: Architecture (A), Security (S), Implementation Feasibility (F), Product & UX (P), Technical Debt (T).

---

## Voting Legend

- **YES** = Agent explicitly recommends this change
- **NO** = Agent explicitly opposes this change
- **—** = Agent did not address this specific recommendation
- **PASS** = 3+ of 5 agents agree (majority rule)

---

## Issue-Level Changes

| # | Recommendation | A | S | F | P | T | Result |
|---|---------------|---|---|---|---|---|--------|
| 1 | **DEFER #302 (TTS/STT) from 0.10.0** — No plan, no scope, no dependencies | YES | NO | YES | YES | NO | **3/5 PASS** |
| 2 | **CLOSE #13 as superseded by component system** — References dead code paths, all features subsumed by #301 | YES | YES | YES | YES | YES | **5/5 PASS** |
| 3 | **RETITLE #301 → "Unified Component System"** — Original "configurable services" concept subsumed by component model | YES | — | YES | YES | YES | **4/5 PASS** |
| 4 | **SCOPE DOWN #298 to Viking component + assistant tools only** — Defer eval framework and MemRL Q-values to 0.11.0 | YES | — | YES | YES | — | **3/5 PASS** |
| 5 | **SCOPE #304 to Phase 1-2 for 0.10.0** — Keep foundations + diagnostics, defer remediation + hardening | YES | YES | NO* | YES | YES | **4/5 PASS** |
| 6 | **SPLIT #300: Phases 0-4 in 0.10.0, defer Phases 5-7** — Ship hardening + auth + backend + pass + API; defer UI, connections refactor, migration tooling | YES | — | YES† | YES | — | **3/5 PASS** |
| 7 | **KEEP #315 (Azure ACA) in 0.10.0** — Pure additive, no core changes, can develop in parallel | YES | YES | NO | YES | YES | **4/5 PASS** |

\* Feasibility recommends deferring #304 entirely to 0.11.0, outvoted by 4 agents who say keep but scope down.
† Feasibility recommends Phases 0-1 only, but defers to the compromise of 0-4.

---

## Plan Document Changes

| # | Recommendation | A | S | F | P | T | Result |
|---|---------------|---|---|---|---|---|--------|
| 8 | **ADD CLI Integration section to components plan** — CLI must support component model without admin | YES | — | — | YES | YES | **3/5 PASS** |
| 9 | **ADD Cross-Component Env Injection section to components plan** — How Viking injects vars into assistant | YES | YES | YES | — | — | **3/5 PASS** |
| 10 | **ADD Upgrade path / migration detection** — Banner in admin UI, CLI warning for legacy channels | YES | — | YES | YES | YES | **4/5 PASS** |
| 11 | **ADD Component testing strategy** — Unit tests, E2E lifecycle, migration regression tests | YES | — | YES | — | YES | **3/5 PASS** |
| 12 | **SPLIT knowledge roadmap** — Viking + MCP stay 0.10.0; eval + MemRL become separate 0.11.0 docs | YES | — | YES | YES | — | **3/5 PASS** |
| 13 | **FIX component secret naming collision in pass plan** — Namespace by instance ID | YES | YES | — | — | — | **2/5 FAIL** |
| 14 | **REMOVE `eval` in pass-init.sh** — Shell injection risk | YES | YES | — | — | — | **2/5 FAIL** |
| 15 | **ADD Compose overlay validator for security** — Reject privileged, cap_add, restricted networks | — | YES | — | — | — | **1/5 FAIL** |
| 16 | **STANDARDIZE API path convention (/api/* vs /admin/*)** | YES | — | — | — | — | **1/5 FAIL** |
| 17 | **ADD tab consolidation plan to components proposal** — Target 5 tabs max | — | — | — | YES | — | **1/5 FAIL** |
| 18 | **KEEP Caddy as core service (not component) for 0.10.0** | — | — | YES | — | — | **1/5 FAIL** |
| 19 | **ADD new GitHub issues: component impl, legacy removal, CI updates** | — | — | — | — | YES | **1/5 FAIL** |
| 20 | **FIX broken writeOpenCodeProviderConfig()** | — | — | — | — | YES | **1/5 FAIL** |
| 21 | **ADD auth on admin OpenCode port 4097** | — | YES | — | — | — | **1/5 FAIL** |
| 22 | **ADD Quick Start wizard path (2-step minimum)** | — | — | — | YES | — | **1/5 FAIL** |

---

## Summary of Majority-Approved Changes

### Issues (7 changes):
1. DEFER #302 from 0.10.0 milestone
2. CLOSE #13 as superseded by #301
3. RETITLE #301 → "Unified Component System"
4. SCOPE DOWN #298 to Viking component + tools only
5. SCOPE #304 to Phase 1-2
6. SPLIT #300 to Phases 0-4 for 0.10.0
7. KEEP #315 in 0.10.0

### Plan Documents (5 changes):
8. ADD CLI Integration section to components plan
9. ADD Cross-Component Env Injection section to components plan
10. ADD Upgrade path / migration detection section
11. ADD Component testing strategy
12. SPLIT knowledge roadmap (Viking+MCP = 0.10.0, eval+MemRL = 0.11.0)

### Total: 12 approved changes to implement.

---

## Filesystem & Mounts Refactor -- Voting Results (2026-03-19)

Generated from the addendum sections of all 5 agent reports reviewing `fs-mounts-refactor.md` + `fs-layout.md`.

Agent key: **A** = Architecture, **S** = Security, **F** = Feasibility, **P** = Product & UX, **T** = Tech Debt

---

### Core Proposal Votes

| # | Recommendation | A | S | F | P | T | Result |
|---|---------------|---|---|---|---|---|--------|
| R1 | **ADOPT the FS refactor (single `~/.openpalm/` root replacing three-tier XDG)** | YES | YES | YES | YES | YES | **5/5 PASS** |
| R2 | **ADOPT the vault/ boundary model** (secrets isolated in `vault/`, per-container scoped mounts) | YES | YES | YES | YES | YES | **5/5 PASS** |
| R3 | **ADOPT the staging tier elimination** (replace with validate-in-place + snapshot rollback) | YES | YES | YES | YES | YES | **5/5 PASS** |
| R4 | **ADOPT the two-file env model** (`vault/user.env` for user secrets + `vault/system.env` for system secrets) | YES | YES | YES | YES | YES | **5/5 PASS** |
| R5 | **ADOPT the hot-reload file watcher** for `user.env` in the assistant | YES | YES | NO | YES | YES | **4/5 PASS** |
| R6 | **INCLUDE FS refactor in 0.10.0 scope** (ship alongside component system rewrite) | YES | YES | YES | NO | YES | **4/5 PASS** |

Notes:
- R5: Feasibility recommends deferring hot-reload to 0.10.1 as a convenience feature, not a structural requirement. Outvoted 4-1.
- R6: Product & UX prefers shipping FS refactor and component system in separate releases to reduce upgrade risk. Outvoted 4-1, contingent on automated migration tool (see R12).

---

### Decision Reversals

| # | Recommendation | A | S | F | P | T | Result |
|---|---------------|---|---|---|---|---|--------|
| R7 | **REVERSE decision Q2** (preserve three-tier XDG) -- the single-root model preserves semantic separation while eliminating operational overhead; Q2 was decided before this alternative was articulated | YES | YES | YES | YES | YES | **5/5 PASS** |
| R8 | **REASSESS decision Q9** (ov.conf in DATA_HOME) -- clarify whether `ov.conf` contains secrets warranting vault placement, or belongs in component instance directory | YES | -- | -- | -- | -- | **1/5 FAIL** |

---

### Proposal Modifications

| # | Recommendation | A | S | F | P | T | Result |
|---|---------------|---|---|---|---|---|--------|
| R9 | **UPDATE: Move rollback data from `~/.cache/openpalm/rollback/` to `~/.openpalm/backups/rollback/`** -- cache directories may be cleared by OS maintenance; rollback data is safety-critical | YES | -- | YES | -- | -- | **2/5 FAIL** |
| R10 | **UPDATE: Specify atomic writes (temp + fsync + rename) for all config/vault file mutations** -- staging provided implicit atomicity; validate-in-place does not | YES | -- | -- | -- | YES | **2/5 FAIL** |
| R11 | **UPDATE: Reconcile `config/components/` (compose overlays) with component plan's `data/components/` (instance directories)** -- these are two unconnected concepts that must be integrated | YES | -- | -- | -- | -- | **1/5 FAIL** |
| R12 | **ADD: Automated migration tool (`openpalm migrate`)** for XDG-to-`~/.openpalm/` transition, including env file splitting, directory relocation, and validation | YES | YES | YES | YES | YES | **5/5 PASS** |
| R13 | **ADD: Migration must handle legacy `OPENPALM_CONFIG_HOME`/`OPENPALM_DATA_HOME`/`OPENPALM_STATE_HOME` env vars** -- error or migration message if present | YES | -- | -- | -- | YES | **2/5 FAIL** |
| R14 | **UPDATE: PlaintextBackend in pass plan must handle two-file model** (`user.env` vs `system.env`) with file-routing layer for each secret key | YES | YES | -- | -- | -- | **2/5 FAIL** |
| R15 | **UPDATE: Hot-reload must apply env var changes atomically** (parse full file, then swap all values, not key-by-key) | YES | -- | -- | -- | YES | **2/5 FAIL** |
| R16 | **UPDATE: Hot-reload must verify OpenCode re-reads `process.env` per-request** rather than caching provider config at startup | YES | -- | -- | -- | -- | **1/5 FAIL** |
| R17 | **UPDATE: Derive `ALLOWED_KEYS` set from `user.env.schema`** rather than hardcoding a second list | YES | -- | -- | -- | -- | **1/5 FAIL** |
| R18 | **UPDATE: Add polling fallback for `fs.watch`** on platforms where it is unreliable (NFS, CIFS, overlay FS) | YES | -- | -- | -- | -- | **1/5 FAIL** |
| R19 | **ADD: Change-detection mechanism to replace `manifest.json`** -- checksum or timestamp file to make `openpalm apply` a no-op when nothing changed | YES | -- | -- | -- | -- | **1/5 FAIL** |
| R20 | **UPDATE: Justify assistant mount of `config/` at `/etc/openpalm` (read-only)** -- broader read surface than current model; consider mounting only `config/assistant/` instead | YES | -- | -- | -- | -- | **1/5 FAIL** |
| R21 | **UPDATE: Mount count table in proposal Section 5.2** -- explain why assistant going from 6 to 8 mounts is acceptable | YES | -- | -- | -- | -- | **1/5 FAIL** |
| R22 | **ADD: File-level mount constraint for assistant's `user.env`** -- MUST be file-level bind mount, NOT directory mount of `vault/`; document as security-critical invariant | -- | YES | -- | -- | -- | **1/5 FAIL** |
| R23 | **ADD: Rollback directory permissions** -- `0o700` for directory, `0o600` for env files within it | -- | YES | -- | -- | -- | **1/5 FAIL** |
| R24 | **ADD: Stale secret cleanup in rollback** -- delete snapshot after successful deploy or redact secret values | -- | YES | -- | -- | -- | **1/5 FAIL** |
| R25 | **ADD: Hot-reload watcher hardening** -- size check (reject > 64KB), debounce (500ms), audit logging of key updates | -- | YES | -- | -- | YES | **2/5 FAIL** |
| R26 | **ADD: Compose overlay variable reference validation** -- reject component environment blocks referencing system-secret vars like `OPENPALM_ADMIN_TOKEN` via `${VAR}` | -- | YES | -- | -- | -- | **1/5 FAIL** |
| R27 | **UPDATE: Varlock schema split** -- `secrets.env.schema` becomes `user.env.schema` + `system.env.schema` with separate `@plugin` declarations | -- | YES | -- | -- | -- | **1/5 FAIL** |
| R28 | **ADD: Document vault/ directory permissions** -- `vault/` at `0o700`, env files at `0o600`, schema files at `0o644` | -- | YES | -- | -- | -- | **1/5 FAIL** |
| R29 | **DEFER hot-reload to 0.10.1** -- convenience feature, not structural; adds testing complexity (fs.watch platform behavior, race conditions, SDK caching) | -- | -- | YES | -- | -- | **1/5 FAIL** |
| R30 | **UPDATE: Revised 0.10.0 scope estimate** -- FS refactor adds +8-12 net working days; total 44-65 days; achievable with 2 developers over 6-8 weeks | -- | -- | YES | -- | -- | **1/5 FAIL** |
| R31 | **REMOVE `openpalm.yml` from FS refactor scope for 0.10.0** -- conflicts with component system's `enabled.json` as dual sources of truth; defer to 0.10.1 | -- | -- | YES | -- | -- | **1/5 FAIL** |
| R32 | **UPDATE: Document hot-reload asymmetry** -- assistant hot-reloads instantly, memory/guardian require `openpalm apply`; consider `openpalm reload-keys` convenience command | -- | -- | -- | YES | -- | **1/5 FAIL** |
| R33 | **UPDATE: Define `openpalm.yml` vs `config/components/` precedence** -- what happens when they disagree (e.g., `ollama: false` but `ollama.yml` exists) | -- | -- | -- | YES | -- | **1/5 FAIL** |
| R34 | **UPDATE: Expand rollback to retain multiple snapshots** -- last 3 with timestamps, `openpalm rollback --list` and `--to <timestamp>` | -- | -- | -- | YES | -- | **1/5 FAIL** |
| R35 | **ADD: Document partial restore procedures** -- recovering just secrets, just a service's data, or config without overwriting data | -- | -- | -- | YES | -- | **1/5 FAIL** |
| R36 | **DEFER FS refactor to separate release from component system** -- two breaking changes in one release compounds upgrade risk | -- | -- | -- | YES | -- | **1/5 FAIL** |
| R37 | **UPDATE: Clarify `~/.cache/openpalm/` vs `~/.openpalm/` relationship** -- two root paths undermines "single root" simplification; consider `~/.openpalm/.cache/` instead | -- | -- | -- | YES | -- | **1/5 FAIL** |
| R38 | **ADD: `openpalm doctor`/`openpalm status` command** -- report on all subdirectories: config count, vault health, data sizes, log sizes | -- | -- | -- | YES | -- | **1/5 FAIL** |
| R39 | **UPDATE: Sequence FS refactor as Phase 0 of 0.10.0** (before component system) -- component system depends on new paths; avoids double rewrite | -- | -- | -- | -- | YES | **1/5 FAIL** |
| R40 | **ADD: Create `home.ts` module** replacing `paths.ts` with `resolveOpenPalmHome()` + subdirectory accessors; support legacy env vars with deprecation warning | -- | -- | -- | -- | YES | **1/5 FAIL** |
| R41 | **ADD: `migrateFromXdgLayout()` function** -- detect old XDG dirs, create `~/.openpalm/`, move files, split env files, skip STATE_HOME | -- | -- | -- | -- | YES | **1/5 FAIL** |
| R42 | **REMOVE: Delete `staging.ts` entirely** after refactor lands -- clean cut, not incremental deprecation | -- | -- | -- | -- | YES | **1/5 FAIL** |
| R43 | **REMOVE: Delete `ArtifactMeta` type, `artifacts`/`artifactMeta` fields from `ControlPlaneState`, and manifest endpoint** | -- | -- | -- | -- | YES | **1/5 FAIL** |
| R44 | **UPDATE: Redesign `ControlPlaneState` type** -- replace `stateDir`/`artifacts`/`artifactMeta`/`channelSecrets` with `homeDir` + derived subdirectory paths | -- | -- | -- | -- | YES | **1/5 FAIL** |
| R45 | **UPDATE: Audit admin code for host-path-equals-container-path assumptions** -- new layout uses clean container-internal paths, breaking identity-mapped mount pattern | -- | -- | -- | -- | YES | **1/5 FAIL** |
| R46 | **UPDATE: Handle divergent custom XDG paths in migration** -- if user explicitly set different paths for CONFIG/DATA/STATE, warn and require manual resolution | -- | -- | -- | -- | YES | **1/5 FAIL** |
| R47 | **ADD: Hot-reload race condition design** -- admin writes via temp+rename (atomic), watcher debounces 200-500ms | -- | -- | -- | -- | YES | **1/5 FAIL** |
| R48 | **UPDATE: Rewrite `scripts/dev-setup.sh`** for new directory structure | -- | -- | -- | -- | YES | **1/5 FAIL** |
| R49 | **UPDATE: Change compose dev commands** -- `--env-file .dev/vault/system.env --env-file .dev/vault/user.env` | -- | -- | -- | -- | YES | **1/5 FAIL** |
| R50 | **ADD: Benchmark guardian recreate under load** -- `docker compose up -d --force-recreate --no-deps guardian` drops in-flight requests | -- | -- | -- | -- | YES | **1/5 FAIL** |
| R51 | **ADD: Define and validate `openpalm.yml` schema** -- Zod schema in lib + JSON Schema for IDE autocompletion | -- | -- | -- | -- | YES | **1/5 FAIL** |

---

### Plan Cascades

| # | Recommendation | A | S | F | P | T | Result |
|---|---------------|---|---|---|---|---|--------|
| R52 | **UPDATE `core-principles.md`** -- major rewrite of filesystem contract (all three tiers), volume-mount contract (sections A-F), and operational behavior; preserve invariant numbering structure | YES | -- | -- | YES | YES | **3/5 PASS** |
| R53 | **UPDATE `review-decisions.md`** -- explicitly reverse Q2 with full rationale | YES | -- | -- | YES | -- | **2/5 FAIL** |
| R54 | **UPDATE `openpalm-components-plan.md`** -- reconcile with new `~/.openpalm/` paths; replace `${OPENPALM_CONFIG}`/`${OPENPALM_DATA}`/`${OPENPALM_STATE}` references | YES | -- | YES | -- | -- | **2/5 FAIL** |
| R55 | **UPDATE `openpalm-pass-impl-v3.md`** -- PlaintextBackend handles two files; Phase 0 `stageSecretsEnv()` refs become irrelevant; CONFIG_HOME contract section rewrite | YES | YES | -- | -- | -- | **2/5 FAIL** |
| R56 | **UPDATE all compose files** (`docker-compose.yml`, `admin.yml`, `ollama.yml`) -- all bind mount paths change to `OPENPALM_HOME`-relative; guardian loses artifacts mount; env_file directives change | YES | -- | -- | -- | YES | **2/5 FAIL** |
| R57 | **UPDATE `CLAUDE.md`** -- XDG Directory Model table, Architecture Rules, Build & Dev Commands, all CONFIG_HOME/DATA_HOME/STATE_HOME references | YES | -- | -- | YES | YES | **3/5 PASS** |
| R58 | **UPDATE `packages/lib/src/control-plane/paths.ts`** -- collapse three resolve functions into `resolveOpenPalmHome()` + subdirectory accessors | YES | -- | -- | -- | YES | **2/5 FAIL** |
| R59 | **UPDATE `packages/lib/src/control-plane/staging.ts`** -- entire file replaced by validation + snapshot + apply pipeline | YES | -- | -- | -- | YES | **2/5 FAIL** |
| R60 | **UPDATE `packages/lib/src/control-plane/setup.ts`** -- `ensureXdgDirs()` rewritten for `~/.openpalm/` tree | YES | -- | -- | -- | -- | **1/5 FAIL** |
| R61 | **UPDATE `packages/cli/src/lib/staging.ts`** -- `fullComposeArgs()` rewritten for new overlay chain from `config/components/` | YES | -- | -- | -- | -- | **1/5 FAIL** |
| R62 | **UPDATE `scripts/dev-setup.sh`** -- create `~/.openpalm/` structure instead of `.dev/config`, `.dev/data`, `.dev/state` | YES | -- | -- | -- | YES | **2/5 FAIL** |
| R63 | **UPDATE all existing tests referencing XDG paths** -- paths.test.ts, staging tests, install edge case tests (~3,400 lines across 12 test files) | YES | -- | -- | -- | YES | **2/5 FAIL** |
| R64 | **ADD migration section to the refactor proposal** for 0.9.x to 0.10.0 transition -- detect old dirs, move files, handle old env vars | YES | YES | YES | YES | YES | **5/5 PASS** |
| R65 | **UPDATE `docs/technical/core-principles.md`** -- rewrite filesystem contract for vault boundary model and security invariants for per-container scoped mounts | -- | YES | -- | YES | YES | **3/5 PASS** |

---

### New Requirements

| # | Recommendation | A | S | F | P | T | Result |
|---|---------------|---|---|---|---|---|--------|
| R66 | **ADD: Unified migration tool is non-negotiable if FS refactor ships** -- `openpalm migrate` handling both XDG relocation AND channel-to-component transition atomically | -- | -- | YES | YES | -- | **2/5 FAIL** |
| R67 | **ADD: Migration must NOT delete old XDG directories until user confirms success** | -- | YES | -- | -- | -- | **1/5 FAIL** |
| R68 | **ADD: Migration must be atomic** (fully complete or fully rolled back) to avoid half-migrated state | -- | YES | -- | -- | -- | **1/5 FAIL** |
| R69 | **ADD: Document that vault boundary restricts file-level access, not env-var injection** -- `--env-file` is host-side substitution; containers get `${VAR}` values regardless of file mount | YES | YES | -- | -- | -- | **2/5 FAIL** |
| R70 | **ADD: Document XDG departure explicitly** -- explain why `~/.openpalm/` departs from XDG and why it is appropriate for a single-purpose self-hosted stack | YES | -- | -- | -- | -- | **1/5 FAIL** |
| R71 | **ADD: Formalize `config/` and `vault/` ownership rules** in updated core-principles.md -- user-editable, never overwritten by lifecycle operations | YES | -- | -- | -- | -- | **1/5 FAIL** |

---

### Summary of Majority-Approved Changes

**Core Proposal (6 items):**
- R1: ADOPT the FS refactor (single `~/.openpalm/` root) -- 5/5 unanimous
- R2: ADOPT the vault/ boundary model -- 5/5 unanimous
- R3: ADOPT staging tier elimination (validate-in-place + snapshot rollback) -- 5/5 unanimous
- R4: ADOPT two-file env model (`user.env` + `system.env`) -- 5/5 unanimous
- R5: ADOPT hot-reload file watcher for `user.env` -- 4/5
- R6: INCLUDE FS refactor in 0.10.0 scope -- 4/5

**Decision Reversals (1 item):**
- R7: REVERSE decision Q2 (preserve three-tier XDG) -- 5/5 unanimous

**Proposal Modifications (1 item):**
- R12: ADD automated migration tool (`openpalm migrate`) -- 5/5 unanimous

**Plan Cascades (4 items):**
- R52: UPDATE `core-principles.md` (major rewrite of filesystem contract) -- 3/5
- R57: UPDATE `CLAUDE.md` (XDG table, architecture rules, paths) -- 3/5
- R64: ADD migration section to the refactor proposal -- 5/5 unanimous
- R65: UPDATE `core-principles.md` for vault boundary and security invariants -- 3/5

**Total: 12 majority-approved changes from the FS refactor review.**

### Notable Near-Misses (2/5 votes)

The following items received support from 2 agents and may warrant further discussion:

- R9: Move rollback to `~/.openpalm/backups/` (A, F)
- R10: Atomic writes for config/vault mutations (A, T)
- R14: PlaintextBackend two-file model update (A, S)
- R25: Hot-reload watcher hardening (S, T)
- R53: Reverse Q2 in review-decisions.md with rationale (A, P)
- R54: Update components plan for new paths (A, F)
- R55: Update pass plan for two-file model (A, S)
- R56: Update all compose file bind mounts (A, T)
- R66: Unified migration tool covering both layout and component transition (F, P)
- R58: Update `paths.ts` to collapse three resolve functions (A, T)
- R69: Document vault boundary vs env-var injection distinction (A, S)

### Cumulative Totals (Original + FS Refactor)

- **Original round:** 12 approved changes
- **FS refactor round:** 12 approved changes
- **Grand total:** 24 majority-approved changes for 0.10.0 implementation
