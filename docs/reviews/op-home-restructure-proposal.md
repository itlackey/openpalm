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

```
~/.openpalm/
├─ system/          MANAGED (release) — overwritten wholesale, mounted :ro
│  ├─ stack/        core | services | portals compose files
│  ├─ skills/       ← from knowledge/skills/  (D10)
│  └─ assistant/ guardian/ paperclip/     OPENCODE_CONFIG_DIR content
├─ config/          USER — non-secret, seeded once, never overwritten
│  ├─ stack/custom.compose.yml
│  └─ akm/ assistant/ guardian/ paperclip/
├─ state/           APP — records AND generated runtime config  (D6)
│  ├─ stack.env  schema-version  host-identity.json
│  └─ remote/     generated tunnel serve config
├─ knowledge/       SHARED AKM stash — a named secondary source for every
│                   approved participant; rw  (D2)
├─ stash/           PER-PRINCIPAL AKM stash roots — each mounted at /stash
│  ├─ assistant/    env/  secrets/  tasks/
│  └─ paperclip/    env/  secrets/
├─ private/         DELEGATED credentials — never agent-readable  (D1)
│  ├─ secrets/
│  └─ env/paperclip.env
├─ data/            SERVICE durable state; restore unit with its credentials (D12)
├─ workspace/       shared work area
└─ cache/           regenerable
```

### 3.1 What moves

| From | To | Why |
|---|---|---|
| `knowledge/env/user.env` | `stash/assistant/env/user.env` | per-principal, not shared |
| `knowledge/secrets/auth.json` | `stash/assistant/secrets/auth.json` | per-principal provider auth |
| `knowledge/tasks/` | `stash/assistant/tasks/` | execution queue — single writer (**A13**) |
| `knowledge/skills/` | `system/skills/` | release-managed system content (D10, closes **B11/K7**) |
| `knowledge/paperclip/env`,`/secrets` | `stash/paperclip/…` | per-principal, no longer an overlay |
| everything else in `knowledge/` | stays | this *is* the shared stash |

`private/secrets/` is unchanged. `config/`, `data/`, `workspace/`, `cache/`,
and `state/` are unchanged except that `state/`'s documented contract now
admits generated runtime config (D6).

### 3.2 The inversion that replaces the overmount trick

Today Paperclip mounts the whole `knowledge/` tree at `/stash`, then mounts
`knowledge/paperclip/secrets` and `knowledge/paperclip/env` **over**
`/stash/secrets` and `/stash/env` to hide the assistant's provider auth and
`user.env`. Isolation depends on Compose honoring mount declaration order
(**A8**), and Paperclip retains write access to everything else in
`knowledge/` — including the `tasks/` queue the assistant executes every 60
seconds (**A13**).

Because sharing is the intent (D2), the answer is not separation — it is to
**invert which tree is the mount root**:

```yaml
# before — subtractive: mount everything, then hide the private parts
- ${OP_HOME}/knowledge:/stash
- ${OP_HOME}/knowledge/paperclip/secrets:/stash/secrets
- ${OP_HOME}/knowledge/paperclip/env:/stash/env

# after — additive: mount only what is mine, then add what is shared
- ${OP_HOME}/stash/paperclip:/stash          # primary AKM stash
- ${OP_HOME}/knowledge:/knowledge            # shared, a named secondary source
```

This uses AKM's **existing** multi-source mechanism — `config.sources[]`, the
same feature that already backs `/host-stash`
(`akm-sources.ts`, `HOST_SOURCE_NAME`) — so it adds nothing. What it removes:

- the overmount ordering dependency (**A8**) — nothing is hidden, so nothing
  can be un-hidden by a reordering or a user overlay;
- every addon's write path into the assistant's cron queue (**A13**) —
  `tasks/` is per-principal;
- the subtractive-trust reasoning itself: sharing becomes a grant you can read
  off one mount line, rather than an absence you have to infer from three.

Adding a future addon becomes: create `stash/<addon>/`, mount it at `/stash`,
and grant `/knowledge` if it is approved to share. That is the whole procedure.

### 3.3 Secrets, after D1

Three locations, each with one meaning, disambiguated by the **top-level tree**
rather than by the leaf name:

| Path | Who writes it | Agent-readable |
|---|---|---|
| `stash/<principal>/secrets/` | operator (Secrets tab), AKM | **yes, by design** |
| `private/secrets/` | the control plane | **never** |
| `private/env/paperclip.env` | the control plane | never (audited exception, **A9**) |

