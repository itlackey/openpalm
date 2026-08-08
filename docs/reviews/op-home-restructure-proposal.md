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
reinterpret them.** Any layout question about stash contents is answered by
AKM's model, not by a new OpenPalm convention.

AKM ≥ 0.9.0 models multiple stashes as **bundles** — a named map of
`{path, writable, enabled}` (`akm-sources.ts`). That is already how the
optional personal stash works: the mount at `/host-stash` is always present,
and the `host-akm` bundle entry decides whether it is used and whether it is
writable. Everything below uses that mechanism rather than inventing one.

## Layout changes

| Change | Effect |
|---|---|
| delete `knowledge/paperclip/{env,secrets}` | −2 dirs (`home.ts:360-361`) |
| delete the `/stash/env` + `/stash/secrets` overmounts | −2 mounts (`services.compose.yml:58-59`) |
| `private/` → `state/` | credentials to `state/secrets/`, audited env file to `state/env/`; 8 top-level trees → 7 |

`knowledge/` keeps every AKM asset directory it has, including `skills/`.

`private/` earned its own tree only by carrying an absolute *never
bind-mounted* rule. `state/` already can't hold that line — `state/remote/` is
a mount source — so the rule is subpath-scoped either way: **nothing under
`state/secrets/` or `state/env/` is ever bind-mounted; services receive
individual files as Compose secrets.** Merging drops a tree, and drops the
lifecycle-scope entry that was missed when `private/` was introduced (**G7**).
Delegated credentials are not AKM assets, so this tree is OpenPalm's to define.

## Sharing and release content are bundles

Paperclip's three stash mounts (parent + two overmounts to hide `env/` and
`secrets/`) are replaced by a bundle entry. The operator's choice to share is
`enabled`; whether the addon may write back is `writable`. Same shape as
`host-akm`, no new mechanism, no partial-share overmounting (**A8**).

Release-shipped skills (**B11/K7**) are the same answer: ship them as a
**read-only bundle** (`writable: false`) so they update with the release
without competing with the operator's own stash content. They do not move out
of the stash, and `knowledge/skills/` remains the operator's own skills
directory.

## Code changes

| | Change | Cost |
|---|---|---|
| 1 | Secret routing defaults to `state/secrets/`; Secrets tab targets the agent-readable dir explicitly | 1 line + allowlist (**A2**) |
| 2 | `${OP_HOME:?}` on mount and secret sources | find/replace (**C10**) |
| 3 | `system/guardian:/etc/opencode:ro` — verified it never writes there | 1 word (**A14**) |
| 4 | `realpath()` `OP_HOME` once | 1 line (**F7**) |
| 5 | Validate + pre-create `OP_HOST_AKM_STASH`; headless default off | few lines (**C14**) |
| 6 | Backup takes a service's data and credentials together, or neither | (**G5**) |
| 7 | `state/` documented as records **and** generated runtime config | doc (**B3**) |

## Accepted as-is

- Assistant writes its own `system/assistant` — OpenCode installs plugins there.
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

## Why this is the last one

Adding an addon changes no existing tree and no existing service's mounts — it
is a bundle entry. AKM owns the stash layout, so its changes stay inside
`knowledge/`. Every tree has one exposure answer, so nothing needs hiding.

Only a fourth axis would force another move — multi-tenant human users, or
content that must be agent-readable and release-managed at once. Neither is on
the roadmap.
