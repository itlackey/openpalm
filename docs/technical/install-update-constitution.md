# Install & Update — Constitution

> **Status: authoritative spec.** This document defines what install and update
> *are*, derived from purpose — not from the current implementation. Where the
> code disagrees with this document, the code is wrong. All install/update work
> MUST comply. It sits under [`core-principles.md`](core-principles.md); where
> they overlap, the stricter simplicity wins.

---

## 0. Purpose

OpenPalm is a **thin manager over a folder of text files and a `docker compose`
stack** on a non-technical user's machine. Install and update exist only to keep
those two things — the files and the stack — in a known-good state. Nothing else
is justified.

- **Install** turns a machine with nothing into a working system: the managed
  files written to `OP_HOME`, the few user-supplied values collected, and the
  stack running.
- **Update** moves an already-installed system to a newer release without
  touching the user's data or edits.

**Install and update are the same operation.** Both: write the managed files,
then make the running stack match them. Install is the first run; update is
every run after. They MUST share one code path — not two elaborate flows.

---

## 1. The one rule everything else follows: ownership by top-level tree

Every path under `OP_HOME` belongs to exactly one top-level tree, and the tree —
**not** inspection, not "is it in the skeleton" — decides who owns it and what
install/update may do to it:

| Tree | Class | Owner | Install/update write policy |
|---|---|---|---|
| `config/` (except `config/stack`), `knowledge/`, `workspace/` | **User** | the user | **Seeded once** on first install (create-if-missing), then **never touched** — never overwritten, merged, or drift-checked |
| `system/` (was `config/stack`) — compose stack, system OpenCode config, **built-in** skills/tasks, tool manifests, shipped defaults | **Managed** | OpenPalm | **Overwritten wholesale** every install/update — it *is* the skeleton |
| `data/` — service runtime: dbs, logs, caches, the OpenCode HOME + **plugin installs** | **Runtime** | services | **Never written** by install/update (directories are ensured to exist; contents are service-generated) |
| `state/` — pins, enabled add-ons, channel, setup record | **State** | the app | App actions only; **never** overwritten by the file copy |

Rules that follow:

