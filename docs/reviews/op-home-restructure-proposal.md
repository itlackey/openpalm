# OP_HOME — Accepted Changes

**Date:** 2026-08-08 · **Status:** approved, not implemented
**Evidence:** [`op-home-structure-issues-and-lessons.md`](op-home-structure-issues-and-lessons.md) (labels below refer to its catalog)

## The rule

`OP_HOME` is split by three axes — writer, exposure, durability — but only
exposure is enforced, by the mount graph. Every trust bug was a file whose name
implied one axis while its mount answered another (**A1**, **A2**).

**A tree's name must agree with its mount.** No subtree needing different
exposure than its parent; no boundary held up by hiding one mount behind
another.

## The stash is AKM's

`knowledge/` is an AKM stash. Its contents — `env/`, `secrets/`, `skills/`,
`tasks/` — are AKM asset directories. **OpenPalm does not rename, relocate, or
reinterpret them.**

AKM ≥ 0.9.0 models multiple stashes as **bundles**: a named map of
`{path, writable, enabled}` (`akm-sources.ts:37-41`). A bundle path is
arbitrary, so bundle structure is *configuration*, not layout. Only two
services run AKM today — the assistant and Paperclip; guardian deliberately
dropped akm-cli (`containers/guardian/entrypoint.sh:116-118`).

## Bundle convention

Three tiers. The distinction that matters is **whose data it is**, because
that decides backup scope — not the fact that all three are AKM bundles.

| Tier | Location | Mount | `writable` | In safety backup |
|---|---|---|---|---|
| **System** — release-shipped skills | `system/skills/` | `:ro` | `false` | yes (`system/` is in scope) |
| **Primary — assistant** | `knowledge/` | rw | `true` | yes (top-level tree) |
| **Primary — addon** | `data/<svc>/bundle` | rw | `true` | with its service (one restore unit) |
| **Shared** | `knowledge/`, granted per addon | rw or `:ro` | per grant | yes |

**The assistant's stash is user data; an addon's stash is service data.** They
have the same shape, which is what makes it tempting to give them the same
home, but they sit on opposite sides of the backup boundary: `backup.ts:229`
skips top-level `data/` and `cache/` **by name**, and the space estimator
mirrors it (`backup.ts:33`). Putting the assistant's accumulated memory under
`data/` would remove the only irreplaceable bytes in `OP_HOME` from every
pre-migration snapshot — silently, since nothing measures what a backup should
have contained. An addon's bundle belongs there precisely because it travels
with that addon's other state.

Two rules follow:

1. **`:ro` on the mount is the boundary; akm's `writable` flag is a hint.**
   Paperclip's AKM config dir is mounted **rw** (`services.compose.yml:126`) and
   its own AKM process is a sanctioned writer of it, so a `writable:false`
   entry is a policy the governed process can rewrite — **A14**, lesson 8. When
   an operator grants a shared bundle read-only, that must be `:ro` in compose.
2. **A service gets a bundle only if it sets `AKM_BUNDLE_DIR`.** Otherwise the
   next addon author copies the assistant block and creates dead `bundle/`
   directories for guardian, the portals, ollama, voice, and tunnel — each a
   fresh **C3** surface.

## No `shared/` tree

`knowledge/` *is* the shared bundle; sharing is a mount plus a bundle entry.
A top-level `shared/` would be a ninth tree holding one child (**B5**), and
purge enumerates trees by resolver in an **allowlist** (`uninstall.ts:87-96`) —
so it would be silently missed and `--purge` would report "all data removed"
while shared knowledge survived. That is **G7** verbatim, the incident where
`private/` was missed the same way. Backup, by contrast, is a *denylist*, so a
new tree is auto-included: the two halves of the idea fail in opposite
directions, and D7 — the single tree constant that would catch it — is still
deferred.

It also breaks on the first plural: `shared/bundle` is a singular name, so a
second shared bundle forces a rename. As configuration, a second one is one
line.

## Layout changes

| Change | Effect |
|---|---|
| delete `knowledge/paperclip/{env,secrets}` | −2 dirs (`home.ts:360-361`) |
| delete the `/stash/env` + `/stash/secrets` overmounts | −2 mounts (`services.compose.yml:130-131`) |
| `private/` → `state/` | credentials to `state/secrets/`, audited env file to `state/env/`; 8 top-level trees → 7 |
| skeleton `knowledge/skills/` → `system/skills/` | in **this repo**, not in anyone's `OP_HOME` — `overwriteSystemTree` already refreshes `system/` wholesale, so shipped skills inherit an update channel for free (**B11/K7**) |

`knowledge/` keeps every AKM asset directory it has, and is not renamed. It is
also the assistant's primary bundle, so no user data moves and no `stashDir`
call site changes. A rename would additionally make the cache-cleanup safety
net vacuous — `storage-report.ts:55` matches the literal token `knowledge`, so
after a rename it would guard nothing while still passing.

