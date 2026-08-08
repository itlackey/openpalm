# OP_HOME — Accepted Design and Final Reorganization

**Date:** 2026-08-08
**Revision reviewed:** `0374093` (main, v0.13.0-beta.23)
**Status:** decisions accepted; design approved for implementation
**Companion:**
[`op-home-structure-issues-and-lessons.md`](op-home-structure-issues-and-lessons.md)
(the evidence base; labels like *A1*, *B2*, *C3* refer to its catalog)

> This document supersedes the earlier RFC draft. The owner has answered every
> open decision (§2); §3 is the resulting target layout, §4 is the
> multi-perspective review that justifies calling it **final**, and §5 is the
> migration. `core-principles.md` is amended in the same change, under the
> direct approval that document requires.

**Standing bar:** every change must either *delete* something or cost a handful
of lines. The tooling is a thin wrapper over Docker Compose; a layout that
answers structural problems with new subsystems would be a worse fix than the
problem. Nothing below adds a subsystem, a config format, or a runtime
component.

---

## 1. The root cause

`OP_HOME` is split by three classification axes at once — **writer**,
**exposure**, **durability** — but only *exposure* is actually enforced,
implicitly, by the mount graph. When a file's name implies one axis and its
mount answers another, you get a bug: a directory named for its *kind*
(`knowledge/secrets/`) sat in a tree defined by its *exposure* (`/stash`), so
every delegated credential was agent-readable (**A1**), and the one that was
missed made admin cookies forgeable (**A2**).

**The fix is to make names and mounts agree** — not to add a subsystem that
watches them disagree. The project already has one of those
(`secret-audit.ts`, 450 lines, **A6**), and every exception has made it longer.

## 2. Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Operator-created secrets | **Split the entry points.** User-managed secrets are agent-readable by default; system-provisioned secrets default to private |
| 2 | Addon access to knowledge | **Shared.** Paperclip and any future approved addon use the shared AKM stash |
| 3 | The rename | **Adopt — and make it the last one.** Reviewed from multiple perspectives (§4); this is the final `OP_HOME` reorganization |
| 4 | Symlinked `OP_HOME` | **Support it** (canonicalize) |
| 5 | Headless host-AKM default | **Flip it** to off, matching the wizard |
| 6 | `state/` contract | **Amend the doc**; generated runtime config stays in `state/` |
| 7 | Shared tree constant | **Defer** until a tree is next added |
| 8 | `${OP_HOME:?}` + guardian `:ro` | **Adopt both** |
| 9 | Assistant's own policy tree | **Agent may write it.** Accepted, not a defect |
| 10 | Shipped skills | **System-level, release-managed** |
| 11 | `agent/` regrouping | **Parked** |
| 12 | Service data + credentials | **One restore unit** |
| 13 | Document status | **Graduate** into `docs/technical/`; amend `core-principles.md` |

Decision 2 is the one that redirected the design. The earlier draft proposed
*isolating* Paperclip with its own stash; sharing is in fact the intent. That
inverts the fix — see §3.2.

## 3. Target layout

There is **one stash**. It is `knowledge/`, exactly where it is today. The
operator chooses, per addon, whether to share it. An addon that is not given
the shared stash manages its own — that is the addon's business, not
`OP_HOME`'s.

```
~/.openpalm/
├─ system/          MANAGED (release) — overwritten wholesale, :ro where the service allows
│  ├─ stack/        core | services | portals compose files
│  ├─ skills/       ← from knowledge/skills/  (D10: shipped skills are release-managed)
│  └─ assistant/ guardian/ paperclip/
├─ config/          USER — non-secret, seeded once
├─ state/           APP — records AND generated runtime config  (D6)
├─ knowledge/       THE shared stash — mounted at /stash for the assistant, and
│                   for any addon the operator has chosen to share it with
├─ private/         DELEGATED credentials — never agent-readable  (D1)
├─ data/            SERVICE durable state; one restore unit with its credentials (D12)
├─ workspace/
└─ cache/
```

Against today, that is **two deletions and one move**:

| Change | Effect |
|---|---|
| delete `knowledge/paperclip/env`, `knowledge/paperclip/secrets` | −2 directories (`home.ts:358-359`) |
| delete the two `/stash/env` and `/stash/secrets` overmounts | −2 mounts (`services.compose.yml:58-59`) |
| move `knowledge/skills/` → `system/skills/` | shipped skills stop being user-tree content with no update channel (**B11/K7**) |

No new trees. No per-principal anything. `knowledge/`, `private/`, `config/`,
`state/`, `data/`, `workspace/`, and `cache/` keep their names and contents.

### 3.1 Sharing is one toggle

Today Paperclip mounts the whole `knowledge/` tree at `/stash`, then mounts
two more-specific paths **over** it to hide the assistant's `env/` and
`secrets/`. That is a *partial* share, and it costs a per-addon subtree, two
extra mounts, and a security property that depends on Compose honoring mount
ordering (**A8**) — while still leaving the addon able to write the `tasks/`
queue the assistant executes (**A13**).

Sharing is binary. Use the toggle pattern the stack already has for the
optional host stash (`core.compose.yml:213`) — a stack.env key flipping the
mount source between the real tree and an always-present empty directory:

```yaml
# before — a partial share: mount everything, then hide two subtrees
- ${OP_HOME}/knowledge:/stash
- ${OP_HOME}/knowledge/paperclip/secrets:/stash/secrets
- ${OP_HOME}/knowledge/paperclip/env:/stash/env

# after — shared or not, one line
- ${OP_PAPERCLIP_STASH:-${OP_HOME}/data/akm/empty-stash}:/stash
```

Shared means shared: an addon the operator has granted the stash can read and
write it, including `tasks/`. That is the operator's call to make, and it is
now legible from one line instead of inferred from three. An addon that is not
granted it gets an empty directory and manages its own stash internally.

**A13 is therefore a documentation duty, not a mount trick:** granting the
shared stash to an addon grants it the assistant's scheduler queue. The share
toggle must say so.

### 3.2 Secrets, after D1

No layout change — only the routing default inverts:

| Path | Who writes it | Agent-readable |
|---|---|---|
| `knowledge/secrets/` | operator (Secrets tab), AKM, provider auth | **yes, by design** |
| `private/secrets/` | the control plane | **never** |
| `private/env/paperclip.env` | the control plane | never (audited exception, **A9**) |

The internal secret API defaults to `private/secrets/` instead of falling
through to the agent-readable tree — the live root cause of **A2**. The admin
Secrets tab targets `knowledge/secrets/` **explicitly**, so its documented
purpose ("values the assistant can read") survives the inversion (D1).

Per D3 the ambiguity between the two `secrets/` names is worth removing:
rename the agent-readable one to `knowledge/provider-auth/`, leaving
`private/secrets/` as the only path in the layout containing the word.

### 3.3 Accepted, not fixed

- **The assistant may write its own managed config** (D9). `system/assistant`
  stays `rw` because OpenCode installs plugin `node_modules` there. Guardian's
  is `:ro` (D8) — verified safe, its entrypoint never writes to `/etc/opencode`.
- **The secret audit stays** (**A6**, **A7**). A user-editable last-wins overlay
  plus one interpolation namespace will always need a resolved-config backstop.

## 4. Why this is the final reorganization

Decision 3 asked for confidence that this is the last move. The test is what
would force the *next* one.

1. **Trust / exposure.** Each top-level tree has one exposure answer:
   `knowledge/` and `workspace/` are agent-readable, `private/` never is,
   `system/` `config/` `state/` are not mounted into an agent. No subtree
   contradicts its parent, so nothing needs a hiding trick — the single largest
   source of past moves (**A1–A5, A8**).
2. **Sharing.** Binary and per-addon, expressed as a mount source. Adding an
   addon changes no existing tree and no existing service's mounts.
3. **AKM's model.** `knowledge/` is the stash; AKM's internal layout (`env/`,
   `secrets/`, `tasks/`) is AKM's business and changes inside that tree without
   reaching the top level.
4. **Compose mechanics.** No overmounts, no ordering dependencies, no new
   single-file mounts. Every mount source is a directory under `OP_HOME`,
   pre-created operator-owned; the one source that may point outside it is
   validated (D5).
5. **Lifecycle scopes.** One durability and one writer answer per tree, so
   backup / purge / ownership-repair stay derivable from the tree list.
6. **Operator ergonomics.** The top level reads as a sentence: *system* is
   ours, *config* is yours, *state* is the app's, *knowledge* is the stash,
   *private* is off-limits, *data* is the services', *cache* is disposable.
7. **Restore units.** Data and credentials travel together (D12), so an unusual
   service is a per-service declaration, not a new tree.
8. **Migration cost.** Two deletions and one move, all within `OP_HOME`.

**What would still force a move:** a genuine fourth axis — multi-tenant *human*
users each needing separate knowledge, or content that must be agent-readable
and release-managed at once. Neither is on the roadmap.

## 5. Change list and migration

**Phase 1 — no file moves.**
- `${OP_HOME:?}` on every managed-compose mount and secret source (D8, **C10**)
- guardian `system/guardian:/etc/opencode:ro` (D8, **A14**)
- `realpath()` `OP_HOME` once at resolution (D4, **F7**)
- validate + pre-create `OP_HOST_AKM_STASH`; flip the headless default to off
  (D5, **C14**)
- amend the `state/` contract in the docs (D6, **B3**)

**Phase 2 — secret routing (no moves).** Invert the internal default to
`private/secrets/`; point the admin Secrets tab explicitly at the
agent-readable tree (D1, **A2**).

**Phase 3 — the reorganization.** One schema-gated migration:
1. `knowledge/skills/` → `system/skills/` (D10)
2. rename the agent-readable secrets dir → `knowledge/provider-auth/` (D3)
3. replace Paperclip's three stash mounts with the single share toggle; delete
   `knowledge/paperclip/` and its two `ensureHomeDirs` entries (§3.1)
4. document that granting the shared stash grants the scheduler queue

**Phase 4 — backup coherence.** Implement the one-restore-unit rule (D12,
**G5**).

Migration discipline, per the project's own pattern: full backup first and
abort on backup failure; copy → read back and verify → only then delete; leave
both and warn on conflict; version-gated and idempotent; and sweep every doc
and UI string naming an old path **in the same change** (the **A1** relapse).
`custom.compose.yml` may reference moved paths, so the release notes must call
the move out (**G2**: user overlays are public API).

**Deferred:** the shared tree constant (D7). **Parked:** an `agent/` parent for
the exposed trees (D11).
