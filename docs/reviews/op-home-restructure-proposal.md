# Proposal — Make `OP_HOME`'s Boundaries Honest

**Date:** 2026-08-08
**Revision reviewed:** `0374093` (main, v0.13.0-beta.23)
**Status:** proposal / RFC — not implemented
**Companion:**
[`op-home-structure-issues-and-lessons.md`](op-home-structure-issues-and-lessons.md)
(the evidence base; labels like *A1*, *B2*, *C3* refer to its catalog)

> This proposal touches the layout defined in the authoritative
> [`../technical/core-principles.md`](../technical/core-principles.md). It is a
> design for discussion; adopting any part of it requires the explicit approval
> that document reserves.

**Bias of this document:** every recommendation must either *delete*
something or cost a handful of lines. The constitution says the tooling is a
thin wrapper over Docker Compose and that simplicity and predictability are
features — a layout proposal that answers structural problems with new
subsystems would be a worse fix than the problem. Recommendations that could
not pay for themselves at that bar are listed in §5, with the reasoning, rather
than silently dropped.

---

## 1. The root cause

The companion document catalogs 79 issues. Almost all reduce to one sentence:

> **`OP_HOME` is split by three classification axes at once — writer, exposure,
> durability — but only exposure is actually enforced, implicitly, by the mount
> graph. When a file's name implies one axis and its mount answers another, you
> get a bug.**

| Axis | Question | Enforced by |
|---|---|---|
| **Writer** | user / release / app / service — who writes this? | convention |
| **Exposure** | is this bind-mounted into the assistant? | **Docker, structurally** |
| **Durability** | is it safe to delete? | convention |

Worked examples:

- A directory named for its *kind* (`knowledge/secrets/`) sat in a tree defined
  by its *exposure* (`/stash`) → every delegated credential was agent-readable
  (**A1**); the one that was missed made admin cookies forgeable (**A2**).
- The stack env file, named for its *writer*, had to be argued out of the
  exposed tree three separate times (**A4**).
- `system/` is defined by *writer* (release, overwritten wholesale) but is
  *mounted rw* — an exposure fact — so the agent can rewrite its own
  permissions (**A14**) and generated config placed there was destroyed by the
  next update (**B1**).

**The corollary that drives everything below:** the fix is to make names and
mounts agree — not to add a subsystem that watches them disagree. The project
already has one of those (`secret-audit.ts`, 450 lines, **A6**), and every new
exception has made it longer.

## 2. What to change

Eight changes, ordered by value-per-line. Each states the issue it closes and
its cost. Six are one-liners or deletions; none introduces a new subsystem.

### R1 — Stop calling two opposite things "secrets"

`knowledge/secrets/` (agent-readable by design — it holds provider `auth.json`)
and `private/secrets/` (never agent-readable) coexist today, and the operations
doc must warn in *both* directions: "Do not bulk-move `knowledge/secrets/`" and
"Do not put delegated credentials under `knowledge/`" (**A5**).

**Change:** rename `knowledge/secrets/` → `knowledge/provider-auth/`. One
directory, one migration, one string sweep. `private/secrets/` becomes the only
path in the layout containing the word "secrets," which makes the rule
memorable without a warning label: *if it says secrets, the agent cannot read
it.*

**Cost:** a schema-gated migration + doc/UI sweep. **Deletes:** two standing doc
warnings and the most-cited naming confusion in the catalog.

### R2 — Give Paperclip its own stash instead of over-mounting the shared one

Today Paperclip gets three mounts: the whole `knowledge/` tree at `/stash`,
then `knowledge/paperclip/secrets` and `knowledge/paperclip/env` mounted *over*
`/stash/secrets` and `/stash/env` to hide the assistant's provider auth and
`user.env`. That isolation rests entirely on Compose honoring mount declaration
order (**A8**). It also leaves Paperclip writable access to everything else in
`knowledge/` — including `knowledge/tasks/`, which the assistant's cron syncs
and executes every 60 seconds (**A13**).

**Change:** mount `knowledge/paperclip` at `/stash`. If shared knowledge is
genuinely wanted, add explicit **read-only** mounts for the specific subtrees
that should be shared (e.g. `knowledge/skills:/stash/skills:ro`).

```yaml
# before — 3 mounts, isolation depends on ordering, tasks/ writable
- ${OP_HOME}/knowledge:/stash
- ${OP_HOME}/knowledge/paperclip/secrets:/stash/secrets
- ${OP_HOME}/knowledge/paperclip/env:/stash/env

# after — 1 mount, isolation is structural, no write path into tasks/
- ${OP_HOME}/knowledge/paperclip:/stash
```

