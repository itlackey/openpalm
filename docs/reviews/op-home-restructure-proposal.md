# Proposal — Restructure `OP_HOME` Around Enforced Boundaries

**Date:** 2026-08-08
**Revision reviewed:** `0374093` (main, v0.13.0-beta.23)
**Status:** proposal / RFC — not implemented
**Companion:**
[`op-home-structure-issues-and-lessons.md`](op-home-structure-issues-and-lessons.md)
(the evidence base; issue labels like *A1*, *B2*, *C3* below refer to its
catalog)

> This proposal touches the layout defined in the authoritative
> [`../technical/core-principles.md`](../technical/core-principles.md). It is a
> design for discussion; adopting any part of it requires the explicit approval
> that document reserves.

---

## 1. The one root cause

The companion document catalogs 79 issues across seven families (plus four
verified-but-unaddressed edge cases). Almost all of them reduce to a single
sentence:

> **`OP_HOME` is split by three different classification axes at once, but only
> one of those axes is actually enforced by the runtime — and it is not the one
> the directory names describe.**

The three axes:

| Axis | Question it answers | Who enforces it |
|---|---|---|
| **Writer** | user / release / app / service — who may write this? | *nobody* — convention, per-file lists, and a pre-deploy audit |
| **Exposure** | is this bind-mounted into the assistant (agent-readable)? | **Docker** — structurally, at container start |
| **Durability** | durable / regenerable — is it safe to delete? | *nobody* — parallel hand-maintained scope lists |

The top-level trees (`config/`, `system/`, `state/`, `knowledge/`, `data/`,
`workspace/`, `private/`, `cache/`) are named for a mix of all three. When a
file's correct answer on the *exposure* axis (the enforced one) disagrees with
the tree its *name* implies, you get a bug:

- A secret named for its *kind* (`knowledge/secrets/`) landed in a tree defined
  by its *exposure* (`/stash`) → every delegated credential was agent-readable
  (**A1**), and one that was missed stayed readable and made admin cookies
  forgeable (**A2**).
- The stack env file named for its *writer* ("app state") had to be argued out
  of the tree defined by *exposure* three separate times (**A4**).
- App-generated runtime config had nowhere to live: `system/` is defined by
  *writer* (release) and gets overwritten, so the tunnel config placed there
  was destroyed by the next update (**B1**); `state/` is defined by *writer*
  (app) and "never mounted", so absorbing the config there blurred that
  contract (**B3**).
- `system/` is defined by *writer* (release) but is *mounted rw* — an exposure
  fact — so the agent can rewrite its own permissions (**A14**) and the
  reconciler crashed on runtime debris in the tree it thought it owned
  (**B2**).

Everything else is downstream: because the enforced axis (exposure) is implicit
and the declared axes (writer, durability) are encoded as parallel code lists,
each list drifts independently (**B8, F2, G6, G7**), each new tree is an
N-place change (lesson 24), and the boundaries that structure cannot express
are held up by a 450-line audit (**A6**), a mount-ordering trick (**A8**), and
a page of doc warnings (**A5**).

**The fix is not more trees. It is to make the enforced axis the primary,
explicit one, and to make the other two axes declared data instead of scattered
code.**

## 2. Design principles

These follow directly from the companion document's 25 lessons and from the
constitution's existing golden rules. The proposal must not violate the
constitution's "convention over configuration," "thin wrapper over Docker
Compose," "every file on disk is real and hand-editable," and "manual
management should be easy" — so nothing below changes the fact that the layout
is plain files under one root that an operator can read and edit.

1. **The unit of mounting is the unit of trust; organize the top level by
   exposure.** (lessons 1, 2)
2. **Every tree declares its properties as data; every scope derives from that
   declaration.** No parallel lists. (lessons 16, 20, 24)
3. **A managed (overwritten) tree contains only release bytes and is mounted
   read-only.** Runtime writes go to a sibling the reconciler never inspects.
   (lessons 8, 16)
