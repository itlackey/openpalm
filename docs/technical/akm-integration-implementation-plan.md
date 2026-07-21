# Implementation Plan: Host ↔ Assistant AKM Integration

> HISTORICAL: shipped in 0.12.0; kept as a design record. Current behavior is
> authoritative in [`core-principles.md`](./core-principles.md).

**Status:** Ready to build
**Date:** 2026-06-03
**Companion design doc:** [`akm-host-assistant-integration-proposal.md`](./akm-host-assistant-integration-proposal.md)
(§8 = selected design "symmetric writable secondary"; §9 = issues register I-1…I-13)
**Risk class:** HIGH — touches the user's personal knowledge stash on the host.

This plan turns the proposal's §8 design + §9 issues register into a sequenced,
build-ready set of phases. Each phase lists: scope, exact files, the change, tests,
acceptance criteria, and rollback. Phases are ordered by dependency and risk so that the
**data-loss-safety fixes ship first and stand alone**, and nothing that mounts the
personal stash lands before the chown fix.

All line references verified against working tree on 2026-06-03.

---

## Status (2026-06-03) — Phases 0–5 implemented & verified

Verified against **akm 0.8.0-rc.13** (bumped from rc.12 mid-investigation).

| Phase | Status | Evidence |
|---|---|---|
| **0** P0 safety (I-1 chown, I-2 split-brain) | ✅ done | `entrypoint.sh:42` chowns only `/home/opencode /opt/akm/{cache,data}`; `core.compose.yml` fixed `/stash`+`/etc/akm`; `setup.ts` override block removed |
| **1** Config correctness (I-3) | ✅ done | `setup.ts` writes canonical `profiles.llm.default`+`defaults.llm`; regression test asserts no migration-trigger shape; akm migration trigger (`config-migration.ts:186`) verified unsatisfiable |
| **2** `akm-sources.ts` lib module | ✅ done | upsert/remove/import, fail-closed personal config, 0600 atomic, no-primary invariant; 15 unit tests. Verified `resolveSourceEntries` (search-source.ts:56) always injects env primary → secondary can't strand it |
| **3** Compose overlay | ✅ done | `host-akm.compose.yml` asset + existence-gated `discoverStackOverlays` |
| **4** Wizard wiring | ✅ done | `host-akm-sharing.ts` orchestrator (env+overlay+config+profiles); `setup.ts` lenient enable; `OptionsStep.svelte` relabel+consent copy; 22 orchestrator + 2 setup tests |
| **5** Admin endpoint | ✅ done | `admin/akm/host-sharing/+server.ts` GET/PUT/DELETE, 409 on fail-closed; 8 endpoint tests |
| **6** Git-backing | ❌ cancelled | akm already does this — `akm init` git-inits the stash on creation (`akm/src/commands/init.ts:123` `spawnSync("git",["init",dir])`) when git is on PATH, and `improve` auto-syncs when `.git` exists. Both the assistant primary stash and the host primary stash are already git-backed. No OpenPalm work needed. |
| **7** A↔H single-writer (I-4, I-11) | ❌ cancelled | By design the assistant has its own cron schedule and the host has its own; both running independently is acceptable, and a task can be run on demand against the assistant when needed. Not pursuing forced single-writer serialization. |
| **8** Cleanup/docs + I-5/I-6 audit | ✅ done | I-5 atomic config writer, I-6 four-env guard+test, I-7 guardian akm-cli removed, I-9 CLAUDE.md fixed, I-10 dead `seedStashAssets` removed, I-12/I-13 documented |

**Tests:** 343 lib (bun) + 8 UI endpoint (vitest) pass; UI svelte-check 0 errors/0 warnings.

**New/changed files:** `containers/assistant/entrypoint.sh`, `.openpalm/config/stack/core.compose.yml`,
`.openpalm/config/stack/host-akm.compose.yml` (new), `packages/lib/src/control-plane/{fs-atomic,akm-sources,host-akm-sharing}.ts` (new) + tests,
`packages/lib/src/control-plane/{setup,config-persistence}.ts`, `packages/lib/src/index.ts`,
`packages/ui/src/routes/admin/akm/host-sharing/+server.ts` (new) + test,
`packages/ui/src/routes/setup/steps/OptionsStep.svelte`.