**Cost:** a compose edit. **Deletes:** two mounts, an order-dependent security
argument, a paragraph of documentation, and an addon's write path into the
assistant's execution queue. This is the clearest case in the proposal where
correctness and simplicity point the same way.

### R3 — Make `${OP_HOME}` fail loudly in managed Compose

Image versions already use `${VAR:?required}`. Every bind-mount source is a
bare `${OP_HOME}/...` (**C10**), so a hand-run `docker compose` without
`--env-file` — the manual path the runbook documents — interpolates it to empty
and rewrites every mount to a root-anchored path (`/data/assistant`,
`/knowledge`, `/private/env/paperclip.env`), which Docker then creates
root-owned (**C3**).

**Change:** `${OP_HOME:?OP_HOME is required}` on mount sources and secret file
sources.

**Cost:** a find-and-replace in three shipped compose files. No code. Uses a
Compose feature the repo already relies on.

### R4 — Mount guardian's managed config read-only

`system/guardian` is mounted **rw** at `/etc/opencode`, giving the moderator
write access to the instructions and permissions that govern it (**A14**).
Verified against the source: guardian's entrypoint never writes there — its
packages live in `/opt/openpalm/guardian-pkg`, and `/etc/opencode` is only
passed as `OPENCODE_CONFIG_DIR` to the moderator
(`containers/guardian/entrypoint.sh:141`; no write, copy, or mkdir targets that
path).

**Change:** append `:ro` to that one volume line.

**Cost:** one word. (The assistant is *not* included — it genuinely writes
plugin `node_modules` into `/etc/opencode`. See §5.)

### R5 — Derive purge and ownership-repair from one list of trees

The catalog's sharpest lifecycle bug: when `private/` was added as a sibling of
`knowledge/`, the purge enumeration didn't gain it, so `--purge` reported "all
data removed" **while leaving every live credential on disk** (**G7**).

Checking the current tree rather than assuming: the layout is enumerated in
*three* places, not the seven an earlier draft of this proposal claimed —
`ensureHomeDirs` (`home.ts`), the base list in `ownershipRepairPaths`
(`ownership-reconcile.ts:42-53`), and the purge list (`uninstall.ts:73-114`).
Backup is already derived from a two-name *exclusion* (`data`, `cache`) and
needs no change.

**Change:** export the top-level tree names from `home.ts` as one constant, and
have the purge and ownership-repair base lists map over it instead of restating
it. Adding a tree becomes a one-line change in the module that already owns the
layout.

**Cost:** roughly 20 lines, net negative. **Explicitly not** a manifest with
per-tree attribute records — see §5.

### R6 — Canonicalize `OP_HOME` once

`resolveOpenPalmHome` uses lexical `resolvePath` only (`home.ts:30-34`), and
mount discovery decides "is this under `OP_HOME`?" with `startsWith(homeRoot)`
over un-canonicalized strings (`config-persistence.ts:544-556`). With a
symlinked home, a bind source expressed through the real path can fall outside
the pre-creation and ownership-repair scope — silently, and in the same
direction as **C14**.

**Change:** resolve through `realpath()` once at the root.

**Cost:** one line, plus a test.

### R7 — Close the `OP_HOST_AKM_STASH` hole

This is the one bind source that can point outside `OP_HOME`, and it therefore
inherits none of the guarantees the #452 work established: it is never
`mkdir`'d or existence-checked on enable (`host-akm-sharing.ts:63-71`), and
pre-creation is scoped to `OP_HOME` by design
(`config-persistence.ts:489-490`). On native Linux, enabling host AKM sharing
when `~/akm` does not exist makes Docker create it **root-owned** — outside the
repair scope. Compounding it, headless/API setup **default-enables** sharing
(`hostAkm !== false`, `setup.ts:83,495-497`) while the wizard defaults it off
(**C14**).

**Change:** on enable, validate the path (absolute, operator-owned) and create
it operator-owned; align the headless default with the wizard's (off).

**Cost:** a few lines in the one enable path. Closes a real root-owned-directory
hole and an unintended-default divergence.

### R8 — Fix the `state/` contract in the docs, don't invent a tree

`state/` is documented as app-written records that are never mounted; since the
remote addon shipped, `state/remote/` is a bind-mount source into the tunnel
container (**B3**). The contradiction is real, but it is a *documentation*
error: the file is app-written, survives updates, and is in the correct tree by
every property that matters. What is wrong is the sentence claiming `state/` is
never mounted.

**Change:** amend `core-principles.md` and `environment-and-mounts.md` to
describe `state/` as "app-written records and generated runtime config,"
retaining the load-bearing rule — **generated files never live in `system/`,
which is overwritten wholesale** (**B1**).

**Cost:** two doc edits, zero code, zero new trees.

