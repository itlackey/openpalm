# Proposal: Host ↔ Assistant AKM Stash Integration

**Status:** Draft for review
**Date:** 2026-06-03
**Scope:** How the host machine's `akm` instance and the assistant container's `akm`
instance share knowledge assets, operational state, cache, and config — and how to
make that integration safe, sane, and user-friendly.
**Risk class:** HIGH — incorrect handling can destroy or corrupt the user's personal
knowledge stash on the host machine.

---

## 0. TL;DR

1. **The current default already shares *everything* implicitly** — stash, config,
   cache, *and* the SQLite state/index DBs are bind-mounted from the *same* four host
   directories the host CLI uses. This is undocumented, and two latent defects make it
   dangerous (recursive `chown` of host files on every boot; cross-PID-namespace lock
   stealing). These must be fixed regardless of which proposal we adopt — see
   **§3 P0 Hardening**.
2. **Do not share operational state** (`state.db`, `index.db`, cache, live config
   writes) as a single mutable directory between the two instances. SQLite WAL +
   cross-PID-namespace lock stealing make this a corruption/`SQLITE_BUSY` hazard. Give
   each side its **own** cache + data dir (the container already has them under
   `OP_HOME/data/akm/`).
3. **Share the *stash assets*** — the knowledge — not the machinery. The safest unit
   of sharing is the asset files, surfaced through akm's first-class **multi-source**
   feature, with the host's personal stash mounted **read-only** as a secondary source.
4. **Importing host LLM/agent profiles is safe and recommended** — it is exactly the
   read-only `auth.json` / OpenCode-providers pattern we already trust. Snapshot at
   setup, refreshable from an admin button.
5. **Top recommendation: Proposal A** — *Owned primary + read-only host secondary*.
   It carries **zero** host-data-loss risk, federates the host's existing knowledge into
   the assistant, reuses host profiles, and is fully wizard/admin-automatable.

---

## 1. How it works today (verified)

### 1.1 The two instances point at the same four directories

`akm` resolves four independent directory families (`akm/src/core/paths.ts`):

| Family | Env var | What lives there | Regenerable? |
|---|---|---|---|
| **Stash** | `AKM_STASH_DIR` | Asset files (skills, agents, commands, knowledge, memories, lessons, wikis, `env/`, `secrets/`, `tasks/`) + `<stash>/.akm/proposals/` + `improve.lock` | No — the user's knowledge |
| **Config** | `AKM_CONFIG_DIR` | `config.json` (single-layer, no inheritance): profiles, sources, registries, embedding/LLM config | No |
| **Cache** | `AKM_CACHE_DIR` | Registry/git/website mirrors, embedding-model downloads, task logs, ripgrep bin, config-backups | **Yes** |
| **Data** | `AKM_DATA_DIR` | `state.db`, `index.db` (incl. embeddings BLOBs + LLM-enrichment cache), `workflow.db`, `akm.lock`, task history | No |

In OpenPalm's **default** install (`hostAkm` OFF), the assistant container's bind mounts
(`core.compose.yml:75-78`) and the host CLI's `buildAkmEnv` (`akm-user-env.ts:67-75`)
resolve to the *identical* host paths:

| Resource | Container path | Host path | Host CLI (`buildAkmEnv`) | Shared today? |
|---|---|---|---|---|
| Stash | `/stash` | `OP_HOME/knowledge` | `OP_HOME/knowledge` | **YES** |
| Config | `/etc/akm` | `OP_HOME/config/akm` | `OP_HOME/config/akm` | **YES** |
| Cache | `/opt/akm/cache` | `OP_HOME/data/akm/cache` | `OP_HOME/data/akm/cache` | **YES** |
| Data | `/opt/akm/data` | `OP_HOME/data/akm/data` | `OP_HOME/data/akm/data` | **YES** |

> **Key insight:** "Should we share everything?" is the wrong framing — *we already do*,
> silently, including the SQLite DBs. The real question is *what should we stop sharing*
> and *what should we share deliberately and safely*.

Note this "host CLI" is the **OpenPalm UI/CLI host process** writing into `OP_HOME`. It
is distinct from the user's **personal** `akm` install (`~/akm`, `~/.config/akm`,
`~/.local/share/akm`) — which the wizard's `hostAkm` toggle tries, brokenly, to wire in
(§1.3).

### 1.2 AKM's relevant capabilities (from the `akm` repo, v0.8.0-rc.12)

- **Multi-source is first-class.** `akm add <path>` registers another local stash as a
  `filesystem` source (`source-add.ts:94`). Search/curate federate across all enabled
  sources in one `index.db` query, **primary-first precedence**, deduped by file path
  (`db-search.ts:717`). Sources have an explicit **`writable` flag**; `filesystem`
  sources default writable, but **writes only ever land in the resolved write-target**
  (explicit `--target` → `defaultWriteTarget` → primary stash), never implicitly in a
  secondary (`write-source.ts:227-308`). So a read-only secondary is trivially safe:
  set `writable:false` and never name it as a target.
- **Git-backed stash + end-of-run auto-sync.** A stash with a `.git` dir is recognized
  automatically (`isGitBackedStash`). `akm improve` batch-commits at the end of a run;
  **push** requires a remote + `config.writable` + not-disabled. A `#476` guard
  *refuses* to commit if the stash root has dirty non-akm files (won't bundle unrelated
  WIP). Source: `knowledge:stash-sync-model`.