4. **App-generated, container-visible runtime files get a home whose contract
   actually fits them** — not a bent definition of `state/`. (lesson 16)
5. **Convention-only invariants become checked invariants** — a runtime
   assertion, a `:?` guard, a manifest-coverage test — wherever a comment is
   currently the only thing holding a boundary. (lessons 3, 9, 13, 21)
6. **Nothing renames without the established migration discipline**: backup
   first, copy-verify-then-delete, version-gated, idempotent, leave-both-on
   conflict, sweep every doc/UI string. (lessons 18, 19)
7. **Reduce the single-filesystem blast radius** where it is cheap to do so.
   (G4, G6)

## 3. Target layout

The top level is **grouped by exposure**, with writer and durability shown as
*declared attributes* (§4 makes them machine-readable). Names are kept wherever
a rename's migration cost (**G2**) outweighs the clarity gain; the changes are
deliberately few.

```
~/.openpalm/
├─ agent/                    # EXPOSED: everything bind-mounted into the assistant
│  ├─ knowledge/             #   (= today's knowledge/ minus secrets/) — /stash
│  │  ├─ env/user.env        #   AKM env:user (loaded on demand, never sourced)
│  │  ├─ tasks/              #   scheduler queue — assistant-writable ONLY (A13)
│  │  ├─ skills/             #   release-seeded; needs provenance (B11/K7)
│  │  └─ provider-auth/auth.json   # was knowledge/secrets/auth.json (A4/A5)
│  ├─ workspace/             #   /work
│  └─ config/                #   was config/assistant, config/paperclip/opencode
│                            #   (the user OpenCode config that IS mounted in)
├─ private/                  # NEVER EXPOSED: delegated credentials + app env
│  ├─ secrets/               #   the ONLY tree named "secrets" (A5 resolved)
│  └─ env/paperclip.env      #   the one audited env_file exception (A9)
├─ system/                   # MANAGED, read-only mounts, overwritten wholesale
│  ├─ stack/                 #   core/services/portals compose files
│  ├─ assistant/ guardian/ paperclip/   #   OPENCODE_CONFIG_DIR, mounted :ro (A14/B2)
├─ runtime/                  # APP-GENERATED, container-visible, never overwritten
│  └─ remote/                #   was state/remote (B1/B3 resolved)
├─ state/                    # APP RECORDS, never mounted into any container
│  ├─ stack.env              #   the single Compose --env-file
│  ├─ schema-version host-identity.json ownership-repaired.json
├─ config/                   # USER, non-secret, NOT mounted (stack overlay, akm)
│  ├─ stack/custom.compose.yml
│  └─ akm/  guardian/  paperclip/akm/
├─ data/                     # SERVICE-OWNED durable state, native-path mounts
│  ├─ assistant/ guardian/ paperclip/ tunnel/ akm/ logs/ backups/ rollback/ ui/
└─ cache/                    # REGENERABLE; excluded from backup + ownership repair
   ├─ assistant/ guardian/ paperclip-opencode/runtime/
   └─ assistant-opencode/runtime/ guardian-opencode/runtime/   # NEW (A14/B2)
```

What changed, and why, in one table:

| Move | From → To | Fixes | Cost |
|---|---|---|---|
| **Group the mounted-into-agent surface under one parent** whose name *is* its exposure | `knowledge/`, `workspace/`, `config/assistant` → `agent/*` | A1–A5, A8: "is this agent-readable?" becomes visible in the path, not inferred from the mount list | Rename migration; overmount paths update |
| **Rename provider auth off the word "secrets"** | `knowledge/secrets/auth.json` → `agent/knowledge/provider-auth/auth.json` | A5: only `private/secrets/` is ever "secrets" | Migration + single-file bind path update (**C1**: still a directory-parent mount) |
| **Mount all managed OpenCode config read-only; add per-service rw runtime copies** | `system/{assistant,guardian}` `:rw` → `:ro` + `cache/{assistant,guardian}-opencode/runtime` `:rw` at `/etc/opencode` | A14, B2: agent can't rewrite its own policy; reconciler never sees runtime debris | New cache subtrees; entrypoint copies bootstrap → runtime (Paperclip's existing pattern) |
| **Give app-generated container-visible files a real tree** | `state/remote` → `runtime/remote` | B1, B3: `state/` returns to "never mounted"; `runtime/` is "app-written, mounted, never overwritten" | New tree; one mount source path |
| **Un-share `knowledge/` across trust levels** | Paperclip mounts specific subtrees, `tasks/` not at all | A13: no addon can drop an executable cron file | Compose mount edits only |