## 3. What this adds up to

| | Before | After |
|---|---|---|
| Directories named "secrets" | 2, opposite meanings | 1 |
| Paperclip stash mounts | 3, order-dependent | 1, structural |
| Addon write path into cron queue | yes | no |
| Managed config writable by its own service | assistant + guardian | assistant only (documented) |
| Places enumerating top-level trees | 3 | 1 |
| Missing `OP_HOME` in manual Compose | silent root-anchored mounts | hard error |
| New subsystems, trees, or config formats | — | **none** |

No new top-level trees. No new file formats. No new runtime components. The
stack gets smaller: two fewer mounts, one fewer confusing name, two fewer
enumeration sites.

## 4. Sequencing

There is no dependency chain, so these can land independently, cheapest first:

1. **Free / one-liners:** R3 (`:?` guards), R4 (guardian `:ro`), R6
   (`realpath`), R8 (doc correction).
2. **Small, contained:** R7 (host-stash validation), R5 (shared tree list).
3. **Needs a migration:** R2 (Paperclip stash — compose-only, but changes an
   addon's data path, so it wants a release note), then R1 (the
   `provider-auth` rename).

For R1 and R2, use the migration discipline the project already has and has
already proven: schema-gated one-shot (`home-schema.ts`), copy → read back and
verify → only then delete, leave both and warn on conflict
(`secrets-migration.ts`), and sweep every doc and UI string naming the old path
in the *same* change — the **A1** relapse, where the Connections page kept
naming the moved path for a release, is the failure to avoid.

## 5. Considered and rejected

Recorded so the reasoning is reviewable, and so these are not re-proposed
without new evidence.

**A tree manifest with per-tree attribute records.** An earlier draft proposed a
`TreeSpec[]` carrying writer / exposure / durability / overwrite / backup /
purge / ownership flags, with every scope derived from it. Rejected: it was
justified by a claim ("seven independent lists") that does not survive checking
the tree — there are three, and one of them is already a two-name exclusion. R5
gets the same correctness benefit from a shared constant. Most of the proposed
fields (`writer`, `durability`, `overwrite`) would have been documentation
encoded as data, with no consumer — machinery that has to be maintained and can
itself drift.

**A startup assertion probe in Paperclip verifying its own isolation.**
Rejected on two grounds: it contradicts the deliberate decision (recorded in
commit `f7b8a02`, the constitution, and a test) to run the digest-pinned
upstream entrypoint unmodified; and R2 makes the property structural, so there
is nothing left to assert.

**Read-only managed config plus a mutable runtime copy for the assistant.**
This is the pattern Paperclip already uses, and it would close the assistant's
half of **A14**. Rejected *for now*: unlike guardian (R4), the assistant
genuinely writes plugin `node_modules` into `/etc/opencode`, so this requires
new entrypoint copy logic in a boot path that is already the most complex in the
stack — real machinery, for a fragility that has never been observed in an
incident. The pattern is documented and available if it ever does bite.

**`OP_CACHE_DIR` / `OP_DATA_DIR` relocation overrides.** Proposed to reduce
single-filesystem pressure (**G6**). Rejected: no operator has asked, and
`OP_BACKUP_DIR` already covers the tree that actually caused disk incidents.
Speculative configuration surface.

**A new `runtime/` top-level tree** for app-generated, container-visible files.
Rejected: it would add a ninth top-level tree to fix what is a one-sentence
documentation error (R8). The layout does not need a new category; the category
it has needs an accurate description.

**Regrouping the agent-exposed trees under a single `agent/` parent**
(`knowledge/`, `workspace/`, mounted `config/assistant`). This was the headline
structural move in an earlier draft, and its appeal is real: it would make
"can the agent read this?" answerable from the first path segment. Rejected as
disproportionate — it touches every mount line, every doc, and user data in
three trees, and needs the largest migration in the project's history. R1 and
R2 deliver the *correctness* value (honest names, structural isolation) at a
tiny fraction of the cost, leaving this as legibility-only. Worth revisiting
only if a future change makes the exposure boundary load-bearing in code.

## 6. Summary

The layout's problems come from names and mounts disagreeing, not from a
shortage of structure. The response is therefore to make them agree and delete
what the disagreement required:

- **R1, R2** — names and mounts tell the truth about exposure; Paperclip's
  isolation stops depending on mount order and loses its write path into the
  assistant's cron queue.
- **R3, R4, R6, R7** — four small correctness fixes where a boundary is
  currently held by a comment, three of them one-liners.
- **R5, R8** — one place defines the trees; the docs describe the trees that
  exist.

Nothing here adds a subsystem, a tree, or a config format, and the net effect
on the running stack is two fewer mounts and one fewer ambiguous name.