**Phases 6 & 7 cancelled (2026-06-03, by maintainer):**
- **Phase 6 (git-backing)** is redundant — akm itself git-inits a stash on creation
  (`init.ts:123`) when git is available and auto-syncs on `improve` when `.git` exists,
  so both primary stashes are already git-backed. No OpenPalm code needed.
- **Phase 7 (A↔H single-writer)** is unnecessary — the assistant and host each run their
  own cron schedule independently, which is acceptable; on-demand task execution against
  the assistant covers the rest. Not pursuing serialization.

**Operational caveats (I-12, I-13) — documented, no code change:**
- **I-12 network FS:** `OP_HOME` must live on a local filesystem. akm's SQLite
  (`state.db`/`index.db`) uses WAL, which is unsafe over NFS/SMB. (Technical detail in
  the proposal doc §1.2/§4.)
- **I-13 `akm feedback --applied-to`:** rewrites the matched lesson file in place
  regardless of the source's `writable` flag, so with a writable host secondary the
  assistant can append `lessonStrength` frontmatter into a `~/akm` lesson. Non-destructive
  and recoverable via the stash's git history (proposal §8.9).

---

## 0. Guiding constraints (non-negotiable)

- **Never `chown -R` a bind-mounted host dir.** The container runs as `OP_UID:OP_GID`
  (host owner, via gosu) and reads/writes host files directly — no ownership rewrite.
- **The personal `~/akm` is never a writable *primary* and never a target of an
  automatic write.** It is a *secondary source*; cross-writes require explicit `--target`.
- **Control-plane logic lives in `packages/lib/`** — never duplicated in CLI/UI
  (CLAUDE.md). Wizard/admin call into the lib module.