Everything else keeps its current name and location. `state/`, `config/` (the
non-mounted remainder), `data/`, and `cache/` are unchanged except that
`state/` is now *actually* never-mounted again.

### Why "group under `agent/`" rather than "keep flat and just rename"

The alternative is to leave `knowledge/`, `workspace/`, and the mounted
`config/assistant` at the top level and merely rename `knowledge/secrets/`.
That fixes **A5** but not the underlying legibility problem: an operator or a
future contributor still cannot tell, from the top level, which trees are
agent-visible. Grouping them under a single `agent/` parent makes the enforced
boundary the first path segment — the same instinct that put delegated
credentials under `private/`. It also makes the audit's "no `private/` bind
mount" rule (**A6**) generalizable to "no `agent/` bind mount carries a
delegated secret," checkable structurally.

## 4. The mechanism: one tree manifest, all scopes derived

This is the load-bearing change and the one that pays for itself even if no
directory ever moves. Today the layout is expressed as **seven independent
lists**: `ensureHomeDirs` (create), `ownershipRepairPaths` +
`ownershipCanaryPaths` (repair/canary), the backup include/exclude in
`backup.ts`, the purge enumeration in `uninstall.ts`, the rollback scope, and
the well-known-path helpers in `home.ts`. Each drifted independently — the CLI
dir list fell behind (**B8**), `private/` was purge-missed (**G7**), 18 copies
of one path (**F2**).

Replace them with **one declarative manifest** — plain data in `home.ts`, the
module that is already the single source of truth for paths:

```ts
// illustrative shape, not final
type TreeSpec = {
  path: string;                       // relative to OP_HOME
  writer: 'user' | 'release' | 'app' | 'service' | 'system';
  agentExposed: boolean;              // bind-mounted into the assistant?
  durability: 'durable' | 'regenerable';
  overwrite: 'never' | 'wholesale' | 'seed-once';
  backup: boolean;                    // in lifecycle safety backups?
  ownershipRepair: boolean;
  purge: boolean;                     // removed by --purge
};

export const OP_HOME_TREES: readonly TreeSpec[] = [
  { path: 'agent/knowledge', writer: 'user',    agentExposed: true,  durability: 'durable',     overwrite: 'never',    backup: true,  ownershipRepair: true,  purge: true },
  { path: 'private',         writer: 'app',      agentExposed: false, durability: 'durable',     overwrite: 'never',    backup: true,  ownershipRepair: true,  purge: true },
  { path: 'system',          writer: 'release',  agentExposed: false, durability: 'durable',     overwrite: 'wholesale',backup: true,  ownershipRepair: true,  purge: true },
  { path: 'runtime',         writer: 'app',      agentExposed: true,  durability: 'durable',     overwrite: 'never',    backup: true,  ownershipRepair: true,  purge: true },
  { path: 'state',           writer: 'app',      agentExposed: false, durability: 'durable',     overwrite: 'never',    backup: true,  ownershipRepair: true,  purge: true },
  { path: 'cache',           writer: 'system',   agentExposed: true,  durability: 'regenerable', overwrite: 'never',    backup: false, ownershipRepair: false, purge: true },
  // …data/, config/, workspace/
];
```

Then:

- `ensureHomeDirs` iterates the manifest (plus a small file-seed list).
- Backup include/exclude = `trees.filter(t => t.backup)`; purge = `t.purge`;
  ownership repair = `t.ownershipRepair`. **Adding a tree is a one-line change**
  (kills lesson 24 / **G7** at the root), and a single test asserts every tree
  appears in every scope it should — the completeness check that does not exist
  today.
