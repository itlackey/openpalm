# OP_HOME Structure — Issues Encountered and Lessons Learned

**Date:** 2026-08-08
**Revision reviewed:** `0374093` (main, v0.13.0-beta.23)
**Scope:** every issue this project has encountered around the `OP_HOME`
directory layout, Docker bind mounts, host↔container path mapping, and the
protection of private data, secrets, and env files — with the root cause and
the lesson each one encodes.
**Method:** the current tree, compose files, entrypoints, and control-plane
code were read at source; the full CHANGELOG (1,500 lines back to 0.9.0-rc2),
the visible git history, the migration ledger (`home-schema.ts`), and GitHub
issues/PRs were swept for layout-related fixes. Every issue cites the evidence
that proves it happened (file:line, commit, changelog entry, or the migration
that exists because of it). Where a comment in the code records the incident
directly, that comment is the citation. One caveat: the repository's git
history is grafted (~2 weeks of commits are inspectable); older incidents are
cited from the changelog and from the code the fixes left behind.

This document is the evidence base for the companion proposal,
[`op-home-restructure-proposal.md`](op-home-restructure-proposal.md).

---

## 1. The layout under review, and how it got here

`OP_HOME` (default `~/.openpalm`) is split into eight top-level trees —
`config/`, `system/`, `state/`, `knowledge/`, `data/`, `workspace/`,
`private/`, `cache/` — documented in
[`../technical/environment-and-mounts.md`](../technical/environment-and-mounts.md)
and constitutionally defined in
[`../technical/core-principles.md`](../technical/core-principles.md). Each tree
answers a different question: *who writes it* (`config/` user, `system/`
release, `state/` app, `data/` services), *who may read it* (`knowledge/` is
agent-visible, `private/` is not), or *how durable it is* (`cache/` is
disposable). That is three classification axes competing for one top level —
and most of the issues below are cases where a file's answer on one axis
contradicted the tree it lived in on another.

The layout has been reorganized in every minor release line:

| Era | Layout event | Evidence |
|---|---|---|
| 0.9.0-rc2 | XDG-style model; admin ran as a *container* behind a `docker-socket-proxy` "to eliminate socket permission and GID issues across Docker Desktop, OrbStack, Colima, and Podman" | CHANGELOG.md:1446-1453 |
| 0.10.x | `vault/` tree holds credentials; akm `vault:user` storage | `docs/operations/upgrade-0.10-to-0.11.md` |
| 0.11.0-beta.11 | Secrets moved **into** the stash (`stash/vaults/secrets/`) — i.e. *into* the agent-readable tree — to get them out of the stack-config tree | CHANGELOG.md:1104-1109 |
| 0.11.0 | Breaking reorg: `config/stack/stack.env` → `knowledge/env/stack.env`, `config/stack/auth.json` → `knowledge/secrets/auth.json`, vaults → `env/`+`secrets/`; copy-only backup-first migration gated by `OP_LAYOUT_VERSION`; admin container, socket proxy, and Caddy all deleted — the admin plane became a host process | CHANGELOG.md:981-1057, 1024-1027 |
| 0.12.0 | `channels` → `portals` rename (secret filenames, a Docker network, user overlays); one global `OP_BIND_ADDRESS` | CHANGELOG.md:769-785, 791-792 |
| 0.13.0 | Single `state/stack.env`; delegated secrets → `private/secrets/` (G1); `cache/` split out as a sibling of `data/`; `state/schema-version` migration gate; flat per-service access toggles with stored intent | CHANGELOG.md:193-206; `home-schema.ts` |

Three of those moves are course reversals (secrets into the stash, then out;
per-service binds to global, then back). The catalog below is why.

## 2. Issue catalog

Issues are grouped by root-cause family, labeled A–G. **RC** marks the root
cause; **Lesson** the generalization.

### A. Trust boundaries were policed, not structural

The single most expensive family. `knowledge/` is bind-mounted wholesale into
the assistant at `/stash` and is `external_directory "/stash/*"`-reachable by
the agent's own bash tool — so *everything* in that tree is agent-readable,
whatever its subdirectory is named.

**A1. Delegated credentials lived in the agent-readable stash — after the
layout had deliberately moved them there.** 0.11.0-beta.11 relocated secret
files *into* `stash/vaults/secrets/` to get them out of the stack-config tree
(CHANGELOG.md:1104-1109) — organizing by owning subsystem, not by exposure.
Since the stash is `/stash` inside the assistant, every delegated credential
(UI login password, OpenCode server password, Guardian/API tokens, portal
principal secrets, bot tokens) was agent-readable. The G1 relocation into
`private/secrets/` (`secrets-migration.ts`, wired at `home-schema.ts:134`)
reversed it, copying each file, **reading the copy back and verifying**, and
only then removing the assistant-reachable original. Even then, user-facing
copy lagged: the Connections page still told operators to edit
`knowledge/secrets/op_opencode_password` after the move (commit `84a3f38`).
*RC: the tree was organized by content type and owning subsystem; the mount
made the whole tree one audience. Exposure by colocation, not by intent.*

**A2. A secret missed by the hand-maintained list made host-admin cookies
forgeable from inside the container.** `op_session_signing_key` — the HMAC key
mixed into every session cookie — was never added to
`DELEGATED_SECRET_NAMES`, so it defaulted into `knowledge/secrets/`: anything
running inside the assistant (or anything that prompt-injected it) could read
the key and forge a valid host-admin session cookie (commit `ce7059c`).
Because the G1 migration iterates that set, fixing it required re-listing the
same migration at `since: 3` with a schema bump — "a home already stamped 3
would otherwise never re-run it and would keep the cookie-signing key readable
from the assistant's /stash" (`home-schema.ts:136-141`).
*RC: placement is decided by membership in a hand-maintained allowlist, and
the default for an unlisted secret is the exposed tree. A one-shot migration
does not re-run when the set it iterates grows.*

**A3. A path that is safe on the host resolved to an agent-writable location
in the container.** `getUiLoginPassword` read the secret *file* first and the
Compose-injected env second. Correct on the host — but the same code runs in
the assistant's UI co-process, where no host `OP_HOME` exists and the file
path resolved inside the agent-writable data mount. The agent could therefore
silently **replace** the operator's LAN login password; the only symptom was
"my password stopped working" (commit `ce7059c`,
`packages/ui/src/lib/server/session-store.ts`). The in-container process now
trusts only its Compose secret and fails closed.
*RC: one path-resolution routine, two execution contexts in which the
identical relative location belongs to different trust domains.*

**A4. Stack configuration itself was agent-readable — and moved three times.**
The Compose env file lived at `config/stack/stack.env` (pre-0.11), then
`knowledge/env/stack.env` (0.11.0, CHANGELOG.md:1003-1005) — inside `/stash`,
exposing host ports, image tags, bind addresses, and the setup flag to the
agent — then split into two files, then consolidated at `state/stack.env`
with the explicit rationale that "host ports, image tags and the setup flag
are not the agent's business" (`home.ts:109-119`; CHANGELOG.md:204-206).
*RC: same as A1 — a file placed by content type ("env") into trees whose mount
semantics were decided independently.*

**A5. Two directories named `secrets` with opposite exposure semantics.**
`knowledge/secrets/` (agent-readable by design — it retains provider
`auth.json`) and `private/secrets/` (never agent-readable) coexist. The
operations doc has to warn operators in both directions: "Do not bulk-move
`knowledge/secrets/`" and "Do not put … delegated credentials under
`knowledge/`" (`docs/operations/secrets-env-migration.md`). A name that
requires a warning label is doing the opposite of its job.
*RC: "secrets" encodes sensitivity, not audience — and audience is the axis
the mount graph enforces.*