- **Config writers are atomic 0600 and fail closed on a corrupt *personal* config**
  (abort, never overwrite the user's file).
- **Both shared stashes are git-backed** before any write-back path is enabled (recovery).
- **No new complexity without justification** (CLAUDE.md). Prefer OpenPalm's direct atomic
  config writer over shelling out to `akm add`/`akm config set` against the shared config.

---

## 1. Dependency graph

```
Phase 0  P0 safety        ── ships standalone, blocks everything that mounts /host-stash
   │     (I-1 chown, I-2 drop split-brain overrides)
   ▼
Phase 1  Config correctness ── prerequisite for any config manipulation
   │     (I-3 canonical profiles shape, I-5 single writer, I-6 four-env audit)
   ▼
Phase 2  lib module        ── pure logic, unit-tested in isolation
   │     (akm-sources.ts: upsert/remove source, import profiles)
   ▼
Phase 3  Compose overlay   ── host-akm.compose.yml + materialization
   ▼
Phase 4  Wizard wiring     ── setup.ts + OptionsStep.svelte (replaces hostAkm branch)
   ▼
Phase 5  Admin controls    ── /admin/akm/host-sharing + AKM admin tab button   ✅ done

Phase 6  Git-backing        ── ❌ CANCELLED (akm git-inits stashes itself)
Phase 7  A↔H single-writer  ── ❌ CANCELLED (independent crons are acceptable)
Phase 8  Cleanup / docs     ── ✅ done (I-5,I-6,I-7,I-9,I-10,I-12,I-13; I-8 → stable cutover)
```

Phases 0–5 are the feature critical path (**all done**). Phase 0 was the priority — a latent
host-data-loss bug present in every install today. Phases 6 & 7 were cancelled by the
maintainer (see §8/§9); Phase 8 cleanup/audit is done bar I-8 (0.11.0-stable version pin).

---

## 2. Phase 0 — P0 safety hardening (ship first, standalone)

**Addresses:** I-1 (chown clobber), I-2 (hostAkm split-brain).
**Why first:** these are live defects independent of the new feature, and the chown fix is
a hard prerequisite for ever mounting `/host-stash`.

### 2.1 Entrypoint chown fix (I-1)

**File:** `containers/assistant/entrypoint.sh:46`

Current:
```sh
chown -R "$TARGET_UID:$TARGET_GID" /home/opencode /work /opt/akm /stash 2>/dev/null || true
```

Change to chown **only container-private paths**, never bind-mounted host stashes:
```sh
# Chown ONLY container-private paths. NEVER chown bind-mounted host stashes
# (/stash, and /host-stash when host-akm sharing is enabled) — the host owns
# those files and the container runs as OP_UID:OP_GID (the host owner) via gosu,
# so it reads/writes them directly. Recursively chowning a bind mount rewrites
# host file ownership on every boot — a data-ownership hazard.
chown -R "$TARGET_UID:$TARGET_GID" /home/opencode /opt/akm/cache /opt/akm/data 2>/dev/null || true
```

Also remove `/stash` (line 40) from the `mkdir -p` pre-create block at lines 36–40 only if
that block is the cause of root-owned dirs; keep `/opt/akm/{cache,data}` there (they are
container-private). `/work` and `/stash` are host-owned bind mounts created by install as
the host user — the container running as that UID needs no chown of them.

**Tests:**
- New `containers/assistant/entrypoint.bats` (or shell test harness if bats unavailable):
  assert the chown line names only `/home/opencode /opt/akm/cache /opt/akm/data` and does
  NOT name `/stash` or `/host-stash`. (Static grep-based assertion is acceptable — the
  shell can't be unit-run easily; a CI grep guard is the cheap durable check.)
- Manual: build `openpalm/assistant:dev`, set host UID ≠ 1000 scenario, boot, verify
  `OP_HOME/knowledge` file ownership is unchanged (`stat -c '%u:%g'` before/after).

**Acceptance:** booting the assistant never changes ownership of any file under
`OP_HOME/knowledge` (or `~/akm` once Phase 3 lands).

**Rollback:** revert the one-line entrypoint change; image rebuild.

### 2.2 Drop the `hostAkm` split-brain overrides (I-2)

**File:** `.openpalm/config/stack/core.compose.yml:75-76`

Current:
```yaml
- ${OP_AKM_STASH:-${OP_HOME}/knowledge}:/stash
- ${OP_AKM_CONFIG:-${OP_HOME}/config/akm}:/etc/akm
```

Change to fixed paths (primary stash + config are *always* OpenPalm-managed):
```yaml
- ${OP_HOME}/knowledge:/stash
- ${OP_HOME}/config/akm:/etc/akm
```

**File:** `packages/lib/src/control-plane/setup.ts:246-252`

Remove the `if (hostAkm) { … OP_AKM_STASH / OP_AKM_CONFIG … }` block. (The `hostAkm`
input/toggle is *repurposed* in Phase 4 — do not delete the wizard field yet; just stop it
writing the split-brain overrides. In Phase 0 it becomes a no-op that Phase 4 rewires.)

> Coordination note: shipping Phase 0 alone means the `hostAkm` toggle does nothing until
> Phase 4. Either (a) hide the toggle in the wizard in Phase 0 and re-show it in Phase 4,
> or (b) ship Phase 0 and Phase 4 in the same release. **Recommended: hide in Phase 0**
> (one-line `{#if false}` or feature flag) so users never see a dead toggle.

**Tests:**
- `setup.ts` unit test: with `hostAkm:true`, assert `stack.env` no longer contains
  `OP_AKM_STASH` / `OP_AKM_CONFIG`.
- Existing compose-render/parse tests stay green.

**Acceptance:** no install can repoint the container's primary stash at `~/akm`; container
and host task-runner (H) always agree on `OP_HOME/knowledge` + `OP_HOME/config/akm`.

**Rollback:** revert compose + setup.ts hunks.

---

## 3. Phase 1 — Config correctness foundation

**Addresses:** I-3 (canonical LLM profile shape), I-5 (single atomic config writer),
I-6 (four-env-var audit + guard). Prerequisite for Phase 2 because the new module writes
akm config and must not depend on the legacy migration shim.

### 3.1 Write the canonical akm config shape (I-3)

**File:** `packages/lib/src/control-plane/setup.ts:267-274`

Current writes a **legacy top-level `llm`** that only survives via akm's
`config-migration.ts:315-331` shim (fatal when removed; rewrites config on load).

Replace with the canonical 0.8.0 shape:
```ts
if (llm) {
  const base = llm.baseUrl ? llm.baseUrl.replace(/\/+$/, "") : "";
  const profiles = (updated.profiles as Record<string, unknown>) ?? {};
  const llmProfiles = (profiles.llm as Record<string, unknown>) ?? {};
  llmProfiles.default = {
    ...((llmProfiles.default as Record<string, unknown>) ?? {}),
    endpoint: base ? `${base}/chat/completions` : "",
    model: llm.model,
    provider: llm.provider,
  };
  profiles.llm = llmProfiles;
  updated.profiles = profiles;
  const defaults = (updated.defaults as Record<string, unknown>) ?? {};
  defaults.llm = "default";
  updated.defaults = defaults;
  delete (updated as Record<string, unknown>).llm; // never write the legacy key
}
```
`embedding` (lines 276-285) is already a valid top-level key — leave as is.

**Tests:**
- `setup.ts` unit test: written `config.json` has `profiles.llm.default` + `defaults.llm`
  and NO top-level `llm`.
- **Regression test (the important one):** load the written config through the *actual*
  akm binary in the assistant image (or a vendored akm import) and assert it loads with
  **no migration and no rewrite-to-disk**. Compare file mtime/bytes before & after a
  `akm config get` no-op. This is what proves we no longer depend on the shim.

**Acceptance:** wizard-written akm config loads on a future akm that has dropped the
0.7→0.8 migration shim; first load does not rewrite the file.

### 3.2 Single atomic config writer + avoid in-container `akm config set` (I-5)

**Files:** `packages/lib/src/control-plane/setup.ts`, `packages/ui/src/routes/admin/akm/+server.ts`,
and the new `akm-sources.ts` (Phase 2).

- Confirm all OpenPalm-side writes to `OP_HOME/config/akm/config.json` go through one
  atomic 0600 writer (`writeFileAtomic`) — they mostly do.
- The new source-entry writes (Phase 2) MUST use this writer, **not** shell out to
  `akm add` inside the container against the shared config (which uses a best-effort
  `config.json.lck` that proceeds unlocked after retries — `akm/src/core/config-io.ts`).
- Add a code-comment + lint note: "do not invoke `akm config set`/`akm add` against the
  shared `OP_HOME/config/akm` from any OpenPalm code path."

**Tests:** unit test asserting the source-upsert helper writes atomically (temp file +
rename) and preserves mode 0600.

**Acceptance:** no OpenPalm code path mutates the shared akm config via the akm CLI; all
writes are atomic and serialized through lib.

### 3.3 Four-env-var audit + guard (I-6)

**Scope:** every site that spawns `akm` must set all four (`AKM_STASH_DIR`,
`AKM_CONFIG_DIR`, `AKM_CACHE_DIR`, `AKM_DATA_DIR`) or none-with-intent.

- `buildAkmEnv` (`akm-user-env.ts:67-75`) — already sets all four ✓ (verify).
- `core.compose.yml:54-57` — all four ✓ (verify).
- Audit: `git grep -nE "spawn.*akm|execFile.*\bakm\b|\"akm\"|'akm'"` across `packages/`,
  `core/`, `scripts/`, tests. For each, confirm all four are set or the call is host-shell
  (personal akm, intentional).
- Add a small guard helper in lib (`assertAkmEnvComplete(env)`) used by any internal akm
  spawn, throwing if a partial set is detected.

**Tests:** unit test for `assertAkmEnvComplete`; a CI grep guard listing known-good spawn
sites.

**Acceptance:** no internal OpenPalm `akm` invocation can write to the operator's global
`~/.config/akm` / `~/.local/share/akm` by accident.

---

## 4. Phase 2 — `akm-sources.ts` lib module (§8.5)

**New file:** `packages/lib/src/control-plane/akm-sources.ts`
**Barrel:** add export to `packages/lib/src/index.ts`.

Pure, side-effect-isolated control-plane logic. No wizard/admin coupling. Public surface
(from §8.5 of the design):

```ts
const HOST_SOURCE_NAME = "host-akm";
const OPENPALM_SOURCE_NAME = "openpalm";

type SourceEntry = { type: "filesystem"; path: string; name: string; writable: boolean; enabled: boolean };

function upsertFilesystemSource(configPath: string, entry: SourceEntry): void;
function removeSourceByName(configPath: string, name: string): void;

export function addHostStashToOpenpalmConfig(state, writable?: boolean): void;   // writes /host-stash entry into OP_HOME config
export function addOpenpalmStashToHostConfig(hostConfigPath, knowledgePath, writable?: boolean): void; // writes OP_HOME/knowledge entry into ~/.config/akm
export function disableHostAkmSharing(state, hostConfigPath): void;              // remove both entries
export function importHostProfiles(state, hostConfigPath): { imported: string[] }; // RO snapshot of profiles.{llm,agent}+defaults
```

**Hard invariants (each unit-tested):**
1. Never sets `primary`, never sets `defaultWriteTarget`, never reorders sources.
2. Only appends/updates a **named** source (idempotent upsert by `name`).
3. Atomic 0600 writes (temp + rename).
4. **OpenPalm config** parse-fail → start from `{}` (tolerant — we own it).
5. **Personal config** parse-fail → **abort/throw** (fail closed — never overwrite the
   user's file). This asymmetry is the data-loss guard; test both branches explicitly.
6. `importHostProfiles` reads the personal config **read-only**, copies only
   `profiles.llm` / `profiles.agent` (+ `defaults.llm`/`defaults.agent`), writes the
   canonical shape (Phase 1) into the OpenPalm config, never writes back to host.
7. `removeSourceByName` on a missing entry is a no-op (idempotent disable).

**Tests:** `akm-sources.vitest.ts` (or bun test in lib) covering: upsert idempotency,
remove idempotency, atomicity/mode, OpenPalm-tolerant vs personal-fail-closed parse paths,
no-primary/no-defaultWriteTarget invariant, profile import (only profiles+defaults copied,
host file unchanged byte-for-byte).

**Acceptance:** module passes unit tests in isolation; `bun run check` green; no consumer
wiring yet.

---

## 5. Phase 3 — Compose overlay (§8.3)

**New file (repo source):** `.openpalm/config/stack/host-akm.compose.yml`
```yaml
# Enabled only when the operator opts into host AKM sharing.
# Mounts the user's personal akm stash read-WRITE so the assistant can read host
# knowledge and (on explicit --target) contribute back. Ownership is NOT modified
# by the container (entrypoint chowns only container-private paths); writes
# preserve host ownership because the container runs as OP_UID/OP_GID.
services:
  assistant:
    volumes:
      - ${OP_HOST_AKM_STASH}:/host-stash
```

**Materialization:** ensure the overlay is copied into `OP_HOME/config/stack/` by the same
install/seed path that handles addon overlays (`seedOpenPalmDir`/`copyTree`), and is
enabled/disabled through the existing addon-overlay enable mechanism (`setAddonEnabled` or
equivalent compose-file-list state). `OP_HOST_AKM_STASH` is written to `stack.env` only
when sharing is enabled (Phase 4).

**Tests:**
- Compose-assembly test: with the overlay enabled and `OP_HOST_AKM_STASH=/x/akm` in
  `stack.env`, the rendered/merged compose has `/x/akm:/host-stash` on the assistant; with
  it disabled, no `/host-stash` mount exists.
- `docker compose config` parse validity (in a stack-dep manual test, not CI).

**Acceptance:** the `/host-stash` mount appears only when the overlay is enabled; never in
the default install.

**Rollback:** disable overlay (removes mount); delete the overlay file.

---

## 6. Phase 4 — Wizard wiring (§8.6)

**Files:** `packages/lib/src/control-plane/setup.ts`,
`packages/ui/src/routes/setup/.../OptionsStep.svelte` (host-AKM toggle),
host-status already returns `hostAkmAvailable` + `hostAkmPaths`
(`api/setup/host-status/+server.ts`).

**`performSetup` (setup.ts):** replace the removed Phase-0 `hostAkm` branch with, when
`hostAkm === true` AND `hostAkmAvailable`:
1. write `OP_HOST_AKM_STASH=${HOME}/akm` to `stack.env`;
2. enable the `host-akm` compose overlay (addon-enable path);
3. `addHostStashToOpenpalmConfig(state, /*writable*/ true)`;
4. `addOpenpalmStashToHostConfig(${HOME}/.config/akm/config.json, ${OP_HOME}/knowledge, true)`
   — guarded by the fail-closed personal-config writer (Phase 2 invariant 5);
5. if no LLM profile was set in the wizard, `importHostProfiles(state, ${HOME}/.config/akm/config.json)`;
6. ensure both stashes are git-backed (Phase 6 helper).

**`OptionsStep.svelte`:** relabel the toggle "Share knowledge with my host AKM (read +
contribute)", shown only when `hostAkmAvailable`. Add consent copy:
> "OpenPalm will add a source entry to your personal `~/.config/akm/config.json` and mount
> `~/akm` into the assistant. Your files' ownership is not changed and your primary stash
> is unchanged."

**Tests:**
- `setup.ts` unit test: `hostAkm:true` path writes `OP_HOST_AKM_STASH`, enables overlay,
  calls the two source-upserts + optional profile import (mock the lib fns, assert calls +
  args); `hostAkm:false` does none of it.
- Wizard mocked Playwright (`ui:test:e2e:mocked`): toggle visible only when
  `hostAkmAvailable:true`; consent copy present.

**Acceptance:** a fresh wizard run with the toggle on produces: overlay enabled,
`OP_HOST_AKM_STASH` set, both config source entries present, profiles imported if needed,
both stashes git repos — and the personal stash primary is untouched.

---

## 7. Phase 5 — Admin controls (§8.7)

**New file:** `packages/ui/src/routes/admin/akm/host-sharing/+server.ts`

| Method | Action |
|---|---|
| `GET` | status: enabled?, `OP_HOST_AKM_STASH`, writable flag, both source entries present?, git-backed? |
| `PUT` | enable: same 6 steps as wizard (`requireAdmin`) |
| `DELETE` | disable: `disableHostAkmSharing` + disable overlay; **deletes no stash content** |

Plus a **"Re-import host profiles"** button on the existing AKM admin tab → calls
`importHostProfiles` (idempotent, validated, atomic).

**Tests:** server vitest mirroring `admin/health` pattern: 401 without auth; GET shape;
PUT enables (mock lib + overlay); DELETE removes entries but asserts stash files still
exist; re-import is idempotent.

**Acceptance:** sharing can be toggled post-install from admin with the same safety
guarantees as the wizard; disable never deletes knowledge.

---

## 8. Phase 6 — Git-backing & recovery (§8.8) — ❌ CANCELLED

**Cancelled (maintainer, 2026-06-03): akm already handles this.** When git is on PATH,
`akm init` git-inits a stash at creation (`akm/src/commands/init.ts:123`:
`spawnSync("git", ["init", dir])`), and `akm improve` performs an end-of-run batch git sync
when the primary stash has a `.git` dir. Both the assistant primary stash and the host
primary stash are therefore already git-backed without any OpenPalm code. The residual
`consolidate` overwrite path is consequently already recoverable from git history. No
`ensureGitBackedStash` helper is needed.

---

## 9. Phase 7 — A↔H single-writer — ❌ CANCELLED

**Cancelled (maintainer, 2026-06-03).** The assistant container runs its own cron schedule
and the host task-runner runs its own; both operating independently against the shared
`OP_HOME/data/akm` is acceptable for this deployment. akm's WAL + `busy_timeout` absorbs the
infrequent overlap, and a task can be executed on demand against the assistant when needed.
No forced single-writer serialization (`docker exec` rerouting) and no change to the
`akm tasks sync` loop are being pursued. (I-4 and I-11 remain noted in the issues register
as known, accepted behavior.)

---

## 10. Phase 8 — Cleanup / docs — ✅ DONE

| Issue | Action taken | File(s) |
|---|---|---|
| **I-5** config clobber | admin/akm PATCH now writes via the shared atomic `writeFileAtomic` (tmp+rename); new source writes use it too; no OpenPalm path shells `akm config set`/`akm add` against the shared config. | `admin/akm/+server.ts`, `fs-atomic.ts` |
| **I-6** four-env audit | Audited all `akm` spawn sites (only `scheduler.ts`, which takes `buildAkmEnv`). Added `assertAkmEnvComplete` guard (checks the four keys on the passed env, not inherited `process.env`) + called it in `executeAutomation`/`syncAutomations` + unit tests. | `akm-user-env.ts`, `scheduler.ts` |
| **I-7** guardian akm | **Removed** the unused `akm-cli` install from the guardian image (its OpenCode is a pure moderator: no akm plugin, bash/edit/read denied, no AKM mounts/env). Comment explains the read-only-reader path if ever needed. | `containers/guardian/Dockerfile` |
| **I-8** version pin | Deferred to 0.11.0 stable cutover (tracked in [[project_0110_stable_cutover_todo]]); not part of this work. | `containers/assistant/Dockerfile`, `containers/guardian/Dockerfile` |
| **I-9** stale docs | Replaced the 3 `packages/assistant-tools` references with current reality (`akm-opencode` plugin in `.openpalm/config/assistant/opencode.jsonc`; persona in `.openpalm/config/assistant/`). | `CLAUDE.md` |
| **I-10** dead code | Removed `seedStashAssets` + its barrel export + its (only-block) test file; pruned now-orphaned imports. | `core-assets.ts`, `index.ts`, deleted `core-assets.test.ts` |
| **I-12** network FS | Documented (above + proposal §1.2/§4). Detect-and-warn left as optional future polish. | docs |
| **I-13** feedback writable | Documented (above + proposal §8.9). | docs |

> **I-8** is the only Phase-8 item intentionally left open — it belongs to the broader
> 0.11.0-stable cutover (pin akm-cli off the moving `next`/`latest` tags), not this feature.

---

## 11. Cross-phase test matrix

| Suite | Command | Phases covered |
|---|---|---|
| lib unit | `bun run sdk:test` / lib bun test | 1, 2, 6 |
| setup.ts unit | (lib/ui unit) | 0.2, 1.1, 4 |
| UI vitest | `bun run ui:test:unit` | 5 |
| svelte-check | `cd packages/ui && npm run check` | 4, 5 |
| guardian | `bun run guardian:test` | 8 (I-7) |
| compose assembly | lib/ui compose tests | 0.2, 3 |
| mocked Playwright | `bun run ui:test:e2e:mocked` | 4 (wizard toggle) |
| stack manual | `RUN_DOCKER_STACK_TESTS=1 …` (see CLAUDE.md) | 0.1, 3, 7 (ownership + busy) |

**Delivery checklist gate (CLAUDE.md) per PR:** `npm run check` green, guardian tests
green, no control-plane logic duplicated outside `packages/lib/`, no secret leakage, docker
dependency pattern intact.

---

## 12. Recommended PR sequencing

1. **PR-0 (ship now):** Phase 0 — chown fix + drop split-brain overrides + hide the toggle.
   Standalone safety fix; no feature dependency. *Highest value, lowest risk.*
2. **PR-1:** Phase 1 — config correctness (I-3/I-5/I-6). Standalone; fixes a latent break.
3. **PR-2:** Phases 2 + 3 — lib module + compose overlay (no user-facing wiring yet).
4. **PR-3:** Phases 4 + 5 + 6 — wizard + admin + git-backing (the user-facing feature,
   re-enables the toggle).
5. **PR-4 (independent):** Phase 7 — single-writer + tasks-sync.
6. **PR-5 (independent, before stable):** Phase 8 — cleanup/docs (I-8 version pin gates
   0.11.0 stable; see [[project_0110_stable_cutover_todo]]).

---

## 13. What this delivers against the original brief

- **Share everything (cache/state.db)?** No — stash content only; data/cache stay
  per-instance. (Phases 2–3 keep mounts per-instance.)
- **Add each other's stashes as secondary sources?** Yes, symmetric. (Phase 2/4.)
- **Writable?** Yes, with `defaultWriteTarget` unset → writes default to each own primary;
  cross-writes explicit. Git-backed recovery. (Phases 2, 6.)
- **Easy for the user?** One wizard toggle / one admin switch; rest automated. (Phases 4–5.)
- **Import host config like providers?** Yes — read-only profile snapshot, refreshable.
  (Phase 2 `importHostProfiles`, Phase 5 button.)
- **Reuse host LLM/agent profiles?** Same import path.
- **Data-loss risk?** Eliminated for the personal stash: no chown of bind mounts (Phase 0),
  no shared SQLite/locks (per-instance data), fail-closed personal-config writer (Phase 2),
  both stashes git-backed (Phase 6).
