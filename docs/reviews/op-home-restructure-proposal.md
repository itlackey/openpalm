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

## Layout changes

| Change | Effect |
|---|---|
| delete `knowledge/paperclip/{env,secrets}` | −2 dirs (`home.ts:358-359`) |
| delete the `/stash/env` + `/stash/secrets` overmounts | −2 mounts (`services.compose.yml:58-59`) |
| `knowledge/skills/` → `system/skills/` | shipped skills get an update channel (**B11**) |
| rename `knowledge/secrets/` → `knowledge/provider-auth/` | only `private/secrets/` says "secrets" (**A5**) |

Everything else keeps its name and contents. `knowledge/` is the one stash.

## Sharing

The stack already expresses optional grants as overlay files gated on a
stack.env key and picked up by `discoverStackOverlays` on every compose
invocation — that is what `voice.compose.lan.yml` is. Stash sharing is the same
shape:

```yaml
# paperclip.compose.stash.yml — included only when the operator turns it on
services:
  paperclip:
    volumes:
      - ${OP_HOME}/knowledge:/stash
```

The base `services.compose.yml` drops all three stash mounts. Shared means
shared: the addon gets the stash, task files included, and a container that
syncs tasks runs them.

## Code changes

| | Change | Cost |
|---|---|---|
| 1 | Secret routing defaults to `private/secrets/`; Secrets tab targets the agent-readable dir explicitly | 1 line + allowlist (**A2**) |
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
4. Backup coherence (6).

Migration discipline: backup first and abort on failure; copy → verify → then
delete; leave both on conflict; version-gated; sweep every doc and UI string
naming an old path in the same change (**A1**). `custom.compose.yml` may
reference moved paths — call it out in the release notes (**G2**).

## Why this is the last one

Adding an addon changes no existing tree and no existing service's mounts:
create nothing, flip one toggle. AKM's internals stay inside `knowledge/`.
Every tree has one exposure answer, so nothing needs hiding.

Only a fourth axis would force another move — multi-tenant human users, or
content that must be agent-readable and release-managed at once. Neither is on
the roadmap.