1. **Write policy is a property of the destination tree.** `system/` → overwrite.
   User trees → seed-once. `data/`/`state/` → never written by the copy. A reader
   (or the code) knows the policy from the path alone (constitution's old "by
   location" rule, made precise).
2. **The release ships two kinds of file:** the **overwrite set** (everything in
   `system/`) and **seed-once defaults** for the user trees. "Ships in the
   skeleton" no longer implies "overwrite" — the destination tree does.
3. **No path may mix classes.** A file that is half shipped-default and half
   user/state (today's `config/stack/stack.env` mixing defaults + pins + addons)
   **must be split** — the managed part to `system/`, the state part to `state/`.
4. **Managed assets never live in a user tree, and runtime data never lives in a
   managed tree.** This is why `config/stack` (managed) moves out of the
   user-owned `config/` into `system/`, and why built-in skills move out of the
   user-owned `knowledge/` into `system/` — while a user's *own* skills stay in
   `knowledge/`.

This is the whole point: clean trees delete drift detection, version-stamped
seeding, layout migrations, and "non-destructive reconcile" — those exist only to
cope with managed and user content tangled in the same directory.

> **`config/stack` → `system/` (consolidation).** Today the managed compose stack
> sits inside the user-owned `config/` tree, which is exactly the kind of mixing
> this rule forbids. Moving it (and the other managed assets) under a single
> top-level **`system/`** tree makes "overwrite the managed tree" a one-line,
> unambiguous operation and keeps `config/` purely user-owned.

---

## 2. What an installed system is made of

1. **Managed assets** (`system/`) — the compose stack, the *system* OpenCode
   config (plugin list, permissions), built-in skills/tasks, tool manifests,
   shipped defaults. Versioned with the release; overwritten wholesale.
2. **User files** (`config/`, `knowledge/`, `workspace/`) — the user's editable
   config (incl. their OpenCode `opencode.json`, persona, instructions), their own
   skills/tasks, secrets, compose overlay, knowledge. Seeded once, then theirs.
3. **Runtime data** (`data/`) — service-generated: dbs, logs, caches, and the
   OpenCode HOME including **plugin `node_modules`**. Never written by the copy.
4. **State** (`state/`) — pins, enabled add-ons, channel, setup record. App-written.
5. **The running stack** — containers brought up by `docker compose` from the
   managed compose files + user/state values.

> **Worked example — the OpenCode config split (verified against OpenCode 1.17.4).**
> OpenCode follows XDG (separate config / data / cache dirs) and **merges multiple
> config sources**, but it installs plugin `node_modules` *into the config dir* —
> which is why `config/assistant` is polluted today. The split that honors the
> ownership rule, confirmed by spike:
> - **System config → `system/` (managed):** the project config dir
>   (`OPENCODE_CONFIG_DIR`) holds the plugin list + permissions; plugin installs
>   land under `data/` (the XDG data/config dir under the container HOME).
> - **User config → `config/assistant/opencode.json` (user):** loaded as a single
>   file via `OPENCODE_CONFIG`, which merges as an override **without** installing
>   `node_modules` next to it — so `config/assistant` stays clean and editable.
> - Disjoint by design (system = plugins/permissions, user = model/provider), so
>   both apply; the same wiring serves the guardian's OpenCode.
5. **The control plane** — the UI build + the skeleton + the CLI / desktop shell
   that perform install and update. The **UI build and the skeleton are npm
   packages, hot-swapped at runtime.** The desktop shell ships a bundled *default*
   copy of each so it works on first launch and offline — but at runtime both are
   replaced from their npm packages, and the **running npm versions are what
   count**; the bundled copies are only the seed of last resort. The running
   build's embedded version *is* the system's version and carries that release's
   managed files + image references. So a control-plane update hot-swaps the UI
   build **and** the skeleton together from npm — the cascade is immediate, and the
   skeleton is **never** frozen at the shell's version. The one thing that
   genuinely cannot hot-swap is the **native shell itself**: if a new build needs
   native-host capabilities the installed shell lacks (a harness-contract bump), it
   MUST prompt a full app re-download rather than self-apply (§4.4).

---

## 3. Install

Given a machine with nothing (or a partial setup), install MUST:

1. Create the `OP_HOME` directory layout (incl. empty `data/` service dirs).
2. **Overwrite the managed tree** (`system/`) from the release.
3. **Seed the user trees once** — write the release's default `config/`,
   `knowledge/`, `workspace/` files only where absent; never over an existing one.
4. Collect the few values only the user can supply (provider/credentials, a
   password) and write them into **user/state files** — never into `system/`.
5. Bring the stack up (`docker compose up`).

Install MUST NOT: overwrite a pre-existing user/state file; require steps that
aren't one of the above; gate on anything beyond what's needed to write files and
start containers.

---

## 4. Update

Exactly **three** things can be newer in a release. Update applies each, and the
user MUST be able to do them **individually** — not only all-at-once:

1. **A container image** → pull the new image, recreate that one container.
2. **The control plane** (UI build / CLI) → swap in the new build and restart so
   the new code is running. It MUST take effect **on its own** — the user does not
   click an "apply" button to activate a downloaded update.
3. **The managed files** → rewrite them from the new release's skeleton
   (overwrite). User/state files are not touched.

Because the control plane carries the new release's managed files and image
references, updating it cascades naturally: new control plane → rewrite managed
files → pull → recreate. The simple default — "update to latest" — needs no
version arithmetic: `docker compose pull` + recreate. There is **no reconcile
phase.** Version *numbers* are resolved (from the registry) only to power the
pinning controls and the "a newer version is available" indicator — never as a
mandatory gate the update has to pass through.

Two safety rules on "track latest":
- **Never auto-cross a major version.** If the newest build/image on the tracked
  channel is a different *major* than what's installed, the automatic update stops
  and tells the user a major update needs a deliberate step. Same-major moves
  freely.
- **Registry-down is handled by who asked.** A background "is there an update?"
  check that can't reach the registry is non-fatal — the system keeps running what
  it has. A *user-pressed* "update now" that can't reach the registry **fails
  loudly** (§6). (LAN-first means the registry is sometimes unreachable; that is
  normal, not an error to hide.)

A user MUST be able to:
- Update the UI alone.
- Update one container alone.
- Update everything.

…all as plain actions, **without ever opening a raw-text-box editor.** The exact
Docker and registry mechanics that make these correct (and stop the stale-cache
"success" that bricks updates today) are §4.3 and §4.4 — they are part of this
constitution, not implementation detail.

### 4.1 Ceremony is proportional to cost and risk

How much an action announces itself MUST match how long and how dangerous it is.

- **Trivial change** (flip a pin, edit one line of a managed/state file): apply it
  immediately, inline, with at most a small confirmation. **Never** a full-screen
  splash or a separate "apply" gate. A splash to change one line in a text file is
  absurd.
- **Long or risky operation** (recreating the stack, pulling large images, a
  control-plane swap + restart, a one-time data move): a splash / progress screen
  is **correct and wanted** — it shows progress, says what's happening, and keeps
  the user from thinking it hung. This is the *good* use of a splash.

The wrong thing is not "splash screens." The wrong thing is ceremony out of
proportion to the work.

### 4.2 Versions and pinning (first-class)

Pinning is a **core feature**, not an escape hatch. It exists for power users and
for locked production environments that must not move unexpectedly.

- **Default: track latest.** A component with no pin updates to the newest
  available image/build when the user updates.
- **Pinned: locked.** A user may pin any component to an exact version. A pinned
  component does **not** auto-update; it stays put until the user changes the pin.
- **Pins are user/state, not managed.** A pin records a user choice, so it lives
  in a user/state file — outside the skeleton, never overwritten by an update
  (§1). Pinning a production box and then updating MUST preserve the pins.
- **Presented as a clean control**, not a grid of raw version text boxes. Showing
  the available versions to choose from is part of this — the user picks, they
  don't hand-type tags (though typing an exact tag MAY be allowed for experts).
- **A user picks a *version*, never a hardware variant.** Some images (voice)
  publish per-hardware tags (`<version>-cpu`, `<version>-cu121`, `<version>-rocm6`).
  The variant is decided by the active profile; the suffix is appended
  automatically. The pinning control shows plain versions, never `-cpu` vs `-cu121`.
- **The channel (stable vs prerelease) is a pin too.** It defaults to the running
  build's stream (stable build → `latest`, prerelease build → `next`). A user MAY
  set an explicit channel preference (e.g. opt a stable box onto prereleases for
  testing). Like every pin, it is state and survives updates.

**Concrete consequence for today's files:** the per-image pins (`OP_*_VERSION`),
the channel preference, and the enabled-addon list (`OP_ENABLED_ADDONS`) are
**state**. They MUST live in a state env-file that update never overwrites — split
out from any shipped-default env config. (Compose reads several `--env-file`s in
order; the state file simply comes last.) This is the §1.3 split made concrete:
`stack.env` today mixes shipped defaults with this state and so must be divided.

### 4.3 How update maps to `docker compose` (binding mechanics)

These are not implementation trivia — getting them wrong is exactly why "pull
doesn't work" today. The spec REQUIRES:

- **Pull before recreate, always.** `docker compose up` only pulls an image that
  is *missing locally*; a stale local `:latest` is silently reused and reported as
  success. So update is `compose pull` **then** `compose up -d`. Never `up` alone.
- **One container** = `compose pull <svc>` then `compose up -d --force-recreate
  --no-deps <svc>`. `--no-deps` keeps it scoped to that one service.
- **Everything** = `compose pull` then `compose up -d --remove-orphans`.
  `--remove-orphans` is required so that a release which *drops* a service (or a
  newly-disabled addon) doesn't leave its old container running — "make the stack
  match the files" includes removing what the files no longer define.
- **Profiles are passed on every command.** Services behind an inactive profile
  (voice/ollama variants) are intentionally invisible — not errors, not "pending."
- **Success = running *and* healthy.** `compose up` returns when containers are
  *started*, not ready. For a service that defines a healthcheck, success is only
  declared once `State.Health.Status` is healthy. Returning ≠ success.
- **Pull the whole target set first.** Compose recreates services one at a time
  with no rollback; pulling all target images up front means a bad/missing image
  fails *before* anything is recreated, so the running stack is never left
  half-swapped.

### 4.4 How the control plane updates itself (binding mechanics)

- **What hot-swaps: the UI build *and* the skeleton.** Both are npm packages
  fetched at runtime. The desktop shell ships a bundled default of each (so first
  launch and offline work); at runtime the npm copy replaces it and is what runs.
  A control-plane update swaps both together — the same resolve/verify/stamp/swap
  steps below apply to each.
- **Resolve, then stamp.** A channel (`latest`/`next`) resolves to an exact
  version; that exact version is **stamped into the installed copy** before the
  swap counts as done. The stamp is the source of truth for §5 (what's running)
  and §6 (what to roll back to).
- **Verify before swap, fail closed.** A downloaded build is integrity-checked
  against the registry-provided hash before it is installed. A missing or wrong
  hash **fails the update** — never a warning, never installed anyway.
- **Swap is atomic; restart needs a supervisor.** The new build is staged then
  renamed into place (atomic on the filesystem); the prior build is kept as an
  on-disk backup. A running Node process cannot re-exec itself from new files, so
  a **defined supervisor** (the desktop harness, the CLI watchdog) detects the
  completed swap and re-spawns the server. Every deployment mode MUST have such a
  supervisor; a build with no restart mechanism is not a supported configuration.
  This restart is automatic — the user never clicks "apply" to activate it.
- **Native-capability gate.** If the new build needs a newer native host than is
  installed (harness-contract bump), it MUST NOT self-apply — it tells the user a
  full app re-download is required. This is the *only* legitimate "can't auto-apply"
  case, and it is about native capability, not about re-seeding files.

---

## 5. Truthful state

The UI MUST show **what is actually running**, never what a config file *intends*.

- "Current" for a container is read from Docker — the image the **running
  container was created from** (`inspect` the resolved image **digest**, with the
  human tag shown alongside). Never the pin in an env file.
- **Tags are not enough.** Two containers on `:latest` can be different builds; a
  tag string can't tell you which. "Up to date" for a latest-tracking component
  means the running **digest** equals what its tag resolves to in the registry —
  not a tag-string match.
- **Stopped or absent is stated, not guessed.** A stopped container shows its
  created-from image as "current (stopped)". When no container exists, current is
  "not installed" — never inferred from a pin.
- "Up to date" may be shown **only** after the running reality matches the target.
  If a config says one thing and the running stack says another, the UI shows the
  running truth and that an update is pending — it never reports success against
  its own intent.

---

## 6. Failure is loud and located

- A failed image pull or failed recreate is an **error**, surfaced immediately —
  never swallowed, never downgraded to "restarted from local cache" presented as
  success. If the target image cannot be obtained, the update **fails** and says so.
- **Registry failures are named, not generic.** Rate limit, auth (`pull access
  denied`), unknown tag/`manifest unknown`, and network are reported with their
  specific cause and the offending `image:tag` — "pull failed" alone is not
  acceptable (these are the most common real failures for a non-technical user).
- Errors are shown **on the screen that triggered the action**, in context — not
  routed to an unrelated view.
- A failed update leaves the system in its **previous working state**, not
  half-applied. Recovery is simple because everything is versioned content, not a
  bespoke rollback engine:
  - *Compose/config files* → copy the prior release's skeleton again.
  - *The UI build* → re-instate the on-disk backup kept before the swap (a local
    rename; no registry needed).
  - *Images* → the prior **pinned** tags must still exist in the registry; this is
    why immutable per-version tags matter and `:latest`-only history can't roll back.

---

## 7. UX principles

- **One obvious place** to manage versions/updates. Not update buttons scattered
  across multiple screens.
- **Granular by default, simple controls**: "Update UI", "Update <container>",
  "Update everything" as buttons — never a grid of version text boxes as the
  primary interface.
- **Automatic where it can be**: the UI updates and restarts itself; the user is
  informed, not enlisted as the mechanism.
- **Version pinning is first-class** (§4.2), not a hidden escape hatch — power
  users and locked production environments depend on it. The normal user never
  *needs* it (default tracks latest), but it is a real, supported control,
  presented cleanly — never a grid of raw version text boxes.

---

## 8. Explicitly forbidden (the rot this replaces)

The following exist today and MUST be removed; none of them serve the purpose:

- Seed-if-missing / "non-destructive" reconcile of managed files. *(Managed files
  are overwritten; user files aren't in the skeleton.)*
- Drift detection, version stamps used to decide whether to re-seed, and the
  layout/release **migration framework**. *(Clean ownership makes them moot.)*
- A **mandatory blocking gate the user must click through** before a change takes
  effect. *(Resolving the registry version to show "newer available", to compare
  against the installed stamp, or to feed the pinning controls is NOT a gate and is
  required — §4.2/§4.4. The simple "update to latest" path needs no version math.)*
- The **raw-text-box** version editor as the pinning interface. *(Pinning stays —
  §4.2 — but as a clean control.)*
- A **splash / "apply" gate on a trivial change** (flipping a pin, a one-line
  edit). *(A splash/progress screen for a genuinely long or risky operation is
  correct — §4.1.)*
- Reporting "current" from env-file pins instead of the running container; and
  judging "up to date" by **tag-string equality instead of resolved digest** (§5).
- Swallowing pull/recreate failures and presenting them as success; in particular
  `up` **without a preceding `pull`** (it reuses a stale local image — §4.3).
- Pinning the **skeleton inside a separately-versioned native shell** so a
  control-plane update can't carry the new managed files (§2).
- Two divergent code paths for install vs update.

---

## 9. Litmus test

Before adding anything to install or update, it must pass:

1. Does this help write the managed files or make the stack match them? If not, it
   doesn't belong.
2. Could a non-technical user trigger it as one obvious action?
3. Does it keep managed and user files cleanly separated?
4. Does it tell the truth about what's actually running, and fail loudly when it
   can't?

If any answer is "no", it is complexity that is not justified — and per
`core-principles.md`, it must be removed, not shipped.