- **Config has no layering.** Only the user-level `config.json` is read; per-project
  configs are deprecated. Profiles (`profiles.llm`, `profiles.agent`,
  `profiles.improve`) live there.
- **Locks do not cross PID namespaces.** `improve.lock`, `akm.lock`, and
  `config.json.lck` use `O_EXCL` + **PID-staleness reclaim**. A host process and a
  container have different PID namespaces, so the container can find the host's lock
  PID "not alive" in *its* namespace, declare it stale, and **steal it**
  (`akm/src/core/file-lock.ts:95`). Mutual exclusion between host and container is
  therefore **not reliable** even though the lock files are shared. Source:
  `memory:improve-lock-scope-primary-stash`.
- **SQLite is WAL + `busy_timeout=5000`.** Safe for concurrent readers + one writer on a
  *local* mount; sustained concurrent writers raise `SQLITE_BUSY`. **Not** safe over a
  network filesystem.

### 1.3 Two latent defects in the current integration

1. **Recursive `chown` of host files on every boot.** `entrypoint.sh:46` runs
   `chown -R "$TARGET_UID:$TARGET_GID" … /stash` as root on **every** container start.
   `/stash` is the bind-mounted host knowledge dir. If the host user's UID ≠ 1000, this
   silently rewrites ownership of the user's knowledge files. With **`hostAkm` ON**
   (`/stash` → `~/akm`), it recursively chowns the user's *personal* stash tree to
   UID 1000 on every start — **direct host-data hazard.**
2. **`hostAkm` split-brain.** The toggle sets `OP_AKM_STASH=~/akm` /
   `OP_AKM_CONFIG=~/.config/akm` (`setup.ts:249-250`), repointing the *container*. But
   (a) cache/data have **no override** and still point at `OP_HOME/data/akm/*`, and
   (b) the host UI's `buildAkmEnv` **ignores** these overrides entirely and keeps using
   `OP_HOME/knowledge`. Result: container reads `~/akm` while host-triggered automations
   read `OP_HOME/knowledge` — divergent source of truth, shared DBs, ambiguous ownership.

---

## 2. Design axes and the trade-offs

| Axis | Options | Verdict |
|---|---|---|
| **Cache** (`data/akm/cache`) | share / separate | **Separate.** Regenerable; the only upside to sharing is avoiding a one-time embedding-model re-download. Not worth the torn-write risk. Container keeps its own. |
| **State/Index DBs** (`data/akm/data`) | share / separate | **Separate.** Cross-PID-namespace lock stealing + `SQLITE_BUSY` under concurrent writers + network-FS unsafety. Each instance owns its DBs. |
| **Config** (`config/akm`) | share writable / read-only import / separate | **Read-only import of profiles.** Single-layer config + best-effort `config.json.lck` → concurrent writers clobber. Don't share writable. Snapshot profiles in (§ profiles). |
| **Stash assets** (`knowledge/`) | single shared writable / read-only secondary / git-mediated | **This is the unit worth sharing.** Choose mechanism per proposal below. |
| **Writability of a shared/secondary stash** | RO / RW | **RO is the safe default.** RW only with single-writer discipline or git branch isolation. |
| **Profile/credential import** | live RW mount / read-only snapshot / `:ro` mount | **Read-only — like `auth.json`.** Never give the container a writable handle to host config. |

**Data-loss guardrails (cross-cutting, non-negotiable):**
- Never `chown -R` a bind-mounted host directory we don't own. Run the container as the
  host UID/GID instead, or make the chown conditional/skipped for externally-owned mounts.
- Never make the assistant's *writable* area a child of a *read-only* host mount.
- Keep derived/binary artifacts (embeddings, SQLite) out of any git-synced stash.
- Gate any assistant auto-commit to a **branch**, never the host's working tree/`main`.
- Last-write-wins is never the sole strategy for the curated stash.

---

## 3. P0 Hardening (precedes ALL proposals)

These fix the live defects and are prerequisites no matter which proposal ships:

1. **Stop chowning external mounts.** Make `entrypoint.sh` run the container process as
   the host UID/GID (via `OP_UID`/`OP_GID`, already plumbed) and **drop the recursive
   `chown` of `/stash`** (or skip it when `/stash` is detected as an externally-owned
   bind mount). Chown only container-private paths (`/home/opencode`, `/opt/akm`).
2. **Mount the host's personal stash read-only** whenever it's an external path
   (`:ro` on the `/stash`-equivalent secondary mount — see Proposal A).
3. **Fix or retire `hostAkm` split-brain.** Either make `buildAkmEnv` honor the same
   overrides (so host + container agree) **and** add cache/data overrides, or — preferred —
   replace the "repoint everything at `~/akm`" toggle with the read-only-secondary model
   (Proposal A) so the personal stash is *never* the container's writable primary.
4. **Document the network-FS hazard** for `OP_HOME` on NFS/SMB (SQLite WAL).

---

## 4. The three proposals (ranked)

Scoring (1–5, higher = better) across the dimensions the brief calls for:

| # | Proposal | Host-data safety | Knowledge sharing value | User-friendliness | Automatable (wizard/admin) | Bidirectional contribution | **Total** |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|
| **A** | Owned primary + **read-only host secondary** | **5** | 4 | **5** | **5** | 2 (curated export) | **21** |
| **B** | **Git-mediated** shared stash, branch-isolated writers | 4 | **5** | 3 | 3 | **5** | **20** |
| **C** | Hardened **single shared stash**, single-writer lock | 3 | 4 | 4 | 4 | 4 | **19** |

---

### Proposal A — Owned primary + read-only host secondary  ⭐ recommended

**Shape.** The assistant keeps `OP_HOME/knowledge` as its own writable primary stash
(the current default location, OpenPalm-managed). If the user has a personal host stash
(`~/akm`), mount it **read-only** into the container (`/host-stash:ro`) and register it as
a non-writable akm source:

```
akm add /host-stash            # filesystem source
# config.json source entry:  { type:"filesystem", path:"/host-stash", writable:false, enabled:true }
```

Each side keeps its **own** cache, data/`state.db`, and config. Host LLM/agent
**profiles** are snapshot-imported (read-only) into the assistant config at setup,
refreshable from admin (§ profiles).

**Data flow.** Host knowledge → assistant (read, federated into curate/search,
primary-first precedence). Assistant learnings stay in `OP_HOME/knowledge`. Optional
**user-triggered** "export learnings to host" admin action writes selected assets to a
dedicated host location (or opens a git commit) — never an automatic background writer.

**Pros**
- **Zero host-data-loss risk:** read-only mount + no chown of host files + no shared
  writers + no shared SQLite. The container physically *cannot* corrupt `~/akm`.
- Reuses the user's existing knowledge immediately (federated search).
- Mirrors the trusted `auth.json` read-only-import pattern and OpenPalm's
  assistant-isolation + never-overwrite-user-files core principles.
- Fully automatable: wizard detects `~/akm`, offers a single "Use my host knowledge
  (read-only)" toggle; admin has "Re-sync host profiles" + "Add/remove host source".
- akm's write-target rules make the secondary safe *by construction* (`writable:false`,
  never a target).

**Cons / mitigations**
- One-way by default (assistant learnings don't auto-flow back). *Mitigation:* explicit,
  user-triggered curated export — which is the *correct* safety posture for writing to a
  user's personal files anyway.
- Two stashes to reason about. *Mitigation:* precedence is documented and the admin UI
  shows both sources with their writable flags.

**Why it ranks #1:** highest safety, highest automatability, directly answers
"add each other's stashes as secondary sources" (yes, host→assistant, read-only) and
"import host config like providers" (yes, snapshot profiles). The only thing it
deliberately *doesn't* do is automatic write-back — which is a feature, not a bug, given
the data-loss stakes.

---

### Proposal B — Git-mediated shared stash, branch-isolated writers

**Shape.** A single git-backed stash is the source of truth. The host edits/curates on
`main`; the assistant commits its learnings to a dedicated branch
(`assistant/learnings`) via akm's end-of-run auto-sync, never to the host's working tree.
The user (or an admin "review learnings" action) merges via PR/`akm proposal accept`.
Leverages `isGitBackedStash` + `saveGitStash` + the `#476` dirty-tree refusal guard.

**Pros**
- **True bidirectional contribution with a full audit trail** — every change is a
  reviewable, revertible commit; conflicts *surface* instead of silently losing a side
  (strongest prior-art pattern: git as agent source-of-truth).
- Built-in recovery (git history) — the best possible answer to "high risk of data loss."
- Matches akm's design-intended sharing seam.

**Cons / mitigations**
- Concurrent `akm improve` runs still race on `improve.lock` across PID namespaces.
  *Mitigation:* serialize — assistant improve runs on a schedule guarded by a host-honored
  `flock`, or only when the host CLI is idle; keep `state.db`/`index.db` **per-side** and
  out of git.
- Requires the user to do merges/reviews — higher cognitive load; less "it just works."
- The chown defect (§3) must be fixed first or branch worktrees get ownership-clobbered.
- Binary artifacts must be `.gitignore`d (embeddings/SQLite merge terribly).

**Why it ranks #2:** best for power users who want the host and assistant to genuinely
co-author knowledge with safety from git. Loses to A only on user-friendliness and the
residual cross-namespace lock complexity.

---

### Proposal C — Hardened single shared stash, single-writer lock

**Shape.** Keep today's "one shared stash" model (`OP_HOME/knowledge`, never the personal
`~/akm`), but make it safe: fix the chown (§3), give each side its own cache/data/`state.db`,
and add a **real cross-namespace write lock** the entrypoint and host CLI both honor (a
`flock`-based file under `OP_HOME`, or a scheduling rule that the assistant only runs
write-heavy `improve`/`consolidate` when the host is idle).