**A6. The trust boundary is enforced by a 450-line audit, not by structure.**
`secret-audit.ts` polices what the layout cannot express: no service
`env_file` (except the audited Paperclip exception), no secret-like env keys,
per-service secret-name allowlists, no bind-mounting `private/` (a regex over
volume sources, `secret-audit.ts:267-275`), regular non-symlink 0600 files in
0700 directories. The allowlist has accumulated special cases: the
assistant's `ui_login_password` (PR #565 review), guardian's
`opencode_server_password` (#563/D2) and `op_api_key`, and the tunnel's
`ts_authkey` — which the naming convention would misclassify because the
tunnel sits on `portal_net` (`secret-audit.ts:130-180`). The Paperclip
exception also initially shipped as code without the documented invariant,
violating the repo's "invariant lands atomically with its enforcing code"
rule (commit `c27838c`). The audit must run against the **resolved, merged**
config on every apply, because `custom.compose.yml` is user-owned and merges
*last* — any operator or tool editing it can add mounts, secret grants, or
env keys to any service, and `stack.env` interpolates into every file
including that overlay.
*RC: when structure cannot express the rule, an auditor chases every
exception — and each exception is a patch over convention-derived trust. An
extensible last-wins overlay plus a single interpolation namespace is
inherently boundary-widening.*

**A7. The secret/config boundary inside `stack.env` is a key-name pattern —
and it silently destroyed user data.** `writeSystemEnv` strips any
`*_API_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD` key from `stack.env` per the
boundary contract. Before 0.12.0 it did so **silently** — a credential an
operator put there simply vanished (#502, CHANGELOG.md:895-899). Today the
strip *relocates* the value into the canonical file-secret store and leaves a
persistent one-time notice telling the operator where it went
(`config-persistence.ts:283-301`).
*RC: nothing structural prevents writing a secret into the env file; the
writer intercepts it after the fact, by key-name pattern.*

**A8. Paperclip's trust carve-out depends on mount ordering.** Paperclip
receives all of `knowledge/` at `/stash`, then mounts
`knowledge/paperclip/env/` and `knowledge/paperclip/secrets/` **over**
`/stash/env` and `/stash/secrets` to obscure the assistant's canonical
`user.env` and provider `auth.json` ("The parent `/stash` mount is
intentionally followed by more-specific env and secret mounts",
`environment-and-mounts.md`). The isolation is carried entirely by Compose
honoring mount declaration order.
*RC: subtractive trust ("everything except…") cannot be expressed by mounts,
so it is simulated with overmounts — order-fragile and invisible in any single
mount line.*

**A9. A third-party image forced a hole in the env-file ban.** The pinned
Paperclip image reads `BETTER_AUTH_SECRET` and `PAPERCLIP_AGENT_JWT_SECRET`
from `process.env` only, so the layout grew `private/env/paperclip.env` — the
sole permitted Compose `env_file`, fenced by a dedicated auditor checking the
exact path, exact key set, 0600/0700 modes, and that Compose `environment`
values agree with the file (`secret-audit.ts` `auditPaperclipEnv`;
`core-principles.md` §2b). The keep-image-pure-vs-wrap-entrypoint trade-off is
deliberately pinned in a test, the constitution, and the container README "so
weakening either half fails a test instead of passing silently" (commit
`f7b8a02`).
*RC: secret delivery is coupled to what each consuming image can read; the
layout absorbs each incompatibility as a new audited exception.*

**A10. Secret hygiene arrived late and leaks in from the edges.** File modes:
restrictive create modes plus `chmod` enforcement on *pre-existing* files
only landed in 0.11.0-beta.7 (CHANGELOG.md:1173-1178); SQLite WAL/`-shm`
sidecars next to guardian state needed their own 0600 pass
(CHANGELOG.md:410-413). Rotation: the guardian cached its admin token keyed
by *path* only, so in-place rotation left the old token valid until restart
(CHANGELOG.md:503-507); the UI promoted the login password into
`process.env` at startup, so rotation wrote disk while the running server
kept the old password — old=200, new=401 (CHANGELOG.md:442-449). Ambient
environment: a leftover `DISCORD_BOT_TOKEN` in the operator's shell was
silently harvested into the secret store (PR #564 P1-3,
CHANGELOG.md:474-480), ambient bind values could override the chosen access
posture (CHANGELOG.md:634-637), and 0.11.0 had to `OP_`-prefix every runtime
variable to stop host-environment collisions (CHANGELOG.md:1066-1067).
Setup reruns rotated passwords that should have been preserved and wrote
`[object Object]` into portal secrets when presence-metadata objects were
assigned into credential strings (PR #564 P1-1/P1-2, CHANGELOG.md:552-560).
*RC: secrets on a plain filesystem inherit umask, caches, process env, and
ambient shell state unless every touchpoint explicitly opts out. A
host-resident control plane makes the operator's shell part of the input
surface.*

**A11. Scheduled tasks lost their environment silently.** Cron jobs receive a
small managed env preamble (deliberately **not** all of
`knowledge/env/user.env`). When an external crontab rewrite dropped that
preamble, `akm` fell back to a config path that never existed, and every
scheduled task failed with "No stash directory found" **while exiting 0**
(#552; `containers/assistant/entrypoint.sh` `persist_akm_stash_dir_fallback`).
*RC: least-privilege env scoping plus in-container path indirection (`/stash`
means nothing without `AKM_STASH_DIR`) leaves no safe default when the
indirection layer is lost.*

**A12. The entrypoint used to source `user.env` into the OpenCode server
process — one `printenv` away from every user secret.** The assistant
entrypoint previously ran `set -a; . $AKM_STASH_DIR/env/user.env` and exec'd
OpenCode from that shell, putting every `env:user` value (API keys, owner
info) into the server's environment — inherited by **every agent bash-tool
subprocess**, retrievable with a single `env` call, no file path involved.
The entrypoint now never sources it; the sanctioned path is a scoped tool
loading it inside its own one-turn subprocess, and the cron preamble
forwards only a small explicit allowlist
(`containers/assistant/entrypoint.sh:51-67, 534-540`).
*RC: environment variables inherit transitively; sourcing a mounted secrets
file at PID 1 conflates "readable" with "every child should inherit it."*

**A13. The shared `knowledge/` tree is writable by two trust levels — and one
subtree is an execution queue.** `knowledge/` is mounted **rw** into both the
first-party assistant and Paperclip, a digest-pinned *third-party* image.
Outside its two overmounted subtrees, Paperclip can write anywhere in
`knowledge/` — including `knowledge/tasks/`, which the assistant's entrypoint
syncs into its crontab every 60 seconds and executes (`command`, `prompt`,
`workflow` targets). A compromised Paperclip image update could therefore
schedule arbitrary command execution inside the assistant container by
dropping one YAML file. The documented mitigation covers only the reverse
direction ("values under `knowledge/paperclip/` … must be treated as
agent-readable") (`services.compose.yml:36,57`;
`entrypoint.sh:554-579`; `environment-and-mounts.md:271-282`). Standing
fragility, not a fixed incident.
*RC: sharing one rw tree conflates read-sharing (intended) with write-sharing
into an execution path (unintended); `tasks/` is simultaneously user config
and an execution queue.*

**A14. Managed policy trees are mounted rw into the containers they police.**
`system/assistant` — the plugins, permissions, and instructions that
*constrain the agent* — is mounted **rw** at `/etc/opencode` because "plugin
node_modules install here"; the agent's bash tool runs as the same UID and
can rewrite its own permission files in place until the next reconcile.
Guardian's `system/guardian` is likewise rw. Only the newest service got the
recognized fix: Paperclip's managed bootstrap is mounted **ro** with a
separate disposable rw runtime copy at `cache/paperclip-opencode/runtime`
(`core.compose.yml:47-53,199`; `services.compose.yml:48-53`). Standing
fragility.
*RC: one directory serves two roles — release-shipped policy and runtime
plugin install target; rw for the second grants write on the first. A policy
tree writable by the process it polices is only advisory.*

**A15. Git cannot carry secret file modes, so skeleton-seeded files can
arrive world-readable.** Git's tree-object model stores only the executable
bit; a packaging step "can hand back a world-readable file no matter what
mode the skeleton source is chmod'd to." The mitigation is repair-on-access:
`user.env` is re-chmodded to 0600 on every touch, and both secrets-dir
resolvers re-assert 0700/0600 on every resolve — best-effort with logging,
because a root-seeded file throws EPERM and an abort there would kill the
install "before the wizard is ever served" (K3,
`akm-user-env.ts:198-239`; `secrets-files.ts:65-89`).
*RC: distribution channels (git, tar, copyFileSync) each have their own mode
semantics; a mode set once at authoring time does not survive the pipeline.*

### B. Write-ownership boundaries and the managed-overwrite hazard

`system/` is replaced wholesale from the release skeleton on every reconcile
(`overwriteSystemTree`, `core-assets.ts`). That is the right semantics for
managed assets and a destructive trap for everything else.

**B1. The managed-tree overwrite destroyed app-generated runtime config.** The
remote addon's generated Tailscale Serve config was first written to
`system/stack/remote`. The skeleton ships no `remote/` directory, so the
config *and* the directory containerboot fsnotify-watches were **deleted by
the next update** — after which containerboot `log.Fatalf`s and the tunnel
refuses to start (commit `863aabf`). It now lives at `state/remote/`, with
`home.ts:199-227` recording exactly this.
*RC: "app-generated file that is also a container mount source" had no tree
whose semantics fit: `system/` is overwritten, `config/` is user-owned,
`state/` was defined as never-mounted records. The file bent the `state/`
definition rather than the layout providing a place.*

**B2. The managed tree is not actually release-only — a container writes into
it.** `system/assistant` is bind-mounted **rw** at `/etc/opencode`
(`OPENCODE_CONFIG_DIR`), and OpenCode plugin installs write `node_modules`
trees — including `.bin` *symlinks* — into it at runtime. The reconciler's
strict listing treated any non-regular-file as a corrupt managed asset and
**crashed on the tree it was about to overwrite** (commit `01161de`,
`core-assets.ts:190-196`).
*RC: one tree is simultaneously "wholly release-managed" and
"container-writable"; the reconciler's world-model was false. Paperclip later
demonstrated the correct pattern — read-only managed source plus a separate
mutable runtime copy (`cache/paperclip-opencode/runtime`).*

**B3. `state/` quietly stopped being "never mounted".** `state/` is defined as
app-written records (`core-principles.md`), and `stack.env` is deliberately
kept out of every container. `state/remote/` (B1) is now a bind-mount source
into the `tunnel` container. The tree's definition and its contents have
diverged.
*RC: no tree existed for app-written, container-visible runtime files, so the
closest tree absorbed them and its contract blurred.*

**B4. Per-file ownership lists contradicted tree-level ownership.**
`config/assistant/opencode.jsonc` — a user-owned file by tree contract since
the 0.9.0-rc2 XDG model — sat on the `MANAGED_ASSETS` refresh list, so every
`openpalm update` silently reset user model/agent settings
(0.11.0-beta.7, CHANGELOG.md:1180-1185). It became seeded-only.
*RC: ownership was a per-file decision that could contradict the tree-level
contract; nothing checked the two against each other.*

**B5. One user-owned file required its own tree carve-out.**
`custom.compose.yml` must never be overwritten, so it cannot live with its
three sibling compose files in managed `system/stack/`. The result is a
dedicated `config/stack/` subtree holding exactly one file, seeded once
(`home.ts:99-107`), with the constitution stating explicitly that
"co-locating a never-overwrite user file inside the wholesale-overwritten
managed tree is forbidden" (`core-principles.md` §1b).
*RC: the compose assembly is one logical unit with three owners (release,
user, app), scattered across three trees and reunited by convention at
compose time.*

**B6. Ownership granularity below the mount is unenforceable.**
`config/assistant/user-profile.md` is assistant-written inside otherwise
user-owned `config/`, because OpenCode's `external_directory` permission
asserts against the target's **parent directory** — the grant cannot be
narrowed to one file (`core-principles.md` §1). Conversely, guardian's
`moderation.md` is a file users reasonably want to edit, pinned inside the
managed tree because relocating it to `config/guardian/` — a tree mounted at
a *different* container path — "would silently stop OpenCode from loading it"
(`core-principles.md` §1).
*RC: mount-level and permission-level granularity don't match the layout's
per-file ownership intent; in-container search paths dictate host placement.*

**B7. Install-state detection keyed on files the seeder rewrites every
launch.** "Is OpenPalm installed?" was inferred from
`system/stack/core.compose.yml` existing — but both harnesses re-seed the
managed tree from the bundled skeleton on every launch, so a machine that
never installed anything reported an *abandoned install* from first boot,
trapping users in an uncompletable wizard on Docker-less hosts (commit
`5e922db`). The CLI also seeded the home and minted guardian tokens *before*
its Docker preflight, so a failed first run left artifacts that made the
retry claim an install existed (commit `6af05e7`). Classification now keys on
`state/stack.env` — an artifact the seeder never writes.
*RC: `system/` contents carry no information (seeding produces them); only
`state/` artifacts are evidence of a real install. The tree split earns its
keep here — once the classifier respects it.*

**B8. The tree definition itself was duplicated and drifted.** The CLI kept
its own copy of the directory list, which "had silently fallen behind (no
`system/`, no `state/`, no `config/guardian`, none of the per-service
dot-directories under `data/`)" — `ensureHomeDirs` is now the only definition
(`home.ts:298-307`).
*RC: layout-as-code in more than one place; see also F2.*

**B9. The Docker socket's journey out of the containers.** 0.9.0-rc2 ran the
admin plane as a container and introduced `tecnativa/docker-socket-proxy`
specifically because "socket permission and GID issues across Docker Desktop,
OrbStack, Colima, and Podman" made direct socket mounts non-portable
(CHANGELOG.md:1450-1453). 0.11.0 deleted the container, the proxy, and the
Caddy front entirely: the admin UI became a **host process** with native
access to `OP_HOME` and the socket (CHANGELOG.md:1024-1027). Shipped tasks
that assumed the sandboxed assistant could orchestrate Docker were later
removed as "impossible host-lifecycle automations" (CHANGELOG.md:271-276).
*RC: the socket's host GID does not map portably into containers; a proxy
papered over it with a privileged service. The durable fix was recognizing
host-vs-container placement as the real design axis: what must touch the
socket or chown `OP_HOME` lives on the host; containers get only bind-mounted
subtrees.*

**B10. Seed-if-missing plus existence-based discovery makes an empty seed
worse than none.** Skeleton assets resolve through a fallback chain whose
last link "does not survive bundling into the UI/Electron build" and degrades
to the empty string. Writing that empty string would seed a permanently
broken compose file: overlay discovery includes a file "purely because it
EXISTS (content is never checked)", empty is invalid Compose input, and the
seed-if-missing guard "never runs again to repair it" — every subsequent
compose invocation fails, forever (K4, `config-persistence.ts:618-649`;
`core-assets.ts:31-106`). The write is skipped instead, leaving the slot open
for a later successful seed.
*RC: degraded reads must never cross into writes when file existence doubles
as configuration.*

**B11. Release-authored content seeded into a user tree strands forever —
an acknowledged open problem.** `knowledge/skills/` is release content "the
operator is not expected to author or edit, same as `system/`" — but it lives
in the user-owned knowledge tree, so it is seeded once and never updated: "a
skill bugfix shipped in a LATER release only ever reaches a brand-new
OP_HOME." It cannot join the always-overwrite pass because "knowledge/skills/
has no separate 'this one's mine' marker the way `config/` vs `system/` does"
(K7, `ui-assets.ts:81-99`). Standing, explicitly deferred.
*RC: a tree-granular ownership model has no per-file provenance, so shipped
content inside a user tree has no update channel.*

### C. Bind-mount mechanics

The mechanics of Docker bind mounts — inode pinning, missing-source
auto-creation, mount ordering, merge semantics — produced a class of
incidents independent of *what* was being mounted.

**C1. Single-file bind mounts pin inodes; an atomic-rename rewrite silently
detached every running container.** `knowledge/secrets/auth.json` is
bind-mounted as a **file** into the assistant. A refactor switched secret
writes to atomic tmp+rename — which gives the host a *new* inode while
running containers keep the old one: containers stop seeing host writes, and
OpenCode keeps writing OAuth refreshes into the orphan inode (commit
`61f149b`). The corrupt-recovery path had the same bug ("used to rename the
live file away"). The fix is `writeFileInPlace` for auth.json specifically
(`fs-atomic.ts:19-24`), an inode-preservation test
(`auth-json-inode.test.ts`), and a deliberate matrix: `writeSecret` *stays*
tmp+rename because its targets are Compose `file:` secrets (copied at
container-create) or files inside directory mounts (rename visible) —
`secrets-files.ts:119-132`.
*RC: write strategy (in-place vs rename) must match mount granularity (file
vs directory), and the codebase had one generic write path for both.*

**C2. The same physics dictated the newest mount's shape.** The remote
addon's serve config is mounted as a **directory**, not a file:
containerboot fsnotify-watches the directory and hard-fails if it cannot, and
a directory mount makes atomic temp+rename writes visible, where a file mount
"would leave the container reading the stale copy forever"
(`home.ts:199-211`).
*Lesson applied — C1, learned.*

**C3. Docker creates a missing bind-mount source as a root-owned directory —
a bug class that keeps recurring.** On macOS/OrbStack, Ollama failed with
"access denied creating data/ollama" (#452, 0.11.1, CHANGELOG.md:961-964).
The fix evolved into two durable rules: mount service data at the image's
**native** path (never a generic `/data`), and pre-create every bind source
operator-owned before Compose runs. Pre-creation is now compose-driven:
`ensureComposeVolumeTargets` parses `docker compose config --format json` —
which fully interpolates `${VAR:-…}` (a previous hand-rolled regex mangled
nested defaults) and renders profile-gated services too — then mkdirs and
chowns each `OP_HOME`-rooted source (`config-persistence.ts:495-540`).
The class still recurred twice in the visible two-week history: `data/tunnel`
and `data/paperclip` were each initially created ad hoc outside the shared
mechanism (commits `c27838c`, `92d56ba`).
*RC: Docker's auto-create default is root-owned-directory — wrong owner,
sometimes wrong type — and every new addon that bypasses the one shared
pre-creation path re-triggers it.*

**C4. A named volume nested inside a bind mount broke rootless installs.** The
first cache design (commit `921412b1`) nested a named volume at
`/home/opencode/.cache` inside the HOME bind; Docker created the mountpoint
root-owned and the rootless smoke failed. The replacement is a host bind from
pre-created, operator-owned `cache/assistant` — and `cache/` became a
top-level tree partly *because* being a sibling of `data/` lets backups,
ownership repair, and purge treat it wholesale (`core.compose.yml:191-197`;
`core-principles.md`:144).
*RC: mixing mount kinds at nested paths hands mountpoint creation to the
wrong party.*

**C5. Where a *file* is expected, an empty placeholder must be pre-seeded —
and every Compose-declared file must exist or the whole project fails.** Two
shapes of the same trap. `ensureHomeDirs` pre-writes empty `auth.json`
placeholders so a mount can't materialize a directory where a file belongs
(`home.ts:384-389`). And a declared Compose secret or `env_file` whose source
is missing fails **the entire project — including `docker compose config`**:
enabling the remote addon without visiting the credentials form broke
`compose up` for the whole stack (missing `ts_authkey`, commit `863aabf`),
and a manually-enabled or restored Paperclip did the same via its missing
env file (commit `92d56ba`). Both are now seeded unconditionally in
`ensureSecrets` — `ts_authkey` deliberately seeded *empty*, which is a real
configuration, not a placeholder.
*RC: file existence is part of the Compose project's global validity, but
file creation was tied to optional UI flows instead of the universal apply
path.*

**C6. A mount source that depends on env interpolation needs an always-present
decoy.** The optional host AKM stash is mounted as
`${OP_HOST_AKM_STASH:-${OP_HOME}/data/akm/empty-host-stash}:/host-stash`
(`core.compose.yml:206-213`). When the feature is off, the fallback is an
always-existing empty directory maintained purely so Compose never errors —
and akm is configured to never walk it. The entrypoint deliberately never
chowns this mount: when set, it points at the user's personal `~/akm`. Two
standing fragilities: the key's value is a raw host path consumed as a mount
source — a typo mounts the wrong host directory **rw into the assistant** —
and "never chowns" is enforced only by the entrypoint happening not to, a
comment rather than a testable invariant (`host-akm-sharing.ts:7-9`).
*RC: Compose has no conditional mounts, so "optional mount" is simulated with
a fallback source — turning a feature toggle into a filesystem fixture and a
config key into a host-path injection point.*

**C14. `OP_HOST_AKM_STASH` is the one bind source outside `OP_HOME` — and it
sits outside every safety net #452 built.** The #452 fix pre-creates and
chowns every compose bind source, but **deliberately only for paths under
`OP_HOME`** (`config-persistence.ts:489-490,556`). The single source that can
point elsewhere — the operator's personal `~/akm` — is excluded: the enable
paths never `mkdir` or existence-check it (`host-akm-sharing.ts:63-71`), the
container never chowns it, and on native Linux enabling the feature when
`~/akm` does not yet exist makes Docker auto-create it **root-owned** (C3, now
outside the repair scope). Worse, headless/API setup **default-enables**
sharing (`hostAkm !== false`, `setup.ts:83,495-497`) while the wizard defaults
it off — so an omitted field turns on a foreign rw mount.
*RC: the pre-creation and repair machinery is scoped to `OP_HOME` by design,
but the layout admits exactly one mount source outside it, which therefore
inherits none of those guarantees.*

**C7. Compose merge semantics cannot express "remove".** The rootless overlay
tried to cancel the base file's fixed `user:` UID with YAML `null`; Compose's
merge **ignores null** and kept the incompatible host identity. The working
idiom is an empty-string user value (CHANGELOG.md:164-166). Same family: the
`${VAR:-}` idiom maps *unset* to *empty string*, which crashed the UI child —
adapter-node's `parse_origin` accepts a valid URL or an **absent** variable,
and `ORIGIN=""` threw at module load, failing the assistant healthcheck and
blocking the stack (commits `445cb07`, `b785fc8`).
*RC: Compose's config algebra (merge, interpolation) has no "unset" — every
consumer that distinguishes empty from absent needs an entrypoint-level
guard.*

**C8. Nested overmounts create order and authority hazards.** The assistant's
`config/assistant` mounts *over* its `data/assistant` HOME at
`~/.config/opencode`; Paperclip's overlays (A8) mount over `/stash`. Host
authority (§D of the constitution: a bind mount obscures pre-existing
container files) means each nesting is a claim about which host tree wins —
legible only by reading the full mount list in order.
*RC: assembling one container filesystem from fragments of six host trees
requires nesting; nesting encodes trust and authority decisions
positionally.*

**C9. Repair tooling that touches a missing named volume poisons Compose.** A
`docker run -v` against a not-yet-created named volume creates it **without
compose labels**, after which every `compose up` warns "already exists but
was not created by Docker Compose" — so ownership repair must inspect first
and treat only "no such volume" as skippable
(`volume-ownership.ts:103-124`).
*RC: two creators (Compose and repair tooling) for one resource class.*

**C10. Interpolation guards are inconsistent — and an unguarded `${OP_HOME}`
fails rootward.** Image versions use `${VAR:?required}` and abort loudly when
`stack.env` is missing — but every bind-mount source is a bare
`${OP_HOME}/...` with no guard. A hand-run `docker compose` without
`--env-file` (the documented manual runbook path the port fallbacks exist to
serve) interpolates `OP_HOME` to empty and rewrites every mount source to
root-anchored paths (`/data/assistant`, `/knowledge`,
`/private/env/paperclip.env` …), which Docker will happily create root-owned
on the host (C3). Voice's image tag is `${OP_VOICE_VERSION:-latest}-cpu` — a
missing key silently deploys a floating tag, the exact failure mode the
tunnel comments condemn. The deliberate contrast exists in-tree:
`${OP_TELEMETRY_DISABLED:-1}` is chosen so "the unset case is never the
permissive one" (`core.compose.yml:34,189-218`;
`services.compose.yml:210,88-93`).
*RC: interpolation defaults were added per-variable as needs arose; no rule
required "unset must be either loud or safe" across the mount and image
surface.*

**C11. A bind mount over a path the image populates silently shadows baked
content.** Guardian's `$HOME` is bind-mounted for runtime state, so its npm
package must install to `/opt/openpalm/guardian-pkg`, *not* `$HOME` — "an
empty host dir bind-mounted there would shadow a baked node_modules and force
a network re-fetch every boot" (`containers/guardian/entrypoint.sh:94-109`).
Retiring the guardian-cache named volume (#585) then re-introduced an
accepted, documented regression: a non-default package override now lives
only in the container's writable layer and reinstalls on every recreation.
*RC: a mount at a path the image also populates always wins, replacing baked
content with whatever — possibly nothing — the host directory holds.*

**C12. The durable/ephemeral boundary is invisible from inside the
container.** Tools the assistant installed into the container filesystem
vanished on `--force-recreate` or image upgrade. The fix is an explicit
persistence taxonomy *given to the agent itself*: `$HOME`-based installs
persist (HOME is the `data/assistant` bind), `/opt/persistent` (the one
surviving named volume, first on `$PATH`) is for prefix-style installs, apt
is session-only (CHANGELOG.md:1275-1292). #585 retired the other three named
volumes; everything else durable is a bind under `OP_HOME`.
*RC: the mount map is a filesystem-layout contract that must be documented at
the path level for anything — human or agent — that writes inside a
container.*

**C13. File-vs-directory pre-creation is decided by a dot-in-the-basename
heuristic.** Docker's resolved config normalizes every host mount to
`type: bind` with no file-vs-directory signal, so the shared pre-creation
mechanism *guesses*: a dotted basename means file (`auth.json` is the only
shipped file mount). The docblock admits it is "imperfect for dotted
*directory* names like `data.v2` … prefer dotless directory names in compose
files to avoid relying on it" — a future dotted directory mount would be
pre-created as an empty **file**, and Docker would then fail or mount the
wrong type (`config-persistence.ts:567-582`). Standing fragility.
*RC: the one authoritative mount source (`docker compose config`) erases the
one bit pre-creation needs, so a naming convention became load-bearing.*

### D. Host ↔ container path and value mapping

Containers cannot see `OP_HOME` or read `state/stack.env`; the host cannot
see container paths. Every value that crosses that line is threaded through
Compose interpolation — and each thread is a place to break.

**D1. In-container processes cannot read host config, so every needed value
becomes a mirror variable.** The assistant entrypoint "has no OP_HOME
in-container, so it cannot read `state/stack.env` itself — this interpolation
is the only way the resolved value reaches it" (`core.compose.yml:157-168`,
`OP_VOICE_LAN_ACCESS`; same pattern for `OP_UI_BIND_ADDRESS`, which exists
because the UI child always binds `0.0.0.0` in-container and "its own
listener says nothing about whether the port is published to the LAN").
*RC: one config file, two address spaces; the boundary is crossed
variable-by-variable, by hand, with a comment each time.*

**D2. Interpolation fallbacks drifted from the shipped contract — invisibly,
for a long time.** The `core.compose.yml` port fallbacks sat **inverted**
(the retired assistant 3800 / UI 3810 pair) "for so long" because
`migrateLegacyDefaultPorts` silently corrected the values on every supported
path — "so only a manual `docker compose` invocation ever saw the truth"
(`home-schema.ts:1-21`; `core.compose.yml:96-106`).
*RC: a `${VAR:-default}` is a second source of truth. When tooling papers
over it, the two can disagree for years — and the constitution's "manual
management should be easy" promise silently breaks for exactly the users who
take it up.*

**D3. Container-side `$$` expansion made a healthcheck follow a variable to a
dead port.** The UI probe used `$${OP_UI_PORT:-3000}` — container-side
expansion of a variable deliberately never passed in. Correct only by
omission: an operator adding `OP_UI_PORT` to a `custom.compose.yml`
`environment:` block silently pointed the probe at a port nothing listens on.
It is now the literal `3000`: "a literal cannot drift"
(`core.compose.yml:228-235`).
*RC: two expansion phases (host compose interpolation vs in-container shell)
over one variable namespace.*

**D4. A secret with unenumerated consumers deadlocked the whole stack.**
Enabling direct-assistant Basic auth turned auth on in the server but the
compose and image healthchecks probed `/health` unauthenticated — the probe
401'd forever, the assistant never went healthy, and guardian's `depends_on:
service_healthy` **blocked the entire stack from deploying** (PR #564 P1-1,
CHANGELOG.md:668-682). The probe now reads the same mounted secret file under
the same condition as the server — necessarily so, since "a Docker
healthcheck process only ever sees the container's created env, never
variables the entrypoint exports later" (`core.compose.yml:238-258`).
*RC: auth posture was decided by one flag plus one secret file, but the
healthcheck was a third consumer nobody enumerated. Compose, entrypoint, and
healthcheck each see a different "environment."*

**D5. File-backed credentials diverged byte-by-byte across consumers.** The
guardian read the OpenCode password file with `.trim()` while the entrypoint
used `$(cat)` — a password with surrounding spaces 401'd every
guardian→assistant call (CHANGELOG.md:592-597). Host-UI forwarders encoded
Basic auth with Latin-1 `btoa`, breaking non-ASCII passwords, and defaulted
the username to `openpalm` instead of OpenCode's `opencode`
(CHANGELOG.md:544-550, 599-606). All consumers now share one UTF-8-safe
encoder and strip trailing newlines only.
*RC: each service independently reimplemented "read the secret file and build
the header"; their normalization choices silently diverged.*

**D6. A config value encoding one side's network topology broke the other
side.** The setup wizard rewrites a host-loopback provider URL to
`host.docker.internal` so the *container* can reach it — and persists that
into `config/akm/config.json`, which host-side `akm tasks run` reads too. On
Linux, Docker adds no such name to the host resolver, so every host
automation lost the local model the wizard had just verified. The fix derives
a per-call translated copy for the host process, keeps the canonical mounted
file untouched, and places the derived copy at `data/akm/host-config` — a
sibling **deliberately not mounted** by any compose file, so containers can
never see the wrong variant (commit `28a28cd`; `akm-user-env.ts:40-141`).
*RC: a file shared across the host/container boundary embedded one execution
context's DNS topology.*

**D7. The tunnel sidecar collapsed all clients into one address and
globalized a per-client throttle.** Behind the remote tunnel every request
reaches the UI from the sidecar's address, so the per-client login throttle
became global: five failed attempts by anyone locked out the owner.
`ADDRESS_HEADER`/`XFF_DEPTH` are set **only while the remote addon is
enabled**, because a directly-reached listener must not trust a forgeable
`X-Forwarded-For` (`core.compose.yml:129-141`).
*RC: network identity has the same two-worlds problem as paths — in-container
peer address vs real client needs explicit, conditional translation.*

**D8. Two OP_HOMEs, one Compose project name — mutual clobbering.** Compose
identifies a stack by project name, not by which host tree it bind-mounts;
two homes using the default name silently recreated each other's containers
with the other home's mounts. Fixed by a project-identity check in
`startDeploy` plus a distinct `OP_PROJECT_NAME=openpalm-dev` for dev stacks
(0.11.0, CHANGELOG.md:1281-1285).
*RC: the stack's real identity is "this OP_HOME," but nothing stamped that
identity into the Compose project or verified it against running
containers.*

**D9. Compose's own path resolution needed a flag to survive the layout.**
Because the managed compose files live away from the project root,
`--project-directory .` is required or "Docker Compose resolves build
contexts relative to the first `-f` file's directory, which breaks builds"
(`compose.dev.yml:1-19`).
*RC: file location encodes meaning to Compose too; moving compose files into
`system/stack/` changed build-context resolution as a side effect.*

**D10. Compose secrets are delivery, not placement — so path-sensitive
consumers need copy shims, and multi-file stacks need duplicated
declarations.** A Compose secret always lands at `/run/secrets/<name>`, never
where the consumer looks: guardian's entrypoint must `install -m 600` the
provider `auth.json` secret into `$HOME/.local/share/opencode/` at every
boot — which is why credential rotation takes effect only on restart
(`containers/guardian/entrypoint.sh:24-38`; `core-principles.md`:340). Each
managed compose file must also parse standalone under `docker compose
config`, so the same top-level secret (`opencode_server_password`) is
declared in **both** `core.compose.yml` and `portals.compose.yml` — duplicate
declarations kept in sync by hand (#563; `core.compose.yml:299-302`). The
tunnel avoids the env-dump leak with Tailscale's
`TS_AUTHKEY=file:/run/secrets/ts_authkey` indirection so the key never
appears in `docker inspect` (`services.compose.yml:396-401`).
*RC: the secret primitive fixes the in-container path and scopes declarations
per file; everything else is glue the layout must supply.*

**D11. Secret values on the command line leak through `/proc/<pid>/cmdline`.**
Passing a secret as an argv to a child process exposes it to any process that
can read `/proc` — the file-I/O workaround (write to a file, pass the path)
avoids it but couples the consumer to a private file format. A related mechanic:
the `state/stack.env` file is a **Compose dotenv, not a shell script**, so
`--env-file` cannot feed the shell's own `--project-name` expansion, and a
secret-looking value there is both audited and stripped (A7) precisely because
`stack.env` interpolates into every service.
*RC: three different "how a value reaches a process" channels — argv, env,
file — each with a different exposure surface (`/proc`, `docker inspect`,
filesystem).*

**D12. Compose project name derived from mutable config, with no rename
protocol, split one stack across two projects.** Beyond the two-OP_HOME
collision (D8), deriving the project name from a config value the operator can
change means editing that value **orphans the running containers** under the
old project name — a rename needs an explicit down-under-old-name,
up-under-new-name protocol, not a bare value change.
*RC: stack identity is derived from mutable data with no migration path for
the derivation's own inputs.*

**D13. The same OP_HOME behaved differently under two harnesses — opposite
env precedence.** The Electron desktop app built the UI child's environment by
spreading `process.env` first and persisted `state/stack.env` second, so the
file **silently overrode any live operator override**; the CLI layered them
the other way (live-env-wins). "Same home, two harnesses, opposite
precedence" (`packages/electron/src/main.ts:279-287`). The fix pins one order
(persisted `stack.env` *under* live env) across all launchers.
*RC: `state/stack.env` is one file, but each launcher (Electron, CLI,
container entrypoint) composed the process environment around it
independently.*

**D14. Docker's shell-env-beats-`--env-file` precedence turned harness
process env into a stealth `stack.env` override.** Compose resolves
interpolation from **shell env before `--env-file`**, so any
`OP_*_VERSION` value in the spawning host process's environment silently
overrides the authoritative pins in `state/stack.env`. Electron once injected
`latest`, so every `compose config`/`pull` resolved `:latest`/`latest-*` tags
that don't exist for prereleases and deploys failed with "manifest unknown"
(`packages/electron/src/main.ts:263-278,301-308`). The harness now
strips `OP_HOME` and the four version keys from the child env.
*RC: the "single authoritative env file" assumption is false — Compose gives
the spawning process's ambient environment *higher* precedence than the file
the layout treats as the source of truth.*

**D15. Bind address is not a connect address — three resolution chains
produced `http://0.0.0.0` browser URLs.** One `stack.env` key
(`OP_ASSISTANT_BIND_ADDRESS`) answers two different questions — "which
interface does Docker publish on" and "what URL should a browser dial" — and
Electron, the CLI, and the container entrypoint each resolved it
independently. Electron baked the wildcard `0.0.0.0` into a browser-facing
URL. The consolidating fix then **over-corrected**, collapsing every
non-loopback bind to `127.0.0.1` — but Docker's `bind:port` publish maps the
port onto *only* the named interface, so a concrete LAN-IP bind is genuinely
not reachable via loopback (`assistant-endpoint.ts:1-55`).
*RC: a single value serves two semantics (publish-interface vs dial-address);
absent one resolver, every surface reinvents the mapping and picks a different
wrong answer.*

### E. UID/GID ownership of bind-mounted files

A bind mount shares not just bytes but *ownership* between two worlds. An
entire subsystem (`host-identity.ts`, `ownership-reconcile.ts`,
`volume-ownership.ts`, `operator-ids.ts`) exists to manage the consequences.

**E1. One missing `user:` directive salted the host with root-owned files.**
Guardian ran without the `user: "${OP_UID}:${OP_GID}"` directive every other
service carried; files under `data/guardian` and `data/logs` were root-owned,
and host-side backups failed with EACCES. It was patched twice in one day —
0.12.9 shipped the *workaround* (skip unreadable dirs in the safety backup, a
permanent softening of backup guarantees) before 0.12.10 fixed the cause
(CHANGELOG.md:686-704). The unfixable residue is why
`repairRootOwnedBindMounts` exists: the host process cannot chown root-owned
files, so repair delegates to a sandboxed throwaway alpine container —
digest-pinned, network-none, read-only rootfs, `--cap-drop ALL` plus only
CHOWN/DAC_OVERRIDE/FOWNER (`volume-ownership.ts:20-50`). Ownership repair
must then be followed by re-asserting secret modes, because chown and mode
hardening are separate passes (commit `06a4764`).
*RC: per-service `user:` is a convention repeated per compose block with no
structural enforcement; one omission produces damage that outlives the
container and requires root to undo.*

**E2. `user: "${OP_UID}:${OP_GID}"` goes stale when the drive moves.** After
a host swap, `stack.env` "still holds the PREVIOUS host's ids" — so adopting
a moved OP_HOME must also patch those values or containers start as the uid
that was just chowned away (`ownership-reconcile.ts:258-263`).
*RC: host identity baked into a portable file; the file travels, the identity
doesn't.*

**E3. Distinguishing "drive moved" from "permissions drifted" required a
fingerprint subsystem.** A swap is decided by machine fingerprint (kind +
hostname) alone — deliberately *not* by canary ownership, because "a moved
drive can coincidentally have a path or two owned by the new uid … letting
that downgrade a real swap to `drift` silently starts the stack against
foreign-owned files" (`ownership-reconcile.ts:88-95`). Swaps block fail-safe
(`HostSwapBlockedError`) unless `--adopt-host`.
*RC: bind-mount ownership is only meaningful relative to a machine; the
layout stores no machine context, so one was bolted on
(`state/host-identity.json`).*

**E4. VM-mediated runtimes make host-side ownership checks *wrong*.** Under
Docker Desktop / OrbStack / Colima / Podman machine, "the file-sharing layer
translates uids, so a host-side bind-mount ownership comparison is a
false-positive swap risk and a host-side chown could target the wrong uid."
Host-swap detection and bind-mount adoption are skipped wholesale there; only
named volumes are repaired, inside the VM's own uid namespace
(`ownership-reconcile.ts:217-237`).
*RC: the ownership model assumes uid identity across the mount boundary — an
assumption that is false on the most common macOS/Windows runtimes.*

**E5. Repair state could wedge as "done" on failure.** The recursive chown
walk is expensive (multi-hundred-MB `node_modules` trees), so a marker
records "repaired for this uid." Both repair helpers swallow docker-chown
failures in non-strict mode, so an unconditionally-written marker turned a
failed repair into a permanent "done": "the next start would skip the repair
walk forever with no retry and no error" (R9-F2/X15,
`ownership-reconcile.ts:264-285`). The marker is now written only on full
success.
*RC: caching a fixpoint claim ("ownership is correct") that the underlying
operation only best-efforts.*

**E6. Wrong-uid writers appear on both sides of the mount.** The container
must never chown `/host-stash` — it may be the operator's personal `~/akm`
(`core.compose.yml:206-213`). Inversely, akm's schema migration running under
the wrong uid created **root-owned db files inside the bind-mounted stash** —
"the chown-clobber class of bug" — so the entrypoint now runs a
deterministic db-opening command as the correct user at boot (#474,
`containers/assistant/entrypoint.sh:401-423`). And `sudo openpalm start` on a
root-owned OP_HOME yields no usable session uid; the decision logic treats
that as `match` so it "never spuriously blocks"
(`ownership-reconcile.ts:99-106`).
*RC: every writer on either side of a bind mount must agree on identity;
each new writer (cron, migration, entrypoint phase, sudo invocation)
re-litigates it.*

**E7. Host-swap detection was originally tautological.** "Current identity"
was computed by `resolveOperatorIds`, which *prefers the OP_HOME disk owner*
— after a drive move, that is precisely the stale previous uid, so current
always equaled recorded, every canary matched, and the swap gate never fired.
The fix separates identity-of-session (process uid) from identity-for-repair
(disk owner) (`operator-ids.ts:83-95`; `ownership-reconcile.ts:86-111`).
*RC: the detector's input was derived from the very state whose corruption it
was meant to detect.*

**E8. Windows/WSL2 is handled by declaring host filesystem facts
non-authoritative wholesale.** On win32 the entire ownership subsystem is a
stack of deliberate no-ops: `OP_UID`/`OP_GID` are never computed and are
**omitted from the generated `stack.env`** so containers run as the compose
fallback `1000:1000` inside the WSL2 VM (`operator-ids.ts:8-31`;
`fallback-system-env.ts:24-31`); bind-target chown is a no-op because "Docker
Desktop's gRPC-FUSE masks ownership anyway"
(`config-persistence.ts:588-594`); root-owned-volume repair "returns true
unconditionally" (`volume-ownership.ts:43-52`); and even the voice CDI GPU
probe is skipped because "/etc/cdi/* exists only inside the WSL2 distro where
the win32 Node process cannot stat it" (`bring-up.ts:667-679`). The install
surface diverges too — env-var-only knobs and PowerShell `ExecutionPolicy`
guidance (`docs/installation.md`).
*RC: the ownership/permission model assumes a POSIX filesystem with
authoritative uids; Windows/WSL, like the macOS VM runtimes, satisfies neither
and is handled by a stack of skip-lists rather than a portable abstraction.*

**E9. Forcing a third-party image rootless relocated its socket — and any
manual diagnostic that doesn't know reads a healthy tunnel as down.** The
Tailscale sidecar image defaults to root; the repo's rootless convention runs
it as `${OP_UID}:${OP_GID}`, which cannot create `/var/run/tailscale`, so the
socket is relocated to `/tmp/tailscaled.sock` via `TS_SOCKET`. The standing
trap: "anything shelling into this container must pass the socket explicitly …
a bare `tailscale status` … reports the tunnel as down even when it is
healthy" (`services.compose.yml:411-433`). `TS_USERSPACE=true` is pinned
explicitly (not left to the upstream default) because userspace networking is
also what makes the tunnel work on Docker Desktop for Mac/Windows, "where
there is no real host network namespace to grant a TUN device into."
*RC: forcing a third-party image off its default (root) identity moves the
paths it hard-codes, and the new paths become undocumented preconditions for
every operator diagnostic.*

### F. Path resolution, env-file semantics, and duplication in code

**F1. A missing field interpolated to the literal string `"undefined"` — and
credentials landed in the repo root.** Path builders interpolate state
fields; an absent field yielded `undefined` as a segment, producing a
*relative* path — "a caller that meant to write `auth.json` into OP_HOME
silently writes it under the process's current working directory instead …
it has been writing real credential files into the repo root." Every builder
now fails loudly (`paths.ts:20-35`).
*RC: stringly-typed path assembly with optional inputs; the failure mode is
silent relocation of secrets.*

**F2. One well-known path was duplicated 18 times.** The "well-known files"
section of `home.ts` exists "specifically to kill the blast-radius class of
change, e.g. `${state.stashDir}/env/stack.env` duplicated 18×"
(`home.ts:85-90`). Moving a file is now a one-line edit.
*RC: no single source of truth for the layout (see also B8).*

**F3. Two env files merged by `--env-file` order spawned eight hand-rolled
re-implementations — one wrong.** During the split era
(`knowledge/env/stack.env` + `state/stack.state.env`), "eight call sites
hand-rolled the same 'parse both, spread state over legacy' merge …
`resolveActiveProfiles` did exactly that [read the wrong file], so an enabled
addon never activated its profile" (`home-schema.ts:48-67`). Consolidation
into one `state/stack.env` deleted the class. A subtlety the merge had to
understand: service-version keys in the knowledge file were *records* of the
last applied release, not *pins* — promoting them would have frozen installs
at their current images, so they are deliberately dropped.
*RC: layout complexity (two files, ordered) leaks into every reader as
mandatory merge logic; identical-looking keys carry different intent in
different trees.*

**F4. Env-file semantics themselves bit the migration — and corruption meant
data loss.** Env parsing is last-occurrence-wins but `mergeEnvContent`
rewrites the first occurrence, so a stale duplicate later in the file
"silently beat the state value the running stack was actually using"
(`home-schema.ts:81-85`). A pre-seeded target (bootstrapped with
`OP_SETUP_COMPLETE=false`) had to be prevented from overriding the merge —
it "would send [the operator] back to the wizard" (`home-schema.ts:88-101`).
And `parseEnvFile` returned `{}` on *any* parse error, so a corrupt
`stack.env` caused the next read-modify-write to silently discard every env
var; it now preserves the bytes as `stack.env.corrupt-<timestamp>` first
(0.11.0-beta.7, CHANGELOG.md:1186-1189).
*RC: a hand-editable env file as the sole authoritative record, maintained by
read-modify-write, with merge semantics nobody implements twice the same
way.*

**F5. `stack.env` mixes three value classes with no marking — and every class
needed its own fix.** Operator-set, app-recorded, and app-derived keys share
the file. Derived: `GUARDIAN_DIRECT_INGRESS` is recomputed on every
access-toggle apply, so a hand-edit (which stale UI copy *recommended*)
survives only until the next apply; a setup rerun recomputing it from
toggles alone broke a live tunnel (commits `84a3f38`, `863aabf`). Pins vs
defaults: `OP_*_VERSION` keys carry both "operator pin" and "managed
default" intents, distinguished only by a shadow *marker* key — setup used
the pin-flavored writer for its own defaults, so images **silently stopped
updating** after any wizard install (commit `61f149b`,
`versions.ts:94-144`). Retired keys: renamed and dead keys needed explicit
prune migrations, and one leftover (`OP_VOICE_PROFILE`) was read by a later
enablement migration as evidence the addon should be on — **re-enabling an
addon the operator had disabled** (CHANGELOG.md:1011-1016, 263-270, 722-724,
466-472). Exposure posture went through three designs (per-service pairs →
one global `OP_BIND_ADDRESS` → flat per-service toggles) before landing on
storing *intent* explicitly (`OP_ACCESS_*`) "so a read is a read, not an
inference from bind addresses" (CHANGELOG.md:791-792, 298-302;
`environment-and-mounts.md:341`).
*RC: intent lived in code paths, not in data. Any migration that infers
intent from key presence turns leftovers into phantom configuration.*

**F6. Layout migrations ran forever because nothing recorded completion.**
"Every 'migrate legacy X' function used to run on every deploy path, forever
… A home created today still paid for all of them, permanently" — and one of
them is what masked D2 (`home-schema.ts:1-15`). The `state/schema-version`
gate fixed it; the version is written atomically because "a torn plain write
would leave a file that parses as version 0 and silently re-runs every
one-shot migration" (`home.ts:166-171`). It is deliberately a bare file in
`state/`, **not** a `stack.env` key, "because that file is a Compose
`--env-file` and this is not a value any container should see"
(`home-schema.ts:12-15`). The stamp must happen inside `ensureHomeDirs`,
before seeding — "the only moment [is this home new?] is still answerable"
(`home.ts:173-186`).
*RC: a layout without a version must be re-inferred from its own bytes on
every boot; perpetual self-healing hides real defects.*

**F7. The root itself is resolved permissively, then frozen into generated
files.** `OP_HOME` resolution passes the env var through a *lexical*
`resolvePath` — a literal `~/foo` value resolves relative to the cwd, not
the home — and when `homedir()` is empty the root silently degrades to
`tmpdir()`: a misconfigured environment puts the entire install, secrets
included, in a world-readable temp directory (`home.ts:23-34`). The resolved
absolute path is then written into `stack.env` for `${OP_HOME}` mount
interpolation (`config-persistence.ts:279-281`) — so a home copied or moved
to a new path keeps pointing containers at the *old* location until
`stack.env` is regenerated.
*RC: no validation at the root; and a generated file embedding absolute host
paths makes every mount depend on a value frozen at write time.*

### G. Migration, backup, and lifecycle scope

**G1. Every layout move needed (and refined) the same migration discipline.**
The 0.11.0 reorg established it: full backup first, **abort with no changes
if the backup fails**, copy-only (originals retained with a safe-removal
README), version-gated, idempotent (CHANGELOG.md:1051-1057). G1 added
verify-before-delete and leave-both-on-conflict: a delegated secret present
in both locations with different bytes is left in both places with a loud
warning, never auto-resolved (`secrets-migration.ts:80-98`). The 0.10 path
still blocks startup on a failed required migration rather than "pretending
the old home is current" (`docs/operations/upgrade-0.10-to-0.11.md`).
*Lesson applied — but note the standing cost: three eras of migration code,
legacy path helpers, and `hasAnyStackEnvFile` archaeology live in the tree
permanently (`home.ts:121-148`).*

**G2. Renaming a concept renamed user-owned files, a Docker network, and DB
rows.** The 0.12.0 `channels`→`portals` rename touched secret filenames
(values preserved), a guardian SQLite column, overlay filenames, and the
adapters' network. Mitigations: the old `channel_lan` network was kept one
release as an empty bridge so existing `custom.compose.yml` overlays kept
validating; user overlays were auto-rewritten with a `.bak`; the stale
`channels.compose.yml` was harmless only because overlays load from an
**explicit list, not a glob**. The removal then needed two follow-ups: the
deprecation guard initially **blocked uninstall**, and it had to move before
any file writes so operators get the instruction pre-write
(CHANGELOG.md:769-785, 901-926, 417-423, 623-628).
*RC: internal names baked into filenames, network names, and durable rows
that user-authored overlays may reference — user overlays are public API.*

**G3. Migrations must run under the control-plane version that defined
them.** An older control plane could point the stack at a newer tag and
execute the new release's migrations against the old `@openpalm/lib`, coming
up half-migrated — now hard-blocked, with the version dropdown filtered
server-side and downgrades gated behind an explicit confirm (forward-only
migrations) (#492, #501, CHANGELOG.md:877-894). The same lesson hit the
desktop app twice: `runHomeMigrations` was called from the *frozen* Electron
harness, which can only implement the schema current at its build date — it
moved into the updatable control plane (commit `3b3739b`) — and an Electron
refactor dropped the launch-time skeleton reseed, so an auto-updated app ran
against the previous release's managed tree — "the exact mixed-release state
the artifact model exists to prevent" (commit `6b64b36`).
*RC: OP_HOME outlives every shipped artifact; schema-mutating code frozen
into an artifact drifts from the moving schema.*

**G4. Rollback and migration rewrite the same files and needed an explicit
ordering.** `applyManagedFiles` runs `runHomeMigrations` **before** it
snapshots, deliberately: rolling back a failed deploy restores the pre-deploy
file *in its migrated form* — "undoing it would only make the next boot redo
it" (commit `1da47c6`).
*RC: rollback must undo the deploy, never the migration; without an explicit
contract a rollback could resurrect a schema the already-updated code no
longer expects.*

**G5. Backup scope and restore coherence disagree — by design, with a
documented trap.** Lifecycle safety backups include `private/` but exclude
service-owned `data/` — which excludes Paperclip's **embedded PostgreSQL
cluster**. The credentials are in scope, the database is not: "a restore
that brings back the secrets without `data/paperclip` yields a working login
against an empty database. Back up both or neither"
(`environment-and-mounts.md`; commit `c27838c`).
*RC: backup scope is defined per-tree, restore coherence per-service; the
units don't align, and the mismatch is pushed onto the operator as a
warning.*

**G6. Scope lists are hand-maintained, and the backup itself became a disk
hazard.** Backup, purge, ownership-repair, and rollback are four different
scopes over the same eight trees, each its own list (`backup.ts`,
`ownership-reconcile.ts:34-55`, `core-principles.md` §6/Rollback). `cache/`
was designed as a sibling of `data/` specifically so these scopes could treat
it wholesale (`home.ts:52-59`). Once "always back up before touching the
layout" became policy, the backups themselves filled disks — ~5 GB per
snapshot until `data/` and `cache/` were excluded wholesale (#581), and the
free-space guard was **dead code** because it treated "unmeasurable" as
"unlimited"; it now fails closed, the estimator must mirror the copy scope
exactly, snapshots stage into a hidden dir and rename into place behind a
completion marker, and retention is per-namespace because "mixing them under
one lexicographic/global cutoff is exactly the bug this fixes"
(`backup.ts:64-101,174-253,366-420`; #499, CHANGELOG.md:843-849).
`OP_BACKUP_DIR` exists to point backups at a filesystem with headroom
(`home.ts:273-286`). Unbounded Docker json-file logs separately "contributed
to the production disk incident" (IMG-7, `core.compose.yml:36-42`). And the
disk-headroom preflight measures only **OP_HOME's** filesystem — but image
pulls fill **Docker's data root**, which on Docker Desktop is inside a VM
entirely — so the check can pass while the actual write target is full.
*RC: scope is a derived property of tree semantics encoded as parallel
lists; a single-root layout concentrates data, backups, caches, and logs on
one filesystem; and "free space" is measured on the wrong filesystem from the
one the pull writes to.*

**G7. `uninstall --purge` missed trees — including `private/`.** The purge
list enumerated trees by resolver, so when `private/` was introduced as a
sibling of `knowledge/`, purge didn't gain it: `--purge` reported "all data
removed" **while leaving every live credential on disk** (Codex #5,
`packages/cli/src/commands/uninstall.ts:73-114`). Earlier, leaving
`state/stack.env` or `system/stack/core.compose.yml` behind made the next
plain install classify as already-installed, contradicting the purge
message. The code now enumerates all eight trees explicitly, deletes
`data/` last (it holds the install lock), and never deletes an external
`OP_BACKUP_DIR` — and `privateDir`'s docblock states the requirement
directly: a new tree "must be included in every destructive lifecycle path."
*RC: same as G6 — per-tree policy encoded as parallel hand-maintained lists;
adding a tree is an N-place change with no completeness check.*

**G8. A capability spread across a generated file, env keys, and containers
had no single apply — and failed open.** The remote addon's effective state
spans `state/remote`'s serve document, `GUARDIAN_DIRECT_INGRESS` in
`stack.env`, and the container set. `addon enable remote` started the tunnel
without regenerating the document (serving the previous, disabled config
while reporting success); disable left the live document and only tried to
stop the container — "a failed stop left a Funnel publicly reachable while
the addon read as off." And because Tailscale reads an *absent* serve file as
"no change," off must be an explicit **empty-document write**, never a file
deletion (commits `14ef96b`, `863aabf`).
The voice LAN overlay hit the same shape from the compose side: passed only
as an ad-hoc `extraFiles` to one bring-up call, the next plain
`openpalm start` rebuilt voice *without* `assistant_net`, silently breaking
LAN voice — the overlay had to move into the ONE shared file-list builder
every compose invocation uses (`config-persistence.ts:427-442`).
*RC: one logical toggle materialized as three separately-writable artifacts
with no single apply function — and the consumer treats absence as "keep
current state." Overlays passed ad hoc to a single invocation are guaranteed
drift.*

## 2.5. Known unaddressed risks

These are cases the codebase does **not** handle today — verified by searching
for any code, test, doc warning, or recorded incident and finding none. They
are latent variants of the families above, listed so the proposal can address
them structurally rather than waiting for each to become an incident.

- **Symlinked `OP_HOME`.** Path resolution uses lexical `resolvePath` only —
  no `realpath()` anywhere in `home.ts` (`home.ts:30-34`). Worse,
  `discoverHomeBindMountSources` decides "is this mount under `OP_HOME`?" by
  `startsWith(homeRoot)` over un-canonicalized strings
  (`config-persistence.ts:544-556`) — so if `OP_HOME` is a symlink, a bind
  source expressed through the real path (or vice versa) can silently fall
  *outside* the pre-creation and ownership-repair scope, the same class as C14.
- **Spaces in the `OP_HOME` path.** No handling, tests, or warnings. The
  manual-compose `op()` helper quotes correctly and Compose YAML scalars
  tolerate spaces, but nothing pins it — a shell path built without quoting
  anywhere in the entrypoints would break.
- **Network filesystems (NFS/SMB) under `OP_HOME`.** Zero mentions. Bind
  mounts of NFS paths interact badly with uid mapping, file locking (SQLite
  `data/*.db`, the install lock), and inode stability (C1) — none acknowledged.
- **macOS Docker Desktop file-sharing scope.** `OP_HOME` must be under a
  path Docker Desktop shares into the VM; never documented. Only the uid
  translation the VM performs is acknowledged (E4), not the share-scope
  precondition itself.

*These four share one root with C14: the layout is authored for a plain local
POSIX directory, and every deviation (symlink, space, network FS, VM share
boundary) is an unhandled edge rather than a validated-and-rejected or
supported input.*

## 3. Lessons learned

Distilled, grouped, each traceable to the catalog.

### Trust and exposure

1. **The unit of mounting must be the unit of trust.** Anything inside a
   wholesale-mounted tree is exposed, whatever its name (A1–A5). Subtractive
   exceptions become order-fragile overmounts (A8). If a subtree needs
   different exposure than its parent, it is in the wrong tree.
2. **Organize secrets by audience, not by kind or owning subsystem.** The
   layout moved secrets *into* the agent-readable tree once (A1) because it
   was organized by subsystem; the mount graph, not the directory name,
   determines who reads a file. Naming is part of the model: two `secrets/`
   trees with opposite semantics need warning labels (A5).
3. **Hand-maintained membership lists guard the boundary poorly.** An
   unlisted secret defaults into the exposed tree (A2); a growing list needs
   a re-run migration and a schema bump (A2); pattern-based stripping
   destroys user data silently (A7). Prefer a default-deny location and
   explicit classification at creation time.
4. **In-container code must trust only explicitly injected secrets.** A
   filesystem probe that is safe on the host resolves to attacker-writable
   space in a container (A3). Never fall back to ambient process env for
   secrets or security posture (A10) — a host-resident control plane inherits
   the operator's whole shell.
5. **Every consumer of a secret must be enumerated, and read it
   identically.** Healthchecks are consumers (D4). `.trim()` vs `$(cat)` vs
   Latin-1 `btoa` is three authentication systems (D5). Rotation is part of
   the contract: content-keyed caches, no startup env promotion, tri-state
   write-only UX (A10), and Compose-secret consumers rotate only on restart
   because delivery is copy-at-create (D10).
6. **A secret's delivery channel is part of its exposure.** Environment
   variables inherit transitively into every subprocess an agent spawns (A12)
   and appear in `docker inspect` (D10); argv appears in `/proc/<pid>/cmdline`
   (D11). File delivery with scoped one-turn loading is the only containable
   pattern; `file:` indirection keeps keys out of `inspect`.
7. **A writable directory that a scheduler executes from is an execution
   path, not shared data.** Cross-trust rw sharing of `knowledge/` makes
   `tasks/` a privilege-escalation channel from any addon into the assistant
   (A13). Share cross-trust trees read-only, or mount only the subtrees each
   service needs.
8. **A policy tree writable by the process it polices is only advisory.**
   Managed config that must accept runtime installs needs the ro-bootstrap +
   disposable-rw-runtime-copy split, not an rw mount of the policy itself
   (A14, B2).

### Mount mechanics

9. **Never bind-mount a single file.** File mounts pin inodes and break
   atomic-rename writers (C1); directory mounts make renames visible (C2).
   If a file must be file-mounted anyway, its writer must be in-place and
   inode-pinned by a test (C1).
10. **Every mount source must pre-exist, owner-correct, before Compose runs —
   discovered from Compose's own resolved config.** Docker auto-creates
   missing sources as root-owned directories (C3, C4); hand-rolled
   interpolation drifts from Docker's (C3); per-addon ad-hoc `mkdir`s
   re-trigger the class (C3 recurred twice in two weeks). One shared
   mechanism (`docker compose config --format json` → pre-create + chown),
   no bypasses.
11. **Every Compose-declared file must be seeded unconditionally.** A missing
   declared secret or `env_file` fails the *whole project*, including
   `config` (C5). Seed empty-but-valid files when absence and emptiness mean
   different things (C5).
12. **Compose's config algebra is part of the layout contract.** Merge cannot
   express "remove" (`null` is ignored — C7); `${VAR:-}` converts unset to
   empty for consumers that distinguish them (C7); profiles don't exempt a
   service's files from validity (C5); project name — not mount sources — is
   stack identity (D8).
13. **Mount service data at the image's native path, never a generic
    `/data`** (C3); and document the durable/ephemeral boundary *to whatever
    writes inside the container*, agent included (C12); keep image-baked
    code at paths no mount ever covers — a bind over a populated path
    silently shadows it (C11).

### Identity and ownership

14. **UID/GID is part of the mount contract, and it is machine-relative.**
    Every service needs an explicit non-root `user:` from day one — one
    omission salts the host with root-owned files that only a privileged
    container can fix (E1). Identity baked into `stack.env` goes stale on
    drive moves (E2); the detector must not read the very state it checks
    (E7); VM-mediated runtimes and Windows/WSL translate or lack uids and are
    handled by skip-lists, not a portable abstraction (E4, E8); repair must be
    sandboxed, never touch user-owned mounts (E6), be followed by secret-mode
    re-hardening (E1), and never cache success it didn't verify (E5).

### Configuration and env files

15. **Exactly one Compose env file, one writer per key, intent stored as
    data — but know it is not actually authoritative.** Two files made every
    reader reimplement precedence, one wrongly (F3). Mixed value classes
    (operator/recorded/derived) in one file produced silent reverts, frozen
    updates, and phantom re-enables (F5). Compose gives the **spawning
    process's shell env higher precedence than `--env-file`**, so ambient
    harness env silently overrode the file's version pins (D14) — strip what
    must not leak. And each launcher (Electron/CLI/container) composed the
    environment around the file with its own precedence until one order was
    pinned (D13). Store intent explicitly (`OP_ACCESS_*`, version markers)
    "so a read is a read."
16. **A `${VAR:-fallback}` in managed Compose is a second source of truth.**
    It drifted, inverted, and was masked by self-healing migrations for
    years (D2, F6); container-side `$$` expansion adds a second phase over
    the same namespace (D3). Audit every `${VAR}` against "what happens when
    `stack.env` lacks it?" — mount sources and image tags must fail loud, and
    any silent default must be provably the safe direction (C10). Fail loudly
    (`:?`), generate values explicitly, or use literals.
17. **Values must cross the host/container boundary once, through one
    resolver, and files must not embed either side's topology.** Mirror
    variables with comments are the working pattern (D1); a shared config
    file carrying `host.docker.internal` broke every host-side consumer
    (D6); network identity needs the same conditional translation as paths
    (D7). And a single key that answers two questions (publish-interface vs
    dial-address) resolved by three independent surfaces produced
    `http://0.0.0.0` URLs and an over-corrected fix (D15) — one resolver, not
    one key reused by three call sites.
18. **Treat env parsing as data-loss-capable.** Corrupt-parses-to-empty plus
    read-modify-write equals wiped config (F4); duplicate keys interact
    badly with first-occurrence rewrites (F4); path builders must fail
    loudly on missing inputs — `"undefined"` segments wrote credentials to
    the repo root (F1).

### Layout evolution and lifecycle

19. **One tree, one writer class — and one definition of the tree.** Every
    exception became an incident: app files in the managed tree were
    destroyed (B1), a container writes into "release-owned" `system/` (B2),
    per-file lists contradicted tree ownership and reset user config (B4),
    `state/` quietly became mountable (B3). The tree definition and the
    well-known paths must each live in exactly one module (B8, F2).
20. **Classify install state only from artifacts the classified action
    uniquely produces.** Seeder-written `system/` files carry no information
    (B7); `state/` artifacts do — that distinction is the tree split earning
    its keep.
21. **Version the layout; gate, verify, and order the migrations.** Un-gated
    migrations run forever and mask real defects (F6); migrations run only
    under the control-plane version that defined them (G3); migrate before
    snapshotting so rollback never un-migrates (G4); copy-verify-delete and
    leave-both-on-conflict for secrets (G1); every retired key gets a prune
    (F5); every doc/UI string naming an old path is a migration artifact to
    sweep (A1).
22. **User-authored overlays referencing internal names are public API.**
    Renames must bridge one release, auto-rewrite with backups, load from
    explicit lists rather than globs, and never block uninstall (G2).
23. **Scopes (backup, purge, ownership, rollback) should derive from tree
    semantics, not parallel lists — and restore units are per-service, not
    per-tree.** The Paperclip database/credential split is the standing
    counterexample (G5, G6).
24. **Adding a top-level tree is an N-place change with no completeness
    check.** `private/` was purge-missed at introduction, leaving every live
    credential on disk after "all data removed" (G7); each new tree must be
    threaded through purge, backup include/exclude, ownership repair,
    canaries, and seeding — or those scopes must derive from one tree
    manifest.
25. **A capability's "off" must be an affirmative write when consumers treat
    absence as "keep going"** — and every mutation path must run one shared
    apply over all of the capability's artifacts, including its compose
    overlays (G8).

These lessons are carried forward into the companion proposal:
[`op-home-restructure-proposal.md`](op-home-restructure-proposal.md).