- **The exposure axis becomes machine-checkable.** A test asserts: no
  `agentExposed` tree is the source of any Compose *secret* or of any
  delegated-secret file; every delegated secret resolves under a
  `agentExposed: false` tree. That is **A1/A2/A4** enforced by construction
  instead of by a migration that had to run twice and a doc warning.
- The secret-audit's per-service allowlist and `private/`-bind check (**A6**)
  stay — a resolved-config audit is still the right backstop for a user-editable
  overlay — but they now cross-check against the manifest rather than hard-coded
  path regexes, so they can't disagree with the tree definitions.

This mechanism is pure control-plane code; it changes nothing on disk and keeps
every file hand-editable, satisfying the constitution.

## 5. Structural fixes for convention-only boundaries

Each of these converts a boundary the companion doc found "held by a comment"
into one held by a check. They are valuable **independently of any directory
move** and could ship first.

**5.1 `${OP_HOME}` mount sources fail loud (`C10`).** Change every
`${OP_HOME}/...` bind source in the managed compose files to
`${OP_HOME:?OP_HOME is required}/...`, matching the image-version guards that
already exist. A hand-run `docker compose` without `--env-file` then aborts
instead of silently rewriting every mount to a root-anchored path Docker
creates as root. Pairs with an audit rule: every `${VAR}` in managed compose is
either `:?`-guarded or has a default provably in the safe direction.

**5.2 Paperclip's `/stash` isolation gets a runtime assertion (`A8`).** The
overmount trick that hides the assistant's provider auth from Paperclip is
invisible and order-fragile. Add a startup probe in Paperclip's entrypoint that
fails closed if `/stash/provider-auth/auth.json` (or `/stash/env/user.env`) is
*readable* — turning "we mounted the overlays in the right order" into a checked
precondition. The `agent/`-grouping in §3 also lets the audit forbid Paperclip
from mounting the parent `agent/knowledge` at all, mounting only its specific
subtrees (see 5.4).

**5.3 Host-path env values are validated at write time, and `OP_HOME` is
canonicalized (`C6`, `C14`, unaddressed-risks §2.5).**
`OP_HOST_AKM_STASH` is a raw host path consumed as a mount source — the one
bind source outside `OP_HOME`, and therefore outside the #452 pre-creation and
ownership-repair net (**C14**). Validate it on write (absolute, exists,
operator-owned, not inside a private tree), `mkdir` it operator-owned on
enable so native Linux never auto-creates it root-owned, align the
headless-setup default with the wizard's (off), and make "never chown a
foreign mount" a test over the entrypoint. Separately, resolve `OP_HOME`
through `realpath()` once at the top of `home.ts` (today it is lexical only,
so a symlinked home can fall outside the `startsWith(homeRoot)` scope guard
that drives mount discovery) — this closes the symlink edge in §2.5 and makes
the manifest's exposure/scope reasoning sound under symlinks.

**5.4 The scheduler queue is single-writer (`A13`).** `agent/knowledge/tasks/`
is executed by the assistant's cron. No other trust level may write it: Paperclip
mounts only `knowledge/paperclip/*` and (if it needs shared knowledge at all)
the rest of `knowledge/` read-only — never `tasks/` writable. This is a compose
mount change plus an audit assertion that no non-assistant service has a
writable mount overlapping `tasks/`.

**5.5 Managed policy is read-only to the process it governs (`A14`, `B2`).**
Generalize the pattern Paperclip already uses: mount `system/assistant` and
`system/guardian` `:ro` at `/etc/opencode`, and give each a
`cache/<svc>-opencode/runtime` `:rw` copy that the entrypoint seeds from the ro
bootstrap (where OpenCode installs plugin `node_modules`). The reconciler's
`overwriteSystemTree` then walks a tree that genuinely contains only release
bytes — no symlink-tolerance special case (**B2**), and the agent can no longer
rewrite its own permissions between reconciles.