For existing installs, the skills migration deletes from `knowledge/skills/`
only directories **byte-identical to what the previous release shipped**;
anything modified stays as the operator's own, with a notice. That avoids the
undecidable classification K7 documents, and avoids duplicate skills in AKM's
index.

## Code changes

| | Change | Cost |
|---|---|---|
| 1 | Secret routing defaults to `state/secrets/`; Secrets tab targets the agent-readable dir explicitly | 1 line + allowlist (**A2**) |
| 2 | `${OP_HOME:?}` on mount and secret sources | find/replace (**C10**) |
| 3 | `system/guardian:/etc/opencode:ro` — not 1 word: the moderator runs `opencode serve` with `OPENCODE_CONFIG_DIR=/etc/opencode` (`containers/guardian/entrypoint.sh:136-143`) and OpenCode writes into every config dir it loads (`ensureGitignore()` + `npm install @opencode-ai/plugin`, `opencode-behavior-notes.md:15-17`) | Paperclip's split: `:ro` bootstrap + disposable rw runtime dir (**A14**) |
| 4 | `realpath()` `OP_HOME` once | 1 line (**F7**) |
| 5 | Validate + pre-create `OP_HOST_AKM_STASH`; headless default off | few lines (**C14**) |
| 6 | Backup takes a service's data and credentials together, or neither | (**G5**) |
| 7 | `state/` documented as records **and** generated runtime config | doc (**B3**) |

## Accepted as-is

- Assistant writes its own `system/assistant` — OpenCode npm-installs
  `@opencode-ai/plugin` into it (declared plugins go to OpenCode's own cache,
  not a config dir), and the entrypoint seeds `AGENTS.md` there when it is
  absent on boot; both are runtime extras `overwriteSystemTree` must not read
  as retired (`core-assets.ts:196-214`).
- The secret audit stays (**A6**, **A7**) — a user-editable last-wins overlay
  always needs a resolved-config backstop.
- Deferred: shared tree constant. Parked: an `agent/` parent tree.

## Order

1. Code changes 2–5, 7 — no file moves.
2. Code change 1 — secret routing.
3. One schema-gated migration for the layout changes + the compose rewrite.
   `private/` → `state/` moves credential files, so it runs with the same
   copy → verify → delete discipline as the G1 relocation, and every
   `secrets:` `file:` source in the three managed compose files moves with it.
4. Backup coherence (6).

Migration discipline: backup first and abort on failure; copy → verify → then
delete; leave both on conflict; version-gated; sweep every doc and UI string
naming an old path in the same change (**A1**). `custom.compose.yml` may
reference moved paths — call it out in the release notes (**G2**).

## Verify before implementing

Three AKM behaviours the bundle convention rests on cannot be verified from
this repo — akm-cli is installed into the image at build time, not vendored:

1. **Untargeted write resolution.** `defaultWriteTarget` is never set anywhere.
   With three writable bundles, where does an untargeted write land? The nightly
   `akm improve` task runs unattended at 03:00 and promotes, merges, and
   deletes. If resolution is not deterministically `defaultBundle`, set
   `defaultWriteTarget` explicitly and extend `assertNoDefaultEscalation`
   (`akm-sources.ts:88-94`) to cover it.
2. **Cross-bundle read precedence.** A shipped skill and an operator's
   same-named skill is the *expected* collision. Which wins? If it is bundle-map
   iteration order, that is **A8**'s ordering fragility moved from Compose into
   JSON key order — worse, because it is invisible in a diff.
3. **`writable: false` has never run in production** — the only caller passing
   it is a unit test (`akm-sources.test.ts:51`). Both the system and shared
   tiers rest on it.

Also settle the scheduler: `akm task sync --rebind` is invoked with no bundle
argument (`containers/assistant/entrypoint.sh:611`), so which bundles it
registers from is unpinned. Whichever
it is, pin it with a test — if it walks all enabled bundles, then any writer to
a writable shared bundle schedules `command` execution inside the assistant
(lesson 7). And note the latent trap: the guard is `[ -d "$tasks_dir" ]`
(`containers/assistant/entrypoint.sh:610`), so if a primary bundle ever moves
without `tasks/` being pre-created inside it, sync silently never runs and cron
gets an empty crontab.

## Why this is the last one

Adding an addon changes no existing tree and no existing service's mounts — it
is a bundle entry. AKM owns the stash layout, so its changes stay inside
`knowledge/`. Every tree has one exposure answer, so nothing needs hiding.

Only a fourth axis would force another move — multi-tenant human users, or
content that must be agent-readable and release-managed at once. Neither is on
the roadmap.