**Pros**
- Simplest mental model — one stash, both contribute; mostly hardening what exists.
- No import/snapshot step; no second source to manage.
- Bidirectional within the OpenPalm-managed stash (doesn't touch personal `~/akm`).

**Cons / mitigations**
- Residual shared-writer risk: even with a `flock`, asset writes outside `improve` aren't
  all lock-guarded; relies on discipline. *Mitigation:* funnel all assistant writes through
  the locked path.
- Doesn't reuse the user's *existing* personal knowledge unless they migrate it in.
- Shared SQLite stays a `SQLITE_BUSY`/network-FS concern unless DBs are split per-side
  (recommended) — at which point search results can diverge between host and assistant.

**Why it ranks #3:** lowest-effort and acceptable, but it preserves the shared-writer risk
class that A eliminates and B makes auditable. Best viewed as the fallback if multi-source
or git wiring is deferred.

---

## 5. Profiles & host-config import (applies to all three)

"Would it be safe to import the host config like we do with OpenCode providers?" — **Yes**,
for **profiles**, read-only:

- **Snapshot at setup.** The wizard reads the user's personal `~/.config/akm/config.json`
  **read-only**, extracts `profiles.llm` / `profiles.agent` (and optionally
  `defaults.llm`/`defaults.agent`), and writes them into the assistant's
  `config/akm/config.json` via the existing admin/akm PATCH path (`admin/akm/+server.ts`,
  which already validates the 0.8.0 profile schema). No subprocess, no write-back to host.
- **Refreshable from admin.** A "Re-import host profiles" button repeats the snapshot.
  Idempotent, validated, atomic 0600 write.
- **Never share the config file live.** Single-layer config + best-effort lock = clobber
  risk. Snapshot, don't mount writable.
- **Secrets stay separate.** Provider API keys continue to flow through the existing
  `secrets:`/`auth.json` read-only mechanism, not akm config.

This makes "reuse the host system's LLM/agent profiles" a one-click, safe operation
without ever giving the container write access to host config.

---

## 6. Recommended path

The selected solution is a **symmetric writable-secondary** refinement of Proposal A:
each instance keeps its own primary/data/cache and adds the other's stash as a
*writable* secondary source (`defaultWriteTarget` unset so writes default to the own
primary). This keeps Proposal A's safety properties — no shared SQLite, no shared
primary lock, no chown of host files — while enabling explicit bidirectional
contribution. **Full build-ready design in §8.**

1. **Ship §3 / §8.4 P0 hardening with the feature** — the entrypoint chown fix is a
   latent host-data-loss bug and is a prerequisite for mounting `/host-stash`.
2. **Implement §8** — compose overlay + `akm-sources.ts` config module + wizard/admin
   wiring + git-backing, replacing the broken `hostAkm` split-brain toggle.
3. Proposal B (git-branch co-authoring) remains a future "advanced" mode; Proposal C
   is the fallback only if the multi-source wiring slips.

## 8. Detailed design — Symmetric writable secondary (selected solution)

This is the concrete, build-ready design for the recommended approach: each akm
instance keeps its **own** primary stash, data dir, and cache, and adds the other's
stash as a **writable secondary source**. Verified against akm v0.8.0-rc.12 source.

### 8.1 The three akm contexts (disambiguated)

The word "host akm" is overloaded. There are three distinct contexts:

| # | Context | Stash | Config | Data / Cache | Runs when |
|---|---|---|---|---|---|
| **P** | **Personal akm** (user's shell) | `~/akm` | `~/.config/akm` | `~/.local/share/akm`, `~/.cache/akm` | User types `akm` in a terminal |
| **A** | **Assistant container** | `/stash` = `OP_HOME/knowledge` | `/etc/akm` = `OP_HOME/config/akm` | `OP_HOME/data/akm/{data,cache}` | Always (container) + 60s task-sync loop |
| **H** | **OpenPalm host task-runner** (`buildAkmEnv`) | `OP_HOME/knowledge` | `OP_HOME/config/akm` | `OP_HOME/data/akm/{data,cache}` | UI "run automation now" (`executeAutomation`) |

**A and H share one dataset** (the OpenPalm-managed side — A's bind mounts *are* H's
directories). **P is fully separate.** The integration adds *cross-source references*
only — never repoints any primary, data, or cache. So P's `state.db`/`index.db`/cache
are never shared with A/H, which is exactly the "keep data and cache host-specific"
property: **answered yes — share stash content, never operational state.**

### 8.2 Source topology

```
Personal akm (P)                    Assistant container (A)
  primary  : ~/akm                    primary  : OP_HOME/knowledge   (/stash)
  secondary: OP_HOME/knowledge  ←──→  secondary: ~/akm               (/host-stash, :rw)
  (writable:true, not target)         (writable:true, not target)
  data/cache: ~/.local/share,         data/cache: OP_HOME/data/akm/*
              ~/.cache                 config    : OP_HOME/config/akm  (shared with H)
  config   : ~/.config/akm
```

- `defaultWriteTarget` is left **unset on both sides** → every normal write
  (`remember`, `improve` auto-accept, `consolidate`, `proposal accept`, `triage`)
  resolves to that instance's **own primary** (`resolveWriteTarget`:
  `--target` → `defaultWriteTarget` → primary). Cross-writes happen only on an
  explicit `--target`.
- Each instance **reads** the other via federated `curate`/`search` (primary-first
  precedence, deduped by file path).
- The container's config names the secondary as `/host-stash`. The OpenPalm host
  task-runner **H** shares that config but has no `/host-stash`; `walkStashFlat`
  returns `[]` for a missing root (`akm/src/indexer/walker.ts:73`) so **H silently
  skips it** — no error. (Verified.)

### 8.3 Compose changes

The `/host-stash` mount is **opt-in**, so it lives in a dedicated overlay enabled
through the same mechanism as addons — never in `core.compose.yml` unconditionally.

**New overlay** `OP_HOME/config/stack/host-akm.compose.yml` (materialized + enabled
only when the user turns on host-akm sharing):

```yaml
# Enabled only when the operator opts into host AKM sharing.
# Mounts the user's personal akm stash read-WRITE so the assistant can both read
# host knowledge and (on explicit --target) contribute back. Ownership is NOT
# modified by the container (see entrypoint change 8.4); writes preserve host
# ownership because the container runs as OP_UID/OP_GID.
services:
  assistant:
    volumes:
      - ${OP_HOST_AKM_STASH}:/host-stash
```

`OP_HOST_AKM_STASH` is written to `stack.env` (e.g. `${HOME}/akm`) only when sharing
is enabled. **`core.compose.yml` is changed to drop the `OP_AKM_STASH`/`OP_AKM_CONFIG`
overrides** (lines 75–76) — the primary stash and config are now *always*
`OP_HOME/knowledge` and `OP_HOME/config/akm`. This deletes the `hostAkm` split-brain
(the old toggle that repointed the container's primary at `~/akm` while H kept using
`OP_HOME/knowledge`):

```diff
-      - ${OP_AKM_STASH:-${OP_HOME}/knowledge}:/stash
-      - ${OP_AKM_CONFIG:-${OP_HOME}/config/akm}:/etc/akm
+      - ${OP_HOME}/knowledge:/stash
+      - ${OP_HOME}/config/akm:/etc/akm
```

Data and cache mounts (`OP_HOME/data/akm/{cache,data}`) are unchanged — they stay
OpenPalm-instance-private and are never repointed at the personal akm's dirs.

### 8.4 Entrypoint change (P0 — mandatory)

`containers/assistant/entrypoint.sh:46` currently does
`chown -R … /home/opencode /work /opt/akm /stash`. With `/host-stash` added this would
recursively rewrite ownership of the user's **personal** stash on every boot. The fix:
the container already runs as `OP_UID:OP_GID` (the host owner, via gosu), so it can
read/write host-owned files **without** changing ownership. Chown only
container-private paths and **never** the bind-mounted host stashes:

```diff
   if [ "$IS_ROOT" = "1" ]; then
-    # Recursively fix ownership. Previous container runs may have created
-    # directories as root when OP_UID/OP_GID differed.
-    chown -R "$TARGET_UID:$TARGET_GID" /home/opencode /work /opt/akm /stash 2>/dev/null || true
+    # Chown ONLY container-private paths. NEVER chown bind-mounted host stashes
+    # (/stash, /host-stash) — the host owns those files and the container runs
+    # as OP_UID:OP_GID (the host owner) via gosu, so it reads/writes them
+    # directly. Recursively chowning a bind mount rewrites host file ownership
+    # on every boot — a data-ownership hazard, especially for /host-stash
+    # (the user's personal ~/akm).
+    chown -R "$TARGET_UID:$TARGET_GID" /home/opencode /opt/akm/cache /opt/akm/data 2>/dev/null || true
     mkdir -p /var/run/sshd
   fi
```

(`/work` = `OP_HOME/workspace` and `/stash` = `OP_HOME/knowledge` are host-owned bind
mounts created by install as the host user; the container running as that same UID
needs no chown. If a first-run empty-dir edge case ever surfaces, fix it by ensuring
install creates the dir, not by recurse-chowning a mount.)

### 8.5 Configuration management (new lib module)

All source wiring is control-plane logic → lives in `packages/lib/`. New module
`packages/lib/src/control-plane/akm-sources.ts`:

```ts
const HOST_SOURCE_NAME = "host-akm";        // entry added to the OpenPalm/container config
const OPENPALM_SOURCE_NAME = "openpalm";    // entry added to the personal config

type SourceEntry = {
  type: "filesystem"; path: string; name: string;
  writable: boolean; enabled: boolean;
};

/** Read a config.json, upsert a filesystem source by name, write atomically 0600.
 *  NEVER sets `primary` or `defaultWriteTarget`. Idempotent. */
function upsertFilesystemSource(configPath: string, entry: SourceEntry): void { /* … */ }
function removeSourceByName(configPath: string, name: string): void { /* … */ }

/** Container/OpenPalm side: add the personal stash (mounted at /host-stash). */
export function addHostStashToOpenpalmConfig(state, writable = true): void {
  upsertFilesystemSource(`${state.configDir}/akm/config.json`, {
    type: "filesystem", path: "/host-stash", name: HOST_SOURCE_NAME, writable, enabled: true,
  });
}

/** Personal side: add OP_HOME/knowledge to ~/.config/akm/config.json.
 *  Touches the user's home dir → requires explicit consent (wizard/admin). */
export function addOpenpalmStashToHostConfig(hostConfigPath: string, knowledgePath: string, writable = true): void {
  upsertFilesystemSource(hostConfigPath, {
    type: "filesystem", path: knowledgePath, name: OPENPALM_SOURCE_NAME, writable, enabled: true,
  });
}

export function disableHostAkmSharing(state, hostConfigPath: string): void {
  removeSourceByName(`${state.configDir}/akm/config.json`, HOST_SOURCE_NAME);
  removeSourceByName(hostConfigPath, OPENPALM_SOURCE_NAME);
}
```

**Profile import (read-only snapshot)** — separate function, reuses the validated
admin/akm shape:

```ts
/** Copy profiles.llm/agent + defaults.llm/agent from the personal akm config
 *  into the OpenPalm config. Reads the host config READ-ONLY; never writes back. */
export function importHostProfiles(state, hostConfigPath: string): { imported: string[] } { /* … */ }
```

Invariants enforced by the module (unit-tested):
- Only ever **appends/updates a named source** and (for import) `profiles`/`defaults`.
- Never sets `primary`, never sets `defaultWriteTarget`, never reorders the primary.
- Atomic 0600 writes; corrupt-config tolerant (parse-fail → start from `{}` for the
  OpenPalm config; for the **personal** config, parse-fail must **abort** rather than
  overwrite the user's file — fail closed).
- Removing OpenPalm later leaves at worst a dangling source entry pointing at a
  deleted dir, which akm skips gracefully (`walker.ts:73`).

### 8.6 Setup wizard wiring

`host-status` already returns `hostAkmAvailable` + `hostAkmPaths`
(`api/setup/host-status/+server.ts`). Repurpose the existing toggle:

1. `OptionsStep.svelte` "Shared AKM" toggle → relabel "Share knowledge with my host
   AKM (read + contribute)", shown only when `hostAkmAvailable`. Add explicit consent
   copy: *"OpenPalm will add a source entry to your personal `~/.config/akm/config.json`
   and mount `~/akm` into the assistant. Your files' ownership is not changed and your
   primary stash is unchanged."*
2. In `performSetup` (`setup.ts`), **replace** the `OP_AKM_STASH`/`OP_AKM_CONFIG`
   branch (lines 246–252) with, when `hostAkm` is true:
   - write `OP_HOST_AKM_STASH=${HOME}/akm` to `stack.env`;
   - enable the `host-akm` compose overlay (same path as `setAddonEnabled`);
   - `addHostStashToOpenpalmConfig(state, /*writable*/ true)`;
   - `addOpenpalmStashToHostConfig(${HOME}/.config/akm/config.json, ${OP_HOME}/knowledge, true)`;
   - optionally `importHostProfiles(state, …)` if no LLM profile was set in the wizard;
   - `git init` both stashes if not already git-backed (recovery; §8.8).

### 8.7 Admin controls

New endpoint `packages/ui/src/routes/admin/akm/host-sharing/+server.ts`:

| Method | Action |
|---|---|
| `GET` | Report status: enabled?, `OP_HOST_AKM_STASH`, writable flag, both source entries present?, git-backed? |
| `PUT` | Enable: same five steps as the wizard (overlay + both source writes + optional profile import + git init). Requires `requireAdmin`. |
| `DELETE` | Disable: `disableHostAkmSharing` (remove both source entries) + disable overlay. Does **not** delete any stash content. |

Plus a "Re-import host profiles" action (calls `importHostProfiles`) — idempotent,
validated, atomic — surfaced as a button on the existing AKM admin tab.

### 8.8 Git-backing (recovery guarantee)

On enable, ensure **both** `OP_HOME/knowledge` and `~/akm` are git repos (`akm init`
git-inits a stash; or `git init` directly). Rationale: the one residual destructive
path is `consolidate`'s by-name overwrite/delete against the *running instance's own
primary* (it archives to `<primary>/.akm/archive` first, but git history is the
durable backstop). With both stashes git-backed, every merge/delete is recoverable,
and akm's end-of-run auto-sync batches commits (`knowledge:stash-sync-model`). Keep
`data/` and `cache/` (SQLite, embeddings) **out** of git via `.gitignore` — they live
outside the stash dirs anyway, so no extra ignore rules are needed.

### 8.9 Residual risks after this design (and mitigations)

| Risk | Severity | Mitigation in this design |
|---|---|---|
| Container recurse-chowns personal `~/akm` | was HIGH | **Eliminated** — §8.4 never chowns bind mounts; runs as host UID. |
| Shared SQLite contention (personal ↔ OpenPalm) | was MED | **Eliminated** — only stash *sources* are shared; data/cache stay per-instance. |
| Cross-namespace lock steal on a shared primary | was MED | **Eliminated** — separate primaries → separate `improve.lock` files. |
| `feedback --applied-to` appends `lessonStrength` into a secondary lesson file (ignores writable flag) | LOW | Non-destructive frontmatter append; it's the desired contribution. Git-backed → reversible. |
| `consolidate` by-name overwrite/delete in the running instance's **own** primary, influenced by federated secondary candidates | LOW | Archives before delete; **both stashes git-backed** (§8.8) → recoverable. Optionally scope consolidate with `--target` to primary-only candidates. |
| A and H (OpenPalm container vs host task-runner) still share `OP_HOME/data/akm` across PID namespaces | LOW (pre-existing) | Out of scope for this change; note for follow-up. H is short-lived/infrequent; WAL + `busy_timeout` absorbs it. |
| User's personal `config.json` is corrupt when we go to append | LOW | Personal-config writer **fails closed** (abort, don't overwrite) — §8.5. |

### 8.10 Does this answer the brief?

- *Share everything (cache, state.db)?* — **No.** Share stash content only; keep
  data/cache per-instance. This is what makes it safe.
- *Add each other's stashes as secondary sources?* — **Yes**, symmetric.
- *Writable?* — **Yes**, with `defaultWriteTarget` unset so writes default to each
  own primary; cross-writes are explicit `--target`. Git-backing makes the lone
  destructive path recoverable.
- *Easy for the user?* — One wizard toggle / one admin switch; everything else
  automated.
- *Import host config like providers?* — **Yes**, read-only profile snapshot,
  refreshable from admin.
- *Reuse host LLM/agent profiles?* — Same profile-import path.

## 9. Issues register (everything surfaced by this investigation)

All issues found while mapping the integration, with evidence and disposition. Severity:
**P0** = data-loss/safety, must ship with the feature; **P1** = correctness bug;
**P2** = cleanup / docs / follow-up.

### P0 — data-loss / safety

**I-1. Entrypoint recursively chowns bind-mounted host stashes on every boot.**
`containers/assistant/entrypoint.sh:46` runs `chown -R … /stash` (and would hit `/host-stash`).
`/stash` is the host's `OP_HOME/knowledge`; `/host-stash` is the user's personal `~/akm`.
With a host UID ≠ 1000, or with host-akm sharing on, this silently rewrites ownership of
the user's files every start. **Fix:** §8.4 — chown only container-private paths; never a
bind mount; run as host UID/GID (already via gosu).

**I-2. `hostAkm` split-brain.** `setup.ts:246-252` repoints only the *container*
(`OP_AKM_STASH`/`OP_AKM_CONFIG`) while the host task-runner (`buildAkmEnv`) and
cache/data ignore the override → container and host read different stashes while sharing
DBs. **Fix:** §8.3 — drop the overrides; the personal stash is a *secondary source*, never
the container's primary.

### P1 — correctness bugs

**I-3. Wizard writes akm LLM config in a legacy shape — works today only via a
migration shim explicitly marked legacy.** `setup.ts:269` writes a **top-level `llm`**
object (`{endpoint, model, provider}`). The 0.8.0 top-level schema is `.strict()`
(`akm/src/core/config-schema.ts:574`, `AkmConfigShape` has no `llm` key) and "fields
validate loudly — shape errors **throw at load time**" (`config-schema.ts:550-553`). On
its own, a top-level `llm` key would be a fatal `INVALID_CONFIG_FILE` error that breaks
*every* akm command in the assistant. **Verified what saves it:** `loadUserConfig`
auto-migrates *before* validating (`config.ts:163`), and `config-migration.ts:315-331`
detects a top-level `llm` with a string `endpoint`, moves it to `profiles.llm.default`,
sets `defaults.llm = "default"`, and deletes the legacy key. The runtime resolver then
reads `profiles.llm[defaults.llm]` (`config.ts:230-258`). **So the wizard's LLM config
IS applied today** — `embedding` is also a valid top-level key, so that half is native.
**But two problems remain:** (a) it depends entirely on a migration path the akm source
labels *"legacy 0.7→0.8 input transforms"* whose *"only remaining job was holding the
legacy block"* (`config-migration.ts:329-331`) — when akm drops that shim (0.9.0?), the
wizard's config becomes a fatal load error overnight; (b) the auto-migrate rewrites
`config/akm/config.json` to disk on first load (`config.ts:163` "rewrite legacy shapes
to disk on cache miss"), an unexpected config write that interacts with I-5. **Fix:**
have OpenPalm write the canonical shape directly — `profiles.llm.default = {endpoint,
model, provider}` + `defaults.llm = "default"` — in `setup.ts` and `importHostProfiles`
(§8.5), so we depend on the stable schema, not the legacy migration. Add a regression
test that loads the written config through akm and asserts no migration/rewrite occurs.
**Severity: P1** (latent — not user-visible today, fatal when the shim is removed).

**I-4. A↔H share `OP_HOME/data/akm` and the primary stash across PID namespaces.**
The assistant container (cron + 60s task-sync + any `improve`) and the host task-runner
(`executeAutomation` → `akm tasks run` via `buildAkmEnv`) both write the same `state.db`/
`index.db` and the same `OP_HOME/knowledge/.akm/{proposals,improve.lock}`. akm's
PID-staleness lock reclaim can't serialize a container process against a host process
(different PID namespaces; `akm/src/core/file-lock.ts:95`), and WAL raises `SQLITE_BUSY`
under sustained concurrent writers. **Pre-exists the personal-akm work** — present in
every install today. **Fix options (pick one):** (a) make H reuse the running container
(`docker exec … akm tasks run`) instead of a separate host akm process, so there is one
writer; or (b) give H its own `AKM_DATA_DIR`/`AKM_CACHE_DIR` and have it operate on the
stash via an explicit lock both honor; or (c) gate H to never run while the container's
scheduler might (single-writer schedule). (a) is preferred — it eliminates the second
writer entirely.

**I-5. akm config writes can clobber (`config.json.lck` is best-effort).** A and H both
target `OP_HOME/config/akm/config.json` — OpenPalm writes it directly (atomic, e.g.
`setup.ts:286`, admin/akm PATCH) *and* akm itself rewrites it on `akm add`/`config set`
(under a lock that proceeds unlocked after retries, `akm/src/core/config-io.ts:170-192`).
Concurrent writes → last-writer-wins. **Fix:** funnel all OpenPalm-side config writes
through one atomic writer (already mostly true), avoid invoking `akm config set`/`akm add`
from inside the container against the shared config while the host may write it, and
prefer OpenPalm's direct atomic writer for the new source entries (§8.5) over shelling
out to `akm add`.

**I-6. "Set all four `AKM_*` env vars, or none."** akm 0.8.0 split storage into four XDG
bases; overriding only some leaves the lock/event DB on the host default and causes
cross-job contention (akm CHANGELOG). If any OpenPalm code path runs `akm` (esp.
`akm setup`/`akm init`) **without** all four set, akm writes to the operator's *global*
`~/.config/akm` / `~/.local/share/akm` — see the recorded forensic case (akm setup wrote
the global config regardless of `AKM_STASH_DIR`). `buildAkmEnv` (all four ✓) and
`core.compose.yml` (all four ✓) are correct; **audit every other `akm` spawn site**
(install scripts, tests, any host-side invocation) to confirm all four are set, and add a
guard/test. Directly relevant once we add a personal-akm source: a stray invocation could
mutate the user's global config.

### P2 — cleanup / docs / follow-up

**I-7. Guardian ships akm-cli but has no akm mounts/env.** `containers/guardian/Dockerfile:34`
installs `akm-cli@next` "for shared stash, env, secret, skill management," but
`channels.compose.yml` mounts the guardian only `config/guardian:/etc/opencode` +
`auth.json:ro` — **no `AKM_*` env, no stash/config/cache/data volumes**. akm inside the
guardian would fall back to an ephemeral default stash under `HOME=/opt/openpalm/guardian`.
**Decide:** either (a) remove akm-cli from the guardian image and fix the comment, or
(b) wire the guardian into the same safety model as a **third reader** (read-only stash
mount, own data/cache) — it must not become an unmanaged third *writer*.

**I-8. `AKM_CLI_VERSION=next` pinned to a moving prerelease** in both `containers/assistant/
Dockerfile:19` and `containers/guardian/Dockerfile:34`. A `next` republish can change akm
behavior under a fixed OpenPalm image — and this feature depends on multi-source/sync
semantics. **Fix:** pin to an exact version before 0.11.0 stable (existing TODO at
assistant Dockerfile:18). Tracked in [[project_0110_stable_cutover_todo]].

**I-9. Stale `packages/assistant-tools` references.** `CLAUDE.md` and project memory
describe `packages/assistant-tools/` with `load_vault`/`health-check`; the package is
gone — assistant akm tools now come from the `akm-opencode` plugin
(`.openpalm/config/assistant/opencode.jsonc:5`). **Fix:** update `CLAUDE.md` Key Files
table and the relevant memory so integration docs are accurate.

**I-10. `seedStashAssets` is dead code.** Exported and unit-tested
(`packages/lib/src/control-plane/core-assets.ts:73`) but has **no caller** — actual stash
seeding goes through `seedOpenPalmDir`/`copyTree` (`install.ts:225`). Two seeding paths
honoring "never overwrite" is unjustified duplication (violates the repo's
remove-unjustified-complexity directive). **Fix:** remove `seedStashAssets` + its test, or
make it the single seeding path used by install.

**I-11. 60-second `akm tasks sync` background loop is a constant DB writer.**
`entrypoint.sh:126-133` re-runs `akm tasks sync` every 60s regardless of change, adding
steady `state.db` write traffic and contention (worsens I-4). **Fix:** make it
change-detecting (only sync when `knowledge/tasks/` mtime changed) or event-driven (watch
the dir); at minimum widen the interval.

**I-12. Network-filesystem hazard.** If `OP_HOME` lives on NFS/SMB, SQLite WAL
(`state.db`/`index.db`) is unsafe (akm investigation §4). **Fix:** document the
local-filesystem requirement for `OP_HOME`; optionally detect-and-warn at install.

**I-13. `akm feedback … --applied-to` ignores the `writable` flag** (upstream akm
behavior): it resolves the lesson's path from the index DB and rewrites that file in place
wherever it lives (`akm/src/feedback-cli.ts:68-124`). With a writable secondary this means
the assistant can append `lessonStrength:` frontmatter into a `~/akm` lesson with no
`--target`. Non-destructive and arguably desired, but **note in user-facing docs** so the
behavior isn't surprising; recoverable via git-backing (§8.8).

### Disposition summary

| ID | Severity | Ship with feature? | Where handled |
|---|---|---|---|
| I-1 chown clobber | P0 | **Yes (prerequisite)** | §8.4 |
| I-2 hostAkm split-brain | P0 | **Yes** | §8.3 |
| I-3 LLM config legacy shape (works via migration shim) | P1 (latent) | Recommended (fix alongside §8.5) | I-3 fix + §8.5 |
| I-4 A↔H shared DB/lock | P1 | Recommend with feature (worsened by it) | I-4 option (a) |
| I-5 config clobber | P1 | Yes (touched by §8.5 writers) | I-5 fix |
| I-6 all-four-env-vars audit | P1 | Yes (personal config at risk) | I-6 audit + test |
| I-7 guardian akm | P2 | Decide before stable | I-7 |
| I-8 version pin | P2 | Before 0.11.0 stable | I-8 |
| I-9 stale docs | P2 | Anytime | I-9 |
| I-10 dead code | P2 | Anytime | I-10 |
| I-11 tasks-sync loop | P2 | Follow-up | I-11 |
| I-12 network FS | P2 | Doc now | I-12 |
| I-13 feedback writable | P2 | Doc now | I-13 |