## 6. Migration plan

Renames are expensive and dangerous — the companion doc's entire G family is
proof (**G1, G2, G3**). This proposal is therefore **phased so that the highest
value lands with the lowest risk first**, and every rename uses the discipline
the project already has (`home-schema.ts` gate, `secrets-migration.ts`
copy-verify-delete, the 0.11.0 backup-first/abort-on-failure pattern).

| Phase | Contents | On-disk moves? | Risk |
|---|---|---|---|
| **0 — Manifest + checks** | §4 manifest; derive all scope lists from it; add the exposure-invariant test and the manifest-coverage test | none | low — pure refactor, behavior-identical |
| **1 — Structural guards** | §5.1 (`:?`), §5.3 (host-path validation), §5.4 (single-writer tasks), §5.5 (ro policy + runtime copy), §5.2 (Paperclip assertion) | none (5.5 adds cache subtrees, pre-created) | low–medium — compose + entrypoint edits, each test-pinned |
| **2 — `runtime/` split** | move `state/remote` → `runtime/remote`; `state/` reverts to never-mounted; manifest gains one row | one app-generated dir | low — small, recent, single consumer |
| **3 — De-"secrets" the agent tree** | `knowledge/secrets/auth.json` → `agent/knowledge/provider-auth/auth.json`; sweep the Connections/UI strings (the **A1** relapse lesson) | one file (directory-parent mount, **C1**) | medium — touches the single-file bind and provider-auth |
| **4 — `agent/` grouping** | `knowledge/`, `workspace/`, mounted `config/assistant` → under `agent/`; update mounts + overmounts | several dirs | medium–high — largest rename; do last, or defer indefinitely |

Phases 0 and 1 deliver most of the security and correctness value **without
moving a single file**, and are individually shippable. Phase 4 is the only
high-cost move and is explicitly optional: if the manifest (Phase 0) makes
exposure a checked property, the flat layout with `knowledge/secrets/` renamed
(Phase 3) may be *good enough*, and Phase 4 becomes a legibility nicety rather
than a correctness fix. **Recommendation: commit to 0–3; treat 4 as a separate
decision.**

Migration mechanics for any rename phase, per the established pattern:

1. Bump `HOME_SCHEMA_VERSION`; add a `MIGRATIONS` entry keyed on `since`.
2. Copy → read back and verify byte-identity → only then remove the source;
   leave both and warn on conflict (`secrets-migration.ts` semantics).
3. For secret/auth moves, re-list the migration if `DELEGATED_SECRET_NAMES` or
   the moved set grows (the **A2** lesson: a set-driven migration must re-run
   when the set grows).
4. Sweep every doc and UI string naming the old path in the *same* change (the
   **A1** relapse: the Connections page kept naming the old path for a
   release).
5. The one-release deprecation bridge for anything a `custom.compose.yml`
   overlay could reference (the **G2** lesson: user overlays are public API).

## 7. Reducing the single-filesystem blast radius (optional, G4/G6)

The single-root design concentrates durable data, backups, caches, and logs on
one filesystem, and the backup discipline turned that into a disk-fill hazard
(**G6**). `OP_BACKUP_DIR` already relocates backups. Extend the same
already-there pattern to the two other high-growth trees behind env overrides —
`OP_CACHE_DIR` and `OP_DATA_DIR` (both defaulting to under `OP_HOME`, both
resolved through the manifest so nothing hard-codes the path). This is not a
layout change so much as making the existing single-root assumption *optional*
for operators on constrained or multi-volume hosts, and it costs one resolver
change per tree now that paths derive from the manifest.

## 8. Portability notes (rootless / VM-mediated / Windows)

The restructure must not regress the hard-won portability the companion doc
records (**C3, C4, C7, E1, E4, B9**). Explicit constraints:

- Every new/moved tree is pre-created operator-owned by `ensureHomeDirs` before
  Compose runs (**C3, C4**); the new `cache/*-opencode/runtime` copies are
  regenerable and excluded from ownership repair via their manifest row.
- The ro→rw runtime-copy split (5.5) uses bind mounts of pre-created
  directories, never named volumes nested in binds (**C4**).
- VM-mediated ownership handling (**E4**) is unaffected: the manifest changes
  *which* paths are repaired, not the host-vs-VM partitioning of *how*.
- No new single-file bind mounts are introduced; `provider-auth/auth.json`
  stays a file inside a directory-parent mount and keeps its in-place writer and
  inode test (**C1**).
- `runtime/remote` remains a **directory** mount for the same containerboot
  fsnotify reason (**C2**).

## 9. Non-goals

- **Not** changing the Compose-native, hand-editable, "thin wrapper" model. The
  manifest is control-plane code; the on-disk result is still plain files under
  one root.
- **Not** eliminating the secret audit (**A6**). A user-editable last-wins
  overlay plus one interpolation namespace will always need a resolved-config
  backstop; the manifest makes the audit's rules *derive from* the tree
  definitions instead of duplicating them.
- **Not** re-basing the layout off a POSIX home. `~/.openpalm`, `chmod`, and
  uid:gid remain the model; Windows/WSL and the VM-mediated macOS runtimes
  (**E4, E8**) stay handled by the existing skip-lists, which the manifest's
  `ownershipRepair` flag now drives instead of hard-coded platform checks.
- **Not** unifying the harness env/URL resolution divergences (**D13, D14,
  D15, E9**). Those are control-plane code bugs (Electron vs CLI env
  precedence; Compose's shell-env-beats-`--env-file`; bind-vs-connect address;
  the relocated tunnel socket), not layout facts. They are cited here because
  they share the layout's core failure shape — *one value, many independent
  resolvers* — and the same "one resolver, derive don't re-read" discipline
  the manifest applies to paths should apply to them; but fixing them does not
  require moving a directory.
- **Not** fixing the disk-headroom preflight measuring OP_HOME's filesystem
  while pulls fill Docker's data root (**G6**) — a real bug, but one about
  *where free space is measured*, orthogonal to the tree layout. Noted here so
  the `OP_DATA_DIR`/`OP_CACHE_DIR` relocation in §7 does not obscure that the
  Docker data root is a separate filesystem the layout does not own.
- **Not** solving the Paperclip embedded-database backup asymmetry (**G5**) by
  moving trees — that is a per-service durability declaration, best handled by a
  manifest attribute (`restoreUnit`) plus the existing operator runbook, not by
  relocating `data/paperclip`.
- **Not** addressing the `knowledge/skills` update-channel gap (**B11/K7**)
  here beyond noting the manifest is the right place to carry the per-tree
  provenance flag that would fix it.

## 10. Summary

The layout's problems are not a shortage of trees; they are three
classification axes competing for one namespace, with only the exposure axis
actually enforced — and enforced implicitly, by the mount graph, rather than
made visible. This proposal:

1. Makes **exposure the primary, explicit axis** (`agent/` vs everything else)
   and folds the two `secrets/` directories into one honest name (§3).
2. Makes **writer and durability declared data** in a single tree manifest that
   every scope derives from, killing the parallel-list drift class and making
   "add a tree" a one-line, test-covered change (§4).
3. Converts the **convention-only boundaries** — `${OP_HOME}` interpolation,
   the Paperclip overmount, the host-path env value, the shared cron queue, the
   rw policy mounts — into **checked** ones (§5).
4. Gives **app-generated container-visible files a real home** so `state/` and
   `system/` stop being bent to hold them (§3, Phase 2).
5. Sequences all of it so the **security and correctness value (Phases 0–1)
   ships with no file moves**, and the one expensive rename (Phase 4) is
   optional and last (§6).

The net effect: the boundaries the project currently defends with a 450-line
auditor, a mount-ordering trick, a migration that ran twice, and a page of doc
warnings become properties the structure states and a test enforces.