The internal secret API defaults to `private/secrets/` — inverting today's
fallthrough, which silently publishes an unclassified secret to the agent and
is the live root cause of **A2**. The admin Secrets tab targets
`stash/<principal>/secrets/` **explicitly**, so its documented purpose ("values
the assistant can read") is preserved rather than broken by the inversion.
`secrets/` and `env/` keep AKM's own names *inside* a stash, because that is
AKM's contract; the trust meaning is carried by `stash/` vs `private/`.

### 3.4 Restore units (D12)

A service's durable data and the credentials that unlock it are **one unit**.
The safety backup must not take one without the other: for any service whose
`data/` subtree is excluded, its credentials are excluded from that snapshot
too, and the backup names what it skipped and points at the per-service
runbook. This closes the **G5** trap — a restore that produced a working login
against an empty database — without pulling multi-gigabyte service data into
every lifecycle snapshot.

### 3.5 Accepted, not fixed

- **The assistant may write its own managed config** (D9). `system/assistant`
  stays `rw` because OpenCode installs plugin `node_modules` there. Guardian's
  is mounted `:ro` (D8), verified safe — its entrypoint never writes to
  `/etc/opencode`.
- **The secret audit stays** (**A6**, **A7**). A user-editable last-wins
  overlay plus one interpolation namespace will always need a resolved-config
  backstop. This design reduces what it must carry; it does not replace it.

## 4. Why this is the final reorganization

Decision 3 asked for confidence that this is the last time. The layout was
reviewed from eight perspectives; each asks what would force the *next* move.

1. **Trust / exposure.** Every top-level tree now has exactly one exposure
   answer: `stash/` and `knowledge/` are agent-readable, `private/` never is,
   `system/` `config/` `state/` are not mounted into an agent. No subtree
   contradicts its parent, so no future file needs a hiding trick. This was the
   single largest source of past moves (**A1–A5, A8**).
2. **AKM's model.** `/stash` is the primary source, `/knowledge` a named
   secondary — both first-class AKM concepts already in use. A future AKM
   layout change inside a stash (`env/`, `secrets/`, `tasks/`) is absorbed
   *within* `stash/<principal>/` and never reaches the top level.
3. **Compose mechanics.** No overmounts, no ordering dependencies, no
   single-file mounts introduced. Every mount source is a directory under
   `OP_HOME`, pre-created operator-owned. The one source that can point outside
   (`OP_HOST_AKM_STASH`) is validated and pre-created (D5).
4. **Lifecycle scopes.** Each tree keeps one durability and one writer answer,
   so backup / purge / ownership-repair / rollback stay derivable from the tree
   list rather than from per-file exceptions.
5. **The Nth agent.** Adding an addon is `stash/<addon>/` plus an optional
   `/knowledge` grant — additive, with no change to any existing service's
   mounts. This is the property the current layout lacks, and the reason
   Paperclip's arrival forced an overlay scheme.
6. **Operator ergonomics.** The top level reads as a sentence: *system* is
   ours, *config* is yours, *state* is the app's, *stash* is each agent's,
   *knowledge* is shared, *private* is off-limits, *data* is the services',
   *cache* is disposable. Nothing needs a warning label to be used safely.
7. **Restore units.** Data and credentials travel together (D12), so a service
   with unusual durability needs is a per-service declaration, not a new tree.
8. **Migration cost.** Every move is within `OP_HOME` and mechanical, and the
   project has a proven one-shot gate for exactly this.

**What would still force a move:** a genuine fourth axis — for example
multi-tenant *human* users each needing separate knowledge, or a service that
must be agent-readable and release-managed at once. Neither is on the roadmap.
Absent that, this layout absorbs new services and new AKM internals without a
top-level change, which is what "final" means here.

## 5. Change list and migration

Ordered so the cheapest, riskless items land first.

**Phase 1 — no file moves.**
- `${OP_HOME:?}` on every managed-compose mount and secret source (D8, **C10**)
- guardian `system/guardian:/etc/opencode:ro` (D8, **A14**)
- `realpath()` `OP_HOME` once at resolution (D4, **F7**)
- validate + pre-create `OP_HOST_AKM_STASH`; flip the headless default to off
  (D5, **C14**)
- amend the `state/` contract in the docs (D6, **B3**)

**Phase 2 — secret routing (no moves).**
- invert the internal default to `private/secrets/`; point the admin Secrets
  tab explicitly at `stash/<principal>/secrets/` (D1, **A2**)

**Phase 3 — the reorganization.** One schema-gated migration, in this order:
1. `knowledge/skills/` → `system/skills/` (D10)
2. `knowledge/{env,secrets,tasks}/` → `stash/assistant/…`
3. `knowledge/paperclip/{env,secrets}/` → `stash/paperclip/…`
4. rewrite the compose mounts to the additive form (§3.2)
5. register `knowledge/` as a named AKM secondary source for each participant

**Phase 4 — backup coherence.** Implement the one-restore-unit rule (D12,
**G5**).

Migration discipline, per the project's own hard-won pattern: full backup
first and abort on backup failure; copy → read back and verify → only then
delete; leave both and warn on conflict; version-gated and idempotent; and
sweep every doc and UI string naming an old path **in the same change** — the
**A1** relapse, where the Connections page kept naming a moved path for a
release, is the failure to avoid. `custom.compose.yml` may reference moved
paths, so the release notes must call the move out (**G2**: user overlays are
public API).

**Deferred:** the shared tree constant (D7) lands when a tree is next added.
**Parked:** regrouping the exposed trees under an `agent/` parent (D11) — this
design makes exposure legible without it.
