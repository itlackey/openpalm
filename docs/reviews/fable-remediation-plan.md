# Fable Remediation Plan

Date: 2026-07-05 · Tree: `main@002b715b` (the exact commit every review and the verification
pass ran against — all file:line references below were re-spot-checked against this tree).

## Implementation Status

| Item | Status | Note |
|---|---|---|
| 0.1 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran commands directly in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1. `git merge-base --is-ancestor automation/0.1 automation/fable-remediation; echo "exit code: $?"` → printed `exit code: 0`. 2. `git log automation/fable-remediation --oneline -5`: `9e64a169 fix(0.1): merge verified plan item`, `eca3dd62 fix(secrets): atomic writes, zero-byte self-heal, relocate stripped values (0.1)`, `002b715b docs: add Fable review prompts for OpenPalm foundations`, `87854f3d Merge pull request #548 from itlackey/copilot/follow-up-code-quality-items`, `dd28aef0 docs(guardian): document user:/portal: rate-limit bucket-prefix at the emission site`. HEAD of automation/fable-remediation is commit 9e64a169 "fix(0.1): merge verified plan item". 3. Confirmed it's a real, non-trivial merge: `git show --stat 9e64a169` shows Merge parents `002b715b` (prior fable-remediation tip) and `eca3dd62` (tip of automation/0.1), with a genuine diffstat (7 files changed, 150 insertions, 18 deletions) touching config-persistence.ts, secrets-files.ts, secrets.ts, RecoveryTab.svelte, and new test files — not an empty merge. 4. `git log automation/0.1 --oneline -5` confirms eca3dd62 is indeed the tip of automation/0.1, matching the commit merged into fable-remediation. Conclusion: automation/0.1 IS a real ancestor of automation/fable-remediation, and the merge commit for item 0.1 is present at the tip of automation/fable-remediation with substantive file changes. |
| 0.2-0.3 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1. `git merge-base --is-ancestor automation/0.2-0.3 automation/fable-remediation` -> exit code 0. 2. `git log automation/fable-remediation --oneline -5` output: 945bbad4 fix(0.2-0.3): merge verified plan item, 4f43b2b3 docs: update implementation status for 0.1, 9e64a169 fix(0.1): merge verified plan item, 2525d933 fix(rollback): disarm snapshot on success; make rollback non-destructive (0.2-0.3), eca3dd62 fix(secrets): atomic writes, zero-byte self-heal, relocate stripped values (0.1). The top commit (945bbad4) is explicitly labeled as the merge commit for the 0.2-0.3 plan item, and it is within the last 5 commits. |
| 0.4 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran both checks directly in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1. `git merge-base --is-ancestor automation/0.4 automation/fable-remediation` → EXIT_CODE=0 (confirmed ancestor). 2. `git log automation/fable-remediation --oneline -5`: `5b7e931a fix(0.4): merge verified plan item`, `2936d78f docs: update implementation status for 0.2-0.3`, `945bbad4 fix(0.2-0.3): merge verified plan item`, `4f43b2b3 docs: update implementation status for 0.1`, `9e64a169 fix(0.1): merge verified plan item`. The tip commit (5b7e931a) is explicitly labeled "fix(0.4): merge verified plan item", confirming a commit for item 0.4 exists on automation/fable-remediation. Both checks pass: automation/0.4 is an ancestor of automation/fable-remediation, and the branch log shows a corresponding merge commit for 0.4. |
| 1.2 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1. `git merge-base --is-ancestor automation/1.2 automation/fable-remediation; echo $?` -> exit code 0. 2. `git log automation/fable-remediation --oneline -5`: 9ba712f3 fix(1.2): merge verified plan item, 782e3be2 docs: update implementation status for 0.4, 5b7e931a fix(0.4): merge verified plan item, 2936d78f docs: update implementation status for 0.2-0.3, 945bbad4 fix(0.2-0.3): merge verified plan item. `9ba712f3` is present and is a merge commit for item 1.2 (Merge: 782e3be2 09a1a01a). Confirmed 09a1a01a is the tip of automation/1.2 (`git log automation/1.2 --oneline -3` shows 09a1a01a docs(core-principles): resolve moderation.md editability decision (fable 1.2) as HEAD). `git show --stat 9ba712f3` shows the expected content merged in: changes to docs/technical/core-principles.md and a new test file packages/lib/src/control-plane/moderation-doc-contract.test.ts. |
| 1.3 | MERGE-FAILED | Merge could not be independently verified — branch automation/1.3 (.claude/worktrees/fable/1.3) left intact. Detail: Confirmed on branch automation/fable-remediation in .claude/worktrees/fable/_base. Ran `git merge --no-ff automation/1.3 -m "fix(1.3): merge verified plan item"`. Merge produced a CONFLICT (content) in docs/technical/core-principles.md; packages/lib/src/control-plane/lifecycle.ts auto-merged cleanly but the overall merge failed due to the core-principles.md conflict. Ran `git merge --abort` per instructions; working tree is clean and no merge was performed. |
| 1.4 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1. `git merge-base --is-ancestor automation/1.4 automation/fable-remediation` -> EXIT_CODE=0 (automation/1.4 IS an ancestor of automation/fable-remediation). 2. `git log automation/fable-remediation --oneline -5`: ceaa085d fix(1.4): merge verified plan item, 5e8e2972 docs: update implementation status for 1.3, 6e50b6dd docs: update implementation status for 1.2, 9ba712f3 fix(1.2): merge verified plan item, 782e3be2 docs: update implementation status for 0.4. Top commit ceaa085d is present and explicitly labeled for 1.4. 3. Corroborating detail: `git show --stat ceaa085d` shows it's a merge commit `Merge: 5e8e2972 51186ab8`, and `git merge-base automation/1.4 automation/fable-remediation` returns `51186ab8` exactly - i.e. the second parent of the 1.4 merge commit is automation/1.4's own tip (`51186ab8 fix(setup): make state/ the sole OP_*_VERSION pin authority (1.4)`). Both independent checks agree: the merge occurred and is visible in history. |
| 1.5 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1. `git merge-base --is-ancestor automation/1.5 automation/fable-remediation` → exit code 0 (confirmed via `echo $?`). 2. `git log automation/fable-remediation --oneline -5` output: 7d5c47ed fix(1.5): merge verified plan item, d6216f8d docs: update implementation status for 1.4, ceaa085d fix(1.4): merge verified plan item, 5e8e2972 docs: update implementation status for 1.3, 6e50b6dd docs: update implementation status for 1.2. The top commit (7d5c47ed) is explicitly labeled "fix(1.5): merge verified plan item", confirming item 1.5 was merged into automation/fable-remediation. |
| 1.6 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran directly in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1) `git merge-base --is-ancestor automation/1.6 automation/fable-remediation` → EXIT_CODE=0 (is an ancestor). Confirmed via `git merge-base automation/1.6 automation/fable-remediation` = 196f75a0774d2b73f447da8465e7ef55dc631152, which equals the tip commit of automation/1.6 (`git log automation/1.6 --oneline -3` shows 196f75a0 as HEAD of that branch). 2) `git log automation/fable-remediation --oneline -5` output: 15b21e64 fix(1.6): merge verified plan item, d0387b2d docs: update implementation status for 1.5, 7d5c47ed fix(1.5): merge verified plan item, d6216f8d docs: update implementation status for 1.4, ceaa085d fix(1.4): merge verified plan item. Top commit 15b21e64 "fix(1.6): merge verified plan item" is the commit for item 1.6, present in fable-remediation's history. |
| 2.1 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran independently in .claude/worktrees/fable/_base (branch automation/fable-remediation checked out). 1) `git merge-base --is-ancestor automation/2.1 automation/fable-remediation` exited with code 0 (success = is an ancestor). Verified branch tips: automation/2.1 = df00bdb7, automation/fable-remediation = 7c517582. 2) `git log automation/fable-remediation --oneline -5` output: 7c517582 fix(2.1): merge verified plan item, b3ebc0a1 docs: update implementation status for 1.6, 15b21e64 fix(1.6): merge verified plan item, d0387b2d docs: update implementation status for 1.5, 7d5c47ed fix(1.5): merge verified plan item. The HEAD commit of automation/fable-remediation is explicitly the merge commit for item 2.1, confirming both the ancestor relationship and the presence of a dedicated commit for 2.1. |
| 3.2 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1. `git merge-base --is-ancestor automation/3.2 automation/fable-remediation` → EXIT_CODE=0 (automation/3.2 IS an ancestor of automation/fable-remediation) 2. `git log automation/fable-remediation --oneline -5`: b2e3f482 fix(3.2): merge verified plan item, b23eb39d docs: update implementation status for 2.1, 7c517582 fix(2.1): merge verified plan item, b3ebc0a1 docs: update implementation status for 1.6, 15b21e64 fix(1.6): merge verified plan item. The most recent commit (b2e3f482) is explicitly "fix(3.2): merge verified plan item", confirming item 3.2 was merged into automation/fable-remediation. Both checks confirm: automation/3.2 has been merged into automation/fable-remediation. |
| 3.4 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran commands fresh in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base (branch automation/fable-remediation, clean working tree) after `git fetch --all`. 1) `git merge-base --is-ancestor automation/3.4 automation/fable-remediation` -> exit code 0 (is an ancestor). 2) `git log automation/fable-remediation --oneline -5` output: 83bb02c6 fix(3.4): merge verified plan item, 8b3724c4 docs: update implementation status for 3.2, b2e3f482 fix(3.2): merge verified plan item, b23eb39d docs: update implementation status for 2.1, 7c517582 fix(2.1): merge verified plan item. Top commit 83bb02c6 is explicitly "fix(3.4): merge verified plan item", confirming a dedicated 3.4 commit is present at the tip of automation/fable-remediation. Additionally, automation/3.4's own tip commit 88916339 ("test(ui,guardian): 3.4 mocked pw.ts subset...") appears in `git log automation/fable-remediation --oneline | grep -i "3.4"` output, corroborating the merge. |
| 3.5 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran both commands in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1. `git merge-base --is-ancestor automation/3.5 automation/fable-remediation` exited with code 0 (confirms automation/3.5 IS an ancestor of automation/fable-remediation). 2. `git log automation/fable-remediation --oneline -5` output: 29ce450b fix(3.5): merge verified plan item, 4368f44c docs: update implementation status for 3.4, 83bb02c6 fix(3.4): merge verified plan item, 8b3724c4 docs: update implementation status for 3.2, b2e3f482 fix(3.2): merge verified plan item. The top (most recent) commit 29ce450b is explicitly labeled "fix(3.5): merge verified plan item", confirming item 3.5 was merged into automation/fable-remediation. |
| 3.6 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Verified in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base (branch automation/fable-remediation, clean working tree): 1. `git merge-base --is-ancestor automation/3.6 automation/fable-remediation` → exit code 0 (is an ancestor). 2. `git log automation/fable-remediation --oneline -5` output: 27a38459 fix(3.6): merge verified plan item, 8de2395d docs: update implementation status for 3.5, 29ce450b fix(3.5): merge verified plan item, 4368f44c docs: update implementation status for 3.4, 83bb02c6 fix(3.4): merge verified plan item. The top commit (27a38459) is explicitly "fix(3.6): merge verified plan item", confirming 3.6 was merged into automation/fable-remediation. |

Sources: `fable-findings-consolidated.md` (the de-duplicated 20-cluster roadmap) as amended by
`fable-verification-pass.md` (one half-refutation, four overstatements, two roadmap defects,
ten corrections, and the completed security pass). Where the two disagree, **the verification
pass wins** — it is the later, code-adjudicated document.

Structure: **Part A** is the non-security plan, sequenced in four phases. **Part B** is the
security plan, deliberately isolated and **deferred until Part A is complete**. Part A carries
one standing constraint (below) that keeps the deferral safe. An appendix maps every finding
in the review corpus to the plan item that addresses it, so nothing is silently dropped.

## Standing constraint while Part B is deferred (G-SEAM guard)

The verified security posture is "keyless-and-broken, not keyless-and-open": the OpenAI/Anthropic
edge fail-open gate (`packages/guardian/src/openai-api.ts:127,137`) is currently *masked* only
because the guardian block sets no `PRINCIPAL_SECRET_FILE`, so the edge 401s at `/oc`. Until
Part B lands, **no Part A work may**:

1. Set `PRINCIPAL_SECRET_FILE` or `OPENAI_COMPAT_API_KEY_FILE` for the guardian service,
   or otherwise "fix" the non-functional chat/api edge.
2. Document or advertise the `setAuthStrategy()` composition seam or the OpenAI-compat edge
   as usable features.
3. Change any bind address default away from `127.0.0.1`.

Violating any of these converts a latent defect into a shipped-exploitable one with no other
change. This constraint is the price of deferring security last, and it is cheap.

---

# Part A — Non-security remediation

## Phase 0 — User-data safety (do first; the killshot chain)

These four items dismantle G-KILLSHOT: today the CLI tells a failing user to run
`openpalm rollback` (`packages/cli/src/commands/update.ts:24`), which restores a snapshot
frozen at the *first-ever* lifecycle op, overwrites live `auth.json` and a user-edited
`custom.compose.yml` with no backup, and cannot revert `state/stack.state.env` — the file
that actually wins the compose merge.

Ordering inside the phase is load-bearing: **0.1 (atomic writes) before 0.2/0.3 are trusted**
(G-TORN — a torn `stack.env` becomes the permanent merge base and the rollback that would
"fix" it is itself a second data-loss event), and **0.2 (disarm) before any consolidation of
restore mechanisms** (G-DISARM-FIRST).

### 0.1 Atomic writes for the two critical writers; self-heal torn secrets; relocate stripped values

*(X13, X14 — both double-confirmed; ~10 lines; ±0)*

- Route `writeSystemEnv` (`packages/lib/src/control-plane/config-persistence.ts:116`) and
  `writeVaultFile` (`secrets.ts:69-70`) through the existing `writeFileAtomic` helper
  (its docstring already claims universal use; `patchStateEnvFile` already does tmp+rename).
- Treat a zero-byte secret file as missing in `ensureSecret` (one `statSync().size` check) so
  a torn secret is re-seeded instead of returned as `""` forever.
- In `stripSecretLikeEnvKeys`' caller: **write each stripped value to
  `knowledge/secrets/<key>` before dropping the line** (X14). Today only the key names survive
  in the notice (`recordSecretStripNotice`, `config-persistence.ts:153-164`) — the values are
  permanently destroyed from a file the docs sanction users to edit. Keep the notice; make it
  say where the value went.
- Tests: torn-write simulation (write interrupted → old content intact); zero-byte secret
  re-seed; strip-relocates-value round-trip.

### 0.2 Disarm the armed snapshot on successful reconcile

*(X1; ~2 lines + barrel export; ±0)*

- In `withStackEnvRollback` (`packages/lib/src/control-plane/lifecycle.ts:432`), call
  `clearArmedSnapshot()` on the success path after `run()` resolves.
- Export `clearArmedSnapshot`/`hasArmedSnapshot` from the lib barrel (`index.ts` currently
  exports only `restoreSnapshot`, line 298).
- Add the success-path twin of the existing crash-preservation test: a *second* successful
  lifecycle op must take a *fresh* snapshot (today the `!hasArmedSnapshot()` gate at
  `lifecycle.ts:431` means the day-one snapshot is preserved forever).
- This alone makes `openpalm rollback` restore the previous operation's state instead of
  day-one state.

### 0.3 Make `openpalm rollback` non-destructive and snapshot what the stack actually reads

*(X1, X2, R9-F7, plus verification correction #1; ~15 lines; +small)*

- **Verification correction applied:** `core.compose.yml` IS already snapshotted/restored
  (ad-hoc `safeCopy` at `rollback.ts:52-53,83-87` — R1-F7's sub-claim was refuted). The real
  gap is only `state/stack.state.env`. Add it to **BOTH** `SNAPSHOT_FILES`
  (`rollback.ts:16-22`) **and** `withStackEnvRollback`'s in-memory protected set
  (`lifecycle.ts` reads/restores only stack.env, portals.compose.yml, custom.compose.yml).
  The consolidated roadmap's alternative ("align to withStackEnvRollback's set") is wrong —
  that set misses the state env too.
- Before `restoreSnapshot` overwrites anything, copy the files it will overwrite to
  `data/backups/<ts>-pre-rollback/`.
- Print the snapshot timestamp and require explicit confirmation when it is older than the
  last successful apply.
- Decide (explicitly, in the PR description) whether `auth.json` belongs in the restore set at
  all — restoring day-old provider credentials is rarely what a user wants. Default
  recommendation: drop it from restore, keep it in the pre-rollback backup.
- Torn-snapshot fix (R9-F7): `rmSync` the `.snapshot-ts` marker at the top of
  `snapshotCurrentState` so a snapshot interrupted mid-write reads as absent (1 line).
- **Scope decision made explicit (verification correction #6):** `SNAPSHOT_FILES` and
  `withStackEnvRollback`'s restore list genuinely differ (`services.compose.yml`,
  `auth.json`). Do **not** silently unify them; after adding the state env to both, document
  the intentional difference in a comment at each site (snapshot = manual rollback scope;
  in-memory = crash-restore scope).

### 0.4 Ownership-repair marker only on success; document the escape hatch; protect recovery backups

*(X15 urgent half, R9-F2, verification correction #10, most-dangerous #4; ~10 lines; ±0)*

- Have `repairRootOwnedBindMounts` / `repairManagedNamedVolumes`
  (`packages/lib/src/control-plane/volume-ownership.ts:74-78,98-102` swallow failures) return
  a success boolean; `ownership-reconcile.ts:224-235` writes the marker unconditionally today —
  skip `writeOwnershipRepairMarker` unless both succeeded. Next start simply retries; no new
  state, no new flags. Add a failed-repair test.
- **Document `openpalm start --adopt-host`** (`ownership-reconcile.ts:222`) as the recovery
  path for an already-wedged install — it exists and works but no user-facing text mentions it
  for this failure, so the non-technical target user stays stranded.
- **`--force` install must not prune recovery backups** (`packages/cli/src/commands/install.ts:201`
  → `pruneBackupDirs(homeDir, 3)`): the backups being pruned are the only recovery copies for
  the secret-strip (0.1) and moderation.md clobber (1.2) losses. Exclude `*-pre-rollback/` and
  `*-pre-update/` directories from pruning (or raise retention and require confirmation),
  and mention pruning in the `--force` help text.
- Log-on-success for the auth.json-as-directory repair (R6-F6b, strengthened by verification):
  the successful `rmSync(recursive)` at `secrets.ts:165-166` currently produces **no log at
  all** (the warn at `:172` fires only on failure). Add a structured warn naming what was
  deleted, and move the deleted directory into `data/backups/` instead of `rmSync` where
  feasible.

**Phase 0 exit gate:** kill-chain integration test — successful install → user edits
`custom.compose.yml` + secrets → successful update → failed update → `openpalm rollback`
restores the *pre-failed-update* state, current files backed up first, state env reverted.

## Phase 1 — Documentation and CI truth (no code risk; one owner-approved batch)

The authoritative docs describe an architecture one generation behind the code, and some
machinery they describe (`migrations.ts`, `RELEASE_MIGRATIONS`, `SHIPPED_DEFAULT_HASHES`,
`refreshCoreAssets`, `/tmp/openpalm` staging) **never existed in this tree** (X5, five-way
corroborated). Because `CLAUDE.md` names `core-principles.md` "the authoritative source of
architectural rules," every stale claim is a latent wrong decision — three of the review
prompts themselves were written against phantom mechanisms.

Security-posture doc corrections (port table, content-validation posture, invariant-3 mount
lists, guardian pipeline description, `OP_ALLOW_REMOTE_SETUP`) are **carved out of this batch
and moved to Part B item S.7** so the security review happens in one place.

### 1.1 Delete the self-defeating CI gate and the flake-tolerance loop — FIRST

*(X5, R10-F5, G-FIXTURE-vs-GATE; CI only; −net)*

- Remove the "Gate legacy stack.yml readers" step (`.github/workflows/ci.yml:27-57`). It
  errors when **no** `'stack.yml'` match exists, demanding "the legacy stack.yml migration
  reader in migrations.ts" — a file that does not exist. It passes today only because test
  fixtures still contain the string. **This must land before any fixture cleanup anywhere in
  the repo** (including 3.5), or the first cleanup PR breaks CI pointing at a
  must-not-recreate file.
- Remove (or explicitly ticket with owner sign-off) the 2-attempt `bun run test` retry loop
  (`ci.yml:148-158`) — codified flake tolerance that contradicts the project's zero-failures
  rule and hides test-order bugs.

### 1.2 Resolve the moderation.md decision (the dangling decision the consolidated roadmap orphaned)

*(X6, G-MOD-MOUNT, verification correction #9a; decision + small change)*

The consolidated roadmap cited "the R11 decision" twice for this, but R11 is the install-lock
fix — **no roadmap item owned this decision**. This item owns it now.

- Current fact: `packages/skeleton/system/guardian/instructions/moderation.md` lives in the
  managed tree; `core-assets.ts:129-160 overwriteSystemTree` clobbers any user edit on every
  apply/boot (plus hot-swap at `ui-server.ts:47`), while `core-principles.md:87` promises
  hash-protected editability via machinery that was deleted.
- Options: (a) relocate to seed-once `config/guardian/` — **hazard:** `config/guardian/`
  mounts at `~/.config/opencode` while the managed tree mounts at `/etc/opencode`
  (`OPENCODE_CONFIG_DIR`), which is where instruction files are actually loaded; relocation
  may silently stop OpenCode loading the file. (b) fix the doc to say the file is managed and
  not user-editable — no hazard.
- **Default: option (b)** unless a verified test proves the `~/.config/opencode` instruction
  path loads. Whichever is chosen, 1.3's doc text must match it.

### 1.3 One truthful `core-principles.md` + AGENTS.md/CLAUDE.md refresh (non-security scope)

*(X4, X5, X17, R6-F11, R8 Tiers 2–4; docs only; −phantom prose)*

One owner-approved PR (the doc is edit-protected):

- Rewrite the layout sections around the real five-tree layout (`config/`, `system/`,
  `state/`, `data/`, `knowledge/`, + `workspace/`), lifting wording from `home.ts:2-15` /
  `paths.ts:7-13`. Document `state/stack.state.env` as an **app-owned record** and the
  single-operator-file collapse as the intended end state — do **not** codify the dual-file
  merge as a permanent contract (G-DOC: documenting the two-file model as permanent entrenches
  exactly what R1 wants gone).
- Delete phantom-mechanism prose: `SHIPPED_DEFAULT_HASHES` / guardian-config-refresh
  (`core-principles.md:87`), the `migrations.ts` layout-migration allowlist (`:183`),
  `RELEASE_MIGRATIONS` (`:216,220`), `/tmp/openpalm` staging. Purge the "release migrations"
  narration from `lifecycle.ts:352,368,420,467` comments and the
  `DowngradeConfirmationRequired` message.
- Fix `scripts/validate-thin-harness-boundary.sh:13-14,34` — the third phantom artifact: the
  script's own comments record that `ensureReleaseMigrated`/`RELEASE_MIGRATIONS` were deleted
  while the authoritative doc still documents them as live.
- Correct the moderation.md contract per the 1.2 decision.
- Refresh AGENTS.md/CLAUDE.md: `.openpalm/` → `packages/skeleton/`; guardian source →
  `packages/guardian/src/` (`containers/guardian/` has no `src/` at all); drop the dead
  `ui:test:e2e:mocked` reference until 3.4 makes it real; regenerate the Commands/Tests tables
  from `package.json`. (The "HMAC, replay" pipeline sentence in CLAUDE.md is security-posture
  text — it moves to S.7.)
- Portal-adapter nuance (D14, verification-corrected): the truth is **both** halves — adapters
  are baked at build time AND `bun update`d at boot (`containers/portal/Dockerfile:2-4`).
  Document the current dual behavior here; *changing* the boot-time update is supply-chain
  work and lives in S.4.

### 1.4 Version-pin single authority

*(strengthened finding: pins live in BOTH env files; small; −)*

`performSetup` writes `OP_*_VERSION` into legacy `knowledge/env/stack.env` (`setup.ts:373`)
while `versions.ts:137,221` writes them into `state/stack.state.env` — dual authority that
directly feeds R1-F1's shadowing confusion. Make `state/` the sole pin location; stop the
`setup.ts:373` legacy write. **Do not** stop the every-setup re-write itself — verification
correction #2 established that the unconditional `OP_*_VERSION` rewrite and the `stashDir`
re-pin are deliberate fixes for documented stale-pin bugs (`setup.ts:356-363`, `:245-248`);
blanket respect-existing would reintroduce them.

### 1.5 Manual/headless install documentation

*(X18, R1-R3 surviving halves only, R10-F2 non-security part; docs + 1 CI exercise)*

- Write the "manual install" page: the `ensureHomeDirs` tree, the two generated tokens, the
  `auth.json` shape, the `OP_SETUP_COMPLETE` stamp — and note (accurately, per the verified
  overstatement) that a hand-built *running* stack is already rescued to `running` by
  `deriveLocalStackState` (`launch-status.ts:187-188`); it is the *classification of
  installedness* that is stamp-only.
- Document the `--file` install path as the supported headless path; add one CI exercise of it.
- Derive installed-state from observable state where cheap (the surviving half of R1-R3).

### 1.6 Repo hygiene: stale compiled artifacts

*(strengthened finding + R10-F7 artifact-churn half; pure −)*

`packages/electron/dist/.../src-D9YnoOnU.js` still greps for `refreshCoreAssets` — a
contributor verifying "zero matches repo-wide" hits checked-in dist output. Remove checked-in
`dist/` build artifacts from the tree (they are git-tracked, so git history is the recovery
mechanism) and gitignore them; regenerate at build time. Reduces future review noise and
electron artifact churn.

## Phase 2 — Orchestration subtraction (the Bitter-Lesson dividend)

One stance produced all of it: compose treated as a subprocess to be scraped instead of driven
by its own flags. `--wait`, `--pull missing`, `--progress plain`, `ps --format json` are used
nowhere; downstream sit two hand-rolled health loops, an image-presence scanner, a
braille-spinner stderr parser, and four compose drivers (the fourth, `voice/bring-up.ts`,
835 lines, grew inside the UI and generates compose YAML into the user's tree).

### 2.1 `up -d --wait --wait-timeout` as the single health gate

*(X9, X10, X20-health; strongly −)*

- **Precondition:** confirm the Compose version floor for `--wait`/`--wait-timeout`/
  `--progress plain` and gate it in the existing `compose version` preflight.
- Add the flags in the compose-up path; on non-zero exit, one `compose ps --format json` call
  names the failed services. Add `--progress plain` to all non-interactive invocations.
- Delete: `waitForContainerHealthy` (`docker.ts:757-791`), `pollContainerHealth`'s gate role
  (`deploy.ts:203-234` — demote to display-only, renamed), `missingServiceImages`
  (`deploy.ts:152-183` — use `--pull missing`; dev path `--pull never`), the spinner-glyph
  regexes in `compose-errors.ts` (268 lines, literal braille frames at `:45`); shrink
  `mapDockerError` to ~6 stable-substring classes with raw-stderr passthrough.
- **Verification correction #9b applied:** `parseComposeStderr` is **retained in this step** —
  `voice/bring-up.ts:34,466` still consumes it. Its deletion moves into 2.2.
- This supersedes R9's two-consecutive-sample health counter (G-GATE-vs-COUNTER): `--wait` is
  the correctness gate; do not build the counter.
- **R9's other two halves land here** (not superseded by `--wait`): gate
  `markSetupComplete` on **core services only** (`deploy.ts:228,361` currently wedges setup
  behind every managed service including optional portals), and move the `OP_*_VERSION` patch
  inside the transactional boundary (`update/+server.ts:84-87` currently advances pins before
  `applyUpdate` runs).

### 2.2 Collapse to one compose driver, including voice

*(X9, X10, R10-F3, verification corrections #3 and #4; largest − diff; depends on 2.1)*

- **The R1-R4 semantic fork, resolved** (no plan document had chosen): `runDeploy` tolerates
  pull failure with local-image fallback (`deploy.ts:335-338`) while `applyStack` is
  pull-fatal (`docker.ts:812`). **Decision: adopt `--pull missing` semantics as the single
  behavior** — a pull failure is fatal only when a required image is genuinely absent locally;
  when all pinned images exist locally, the stack comes up and the pull failure is surfaced as
  a warning. Since image pins are exact versions, an update that changes a pin makes the new
  image "missing" and therefore pull-fatal, which is the correct strictness exactly where it
  matters.
- Route `runDeploy` and `reconcileStack`'s upgrade branch through `applyStack`; delete the
  `planLifecycleOp` flag table (`lifecycle.ts:217-228` — 3 of its 4 plans set
  `pull:false,compose:false`).
- Ship `voice.compose.cdi.yml` / `voice.compose.rootless.yml` as **static skeleton files** —
  verified constant: `buildCdiOverlayYaml` (`bring-up.ts:276`) and `buildRootlessOverlayYaml`
  (`:361`) take no arguments and return constant strings. Delete the generators + their
  `writeFileSync`s (`:311,392`) — this removes the only code-generated config in the tree.
  Move the remaining host-fact probes to lib beside `hardware-detect.ts`; `voice/bring-up.ts`
  keeps only its job registry + progress rendering. **Delete `parseComposeStderr` here**, once
  voice no longer consumes it.
- **Addon-enablement collapse with the R2-R8 upgrade guard** (verification correction #4):
  before deleting the `OP_VOICE_PROFILE`/`OP_OLLAMA_PROFILE` reverse-parse
  (`addons.ts:73-79`), ship a **one-time migration** that writes the derived addon into
  `OP_ENABLED_ADDONS` — otherwise installs that enabled voice/ollama only via profile vars
  silently lose them. Add an upgrade-path test (profile-var-only install → update → addon
  still enabled), per the standing test-the-upgrade-path rule.
- Route mutation-path consumers of the bespoke compose normalization through
  `compose config --format json` (the verified-precise form of R1-F5/R2-B6: the `yaml` library
  is real; only `normalizeVolume`'s `split(':')` and the `env.ts:25-27` interpolation subset
  are hand-rolled and fragile).

**Phase 2 exit gate:** the repo has exactly one compose driver; diff is strongly net-negative;
upgrade-path test green.

## Phase 3 — Lock, harness, coverage, deletions

### 3.1 Install lock correctness and coverage

*(X16, R2-B7; −net; **sequenced after 2.2** — verification correction #9c: this and the driver
collapse touch the same UI route code; do not run in parallel)*

- Delete the live-holder staleness clause (`install-lock.ts` — a live PID older than
  `STALE_AFTER_MS` is declared stale and the lock stolen from a genuinely-running deploy);
  dead-PID detection + `openpalm unlock` cover every genuine case.
- Hold the lock across the UI routes' `applyStack` phase (`install/+server.ts:32,49`,
  `update/+server.ts` currently run `applyStack` after the lock is released inside
  `applyInstall`/`applyUpdate`); reuse `runDeploy`'s acquire-and-pass-`{lock}` pattern. Give
  the scoped single-service update path and CLI `start`/`rollback` an acquire.
- Unify the duplicate PID-liveness helpers (`deploy.ts:112-119` any-throw⇒dead vs
  `install-lock.ts:40-48` EPERM⇒alive) into one helper with correct EPERM semantics.

### 3.2 Thin-harness guards made categorical

*(X12, R7 F1–F4 with verification correction #7; +small guard, −risk)*

- Bundle check greps for a module sentinel rather than the 2 enumerated names
  (`validate-thin-harness-boundary.sh:36` `FORBIDDEN_SYMBOLS=(performUpgrade applyTagChange)`).
- Scan **all** of `packages/electron/src/**` (fail on `import *`/dynamic import/`require` of
  `@openpalm/lib`; validate the union of brace-imports) — today only `main.ts`'s first
  brace-import is read; `update-check.ts`/`docker-preflight.ts` import lib unchecked.
- Add `restartUiServer` to `HARNESS_CONTRACT` + snapshot; add a test that derives the real
  surface from `preload.ts`/`main.ts` and asserts set-equality (the drift-detector is
  currently self-referential).
- Thread `harnessContract` into `seedUiBuild`; treat a missing manifest `minHarnessContract`
  as fail-closed. **Severity note (verification correction #7):** the fresh-seed bypass fires
  only when the packaged app's bundled `resources/ui-build` (`electron-builder.yml:15-17`) is
  ALSO missing — npm is the second fallback, not the first. Still worth closing; not urgent.

### 3.3 Release-unit publish coupling

*(R7-F5, corrected evidence per verification #8; process/CI)*

ui+electron are already the same `platform` bump unit in `.github/release-package-groups.json` —
the real risk lives in `release.yml` unit semantics: an npm publish can succeed without a
mandatory matching installer, leaving packaged installs in version limbo. Fix in `release.yml`
(publish gates, not group membership). Per the standing rule, **no workflow edits without
explicit owner approval** — this item ships as a proposed diff for review.

### 3.4 UI test promotion + mutating-endpoint route tests

*(X19, R10-F2/F7; +tests)*

- Carve a mocked-lib `*.pw.ts` CI subset from the existing `auth-boundary.stack.ts` /
  `install-flow.stack.ts` (login→session→logout, setup-guard redirect, one mutating
  `/admin/containers/*`, wizard→deploy handoff); delete `_placeholder.pw.ts`. This makes
  CLAUDE.md's `ui:test:e2e:mocked` real (coordinate with 1.3).
- Thin route tests for the ~12 mutating endpoints (containers up/down/pull/restart, uninstall,
  unlock, update, auth trio, proxy).
- Auth-negative coverage (verification-corrected scope): `/proxy/assistant/[...path]` already
  has a 152-line `server.vitest.ts`, but only for streaming passthrough with a pre-seeded
  valid `op_session` cookie — add the no-cookie/invalid-cookie negative case. `/admin/auth/login`
  has **no test anywhere** — add one.
- Table-driven `content-screen.ts` unit test (`packages/guardian/src` has none).

### 3.5 Dead-surface deletions

*(R1-F8, R8-D20; pure −; **after 1.1** so fixture cleanup cannot trip the deleted CI gate)*

- `secret-mappings.ts`: remove everything except `STATIC_CORE_MAPPINGS` (~90% dead — hashed
  env keys, plaintext-index CRUD, classifiers; only `validate.ts:12` imports the live part).
- Delete `paths.ts:69-72` `data/secrets` helpers (zero consumers; name-collides with the live
  `home.ts:103 secretsDir`).
- Delete or regenerate `setup-config.schema.json` to match the v2 validator
  (`setup-validation.ts:22` requires `version===2`+`connections`; the schema requires
  `version const 1`+`capabilities`/`assignments`).
- Fix the stale `registry.ts` comment in `core-assets.ts:9`; rename `channel-*` portal loggers
  to `portal-*`; fix `containers/portal/README.md` secret names.
- Delete the dead `GUARDIAN_REQUIRE_PORTAL_SECRETS` flag (set at `portals.compose.yml:114`,
  consumed by zero production code — only a test asserting it is ignored). Behavior-neutral
  deletion; listed here rather than Part B because nothing reads it.
- R2-B10's smaller items (semver util, retry ladder, DI threads, fallback-env): fold
  opportunistically into the files already being touched; no dedicated PR.

### 3.6 Ownership-repair restructure (larger, gated)

*(X15 non-urgent half, R2-B5; −net; **gated on the `rootful 0.11 → current` upgrade-path test
being green** — do not remove machinery before that exists)*

- Restructure the hostname-identity swap taxonomy (`host-identity.ts:51-62`) into a
  convergence check + explicit `openpalm repair-ownership [--adopt]`.
- Move repair-path discovery after `applyHome` (R9-S6 Gap B).
- **Verification correction #5 applied:** deriving `SERVICE_NAMED_VOLUMES` from
  `compose config --format json` is **demoted to optional** — it adds a docker dependency to
  the repair path, and the 10-line static map (`volume-ownership.ts:111-120`) deliberately
  encodes narrower scope. Keep the static map unless a concrete drift bug appears.

---

# Part B — Security plan (isolated; deferred until Part A completes)

> **Detailed standalone version:** [`fable-security- (2026-07-05, Fable-verified;
review-3 partially Opus-attributable but sound). Zero refutations; two findings were
**understated**. The deferral is safe only while Part A's standing constraint holds.

Recommended internal order: S.1 → S.2 → S.3 → S.4 → S.5 → S.6 → S.7 → S.8. S.2's two halves
are strictly ordered (fix false positives **before** wiring the audit in, or every apply
breaks).

### S.1 Close the guardian fail-open OpenAI/Anthropic edge and decide its shipped posture

*(rev3-F1, rev4-F2, rev10-F4, X7, G-SEAM — the finding the security pass sharpened most)*

- Invert `if (!this.apiKey) return true` at `packages/guardian/src/openai-api.ts:127` and
  `:137` to refuse-without-key (or refuse non-loopback binding without a key), mirroring the
  admin listener's empty-token-denies-all. `OPENAI_COMPAT_API_KEY_FILE` is set **nowhere** in
  the shipped stack — only the read site exists — so today the gate is fail-open and active,
  masked solely by the broken upstream principal secret.
- **Attribution correction honored (rev10-F1 correction):** the `AuthStrategy` seam's default
  `basicTokenAuthStrategy` (`auth.ts:77-99`) fails **closed**; the fail-open lives in the
  openai-api layer, which **bypasses the seam entirely**. Fix the openai-api layer; do not
  "harden" the seam that is already correct. Consider routing the openai-api edge *through*
  the seam so there is one auth chokepoint.
- Decide the shipped posture explicitly: either wire `OPENAI_COMPAT_API_KEY_FILE` +
  `PRINCIPAL_SECRET_FILE` in the guardian compose block (making chat/api work,
  authenticated) or document the edge as not-shipped-enabled. Ports 3820/3821 are published
  (`portals.compose.yml:130-131`) and the loopback default is env-overridable
  (`OP_BIND_ADDRESS`/`OP_CHAT_BIND_ADDRESS`/`OP_API_BIND_ADDRESS`) — "keyless-and-broken"
  becomes "keyless-and-open" the moment an operator wires the principal secret, because
  `checkOpenAIAuth` depends only on `apiKey`.
- Move the body read after `authenticate()` and add a coarse pre-auth rate limiter (rev3-F3).
- Fail-closed regression tests: no key → 401 on both edges; key present → authorized path
  unchanged.

### S.2 Secret audit: fix the false positives, THEN wire validation into the apply path

*(rev5-F1, rev5-F2 — UNDERSTATED: the auto-apply path runs NO validation at all)*

1. Fix the guardian ACL at `secret-audit.ts:108-110` (allows only `guardian_`/`portal_`
   prefixes; flags the shipped `op_guardian_admin_token`/`op_guardian_mcp_token` as errors —
   reproduced live).
2. Only then wire `auditComposeSecrets` and `validateProposedState` into `deploy.ts`/
   `lifecycle.ts` — today neither is invoked anywhere in the auto-apply path, making the
   core-principles "validates proposed changes before writing anything" claim doubly false.
   Wiring first would break every apply on the shipped stack's own false positives.
3. Document the actual secret-name authorization model (rev1-F9 corrected form: assistant
   `/^(assistant|opencode|provider|llm|embedding|akm|user)_/`, guardian + all `portal_*`,
   `admin`, default `<serviceId>_`) somewhere other than the tool's source.

### S.3 Content-validation posture: one truth across code, compose, and docs

*(rev4-F3, rev8-D1, X8)*

- Current reality: code default off when env unset (`moderation.ts:34`), compose ships it ON
  (`portals.compose.yml:108` defaults to `1`), entrypoint hard-fails boot if ON and opencode
  is missing (`entrypoint.sh:86-94`), docs say "opt-in and off by default"
  (`core-principles.md:7,59` — twice, per the corrected miscount).
- Maintainer decision required: intended posture (recommend: ON for portal traffic,
  fail-closed — matching what actually ships). Then: make the code default match the intended
  posture rather than relying on a compose interpolation default; assert the flag at boot next
  to the existing opencode-presence assertion; fix both doc sentences.
- Operator-facing: document that moderation can drop traffic, so operators debugging silently
  rejected messages have a trail (structured log per rejection already exists — verify and
  document the log shape).

### S.4 Finish baking the guardian (and portal adapters) into their images

*(rev10-F1, X11 — verified end-to-end: the trust boundary's own code is fetched at boot)*

- The image bakes only the tools `package.json` and a `GUARDIAN_VERSION` string; first boot
  `bun add`s that version from the registry with no lockfile/integrity hash, honoring
  env-selectable `OP_GUARDIAN_PACKAGE`/`OP_GUARDIAN_ENTRY`/`.npmrc`. **The remedy is to finish
  the baking already begun**: `COPY`/install `@openpalm/guardian@<GUARDIAN_VERSION>` +
  `@openpalm/skeleton` at build time; the boot-time `install_artifact` becomes the
  explicit-override path only, via its existing already-at-version check. First-boot-offline
  starts working as a side effect.
- Replace boot-time `bun update` of tools (and of portal adapters —
  `containers/portal/Dockerfile:2-4`, the D14 behavioral half) with exact-pinned installs;
  range advance moves to release time where it is reviewed.
- Emit one structured boot line naming active `package@version` + auth strategy.
- Document the composition seams (`OP_GUARDIAN_PACKAGE`/`OP_GUARDIAN_ENTRY`,
  `setAuthStrategy()`) as a downstream-distribution contract, not a core feature. Net: the
  entrypoint gets shorter.

### S.5 Guardian internal listener: authenticate `/stats`

*(rev4-F5)*

`/stats` returns the full principal roster + rate-limit config (`server.ts:44-79,108`) with no
auth, and the internal listener binds 0.0.0.0 by Bun default (`server.ts:183`) — reachable
from both bridge networks, a ready-made next-hop for anything that lands via S.6. Require the
admin token (the listener already has one for other routes) or bind explicitly to the
guardian-net interface; add a negative test.

### S.6 The addon-network trust boundary (the strongest confirmed attack-surface item)

*(rev4-F1, HIGH)*

`OPENCODE_AUTH:"false"` (`core.compose.yml:53`) + `opencode web --hostname 0.0.0.0`
(`assistant/entrypoint.sh:281`) + six addon services on `assistant_net`
(`services.compose.yml`) means any third-party addon image — ollama is unpinned
`ollama/ollama:latest` — sits inside the trust boundary with credential-free access to the
full OpenCode API. The compose comment at `core.compose.yml:50-52` records that the
upstream-auth hardening path was deliberately removed.

- Immediate, cheap: pin the ollama image (and any other unpinned addon images) by digest or
  exact version.
- Decision required (human): re-enable upstream OpenCode auth for on-net clients, or segment
  addons onto a network without assistant API reachability, or both. This is an architecture
  decision the maintainer must make; the plan's role is to force the decision with the
  verified facts above. Interim mitigation if deferred further: document loudly that enabling
  a third-party addon grants it full assistant access.

### S.7 Security-posture documentation corrections (carved out of 1.3)

*(rev8 Tier 1 D1–D4, D7, D12, D18, D21, D22; rev10-F5 security half; rev3-F4/F7)*

- Replace CLAUDE.md's fictional pipeline description ("HMAC, replay, rate limit…" at
  `CLAUDE.md:242`): real source is `packages/guardian/src/`, auth is HTTP Basic sha256 token
  compare (`auth.ts:77-99`), `replay.ts` does not exist. Remove the vestigial HMAC/nonce
  comments in `proxy.ts`/`oc-bounds.ts` (rev3-F7).
- Port table, with the security-pass extras: guardian publishes 3830/3831/3820/3821 (not
  "internal only"); chat 3820 and api 3821 both map to the same internal listener **8182**
  (`portals.compose.yml:125,130-131`); voice internal is **8880**, not 8186; the 8080
  internal-port cell was verified correct — keep it.
- `OP_ALLOW_REMOTE_SETUP` is an explicit opt-in, not "impossible under any configuration".
- Invariant-3 mount lists: `system/*` → `/etc/opencode`, `config/*` → `~/.config/opencode`,
  plus `/host-stash` (D7).
- Content-validation posture text per the S.3 decision; guardian-as-profile-gated-ingress
  (it lives in `portals.compose.yml`); assistant→Admin API auth path (D12); dead
  `ADMIN_TOKEN` reference (D18); assistant token docs (D22); guardian admin listener (D21).
- State plainly (rev3-F4): `x-openpalm-user` is trusted by construction — isolation is between
  principals, and a portal fronts many users under one token. That is a design property to
  document, not a bug to fix.

### S.8 Remaining guardian ingress hardening (lower severity)

*(rev3-F2 heuristic gaps, F5, F8)*

- `content-screen.ts` heuristic-table gaps and sub-threshold handling: extend the table; the
  3.4 unit test provides the harness.
- `rewrite` spreading non-`parts` fields (F5): whitelist the fields the rewrite copies.
- Global frames fanning out to direct principals (F8): scope frames per-principal.

**Part B exit gate:** fail-closed tests green on both openai-api edges and `/stats`; apply
path runs validation on the shipped stack without false positives; a fresh image boots with
no registry access; docs' security sections match `docker compose config` output.

---

# Appendix — Traceability: every finding → plan item

| Finding / cluster | Plan item |
|---|---|
| X1 armed snapshot never disarmed (R6-F2, R9-F1, R1-F7) | 0.2, 0.3 |
| X2 snapshot omits `state/stack.state.env` (R1-F7 corrected, R6-F4, R8-D9, R9-F5) | 0.3 |
| X3 documented auto-restore doesn't exist (R6-F1, R9-F1/S3, R8-D9) | 1.3 (doc fix; do not build auto-restore) |
| X4 state env shadows operator file (R1-F1, R8-D5/D6, R10-F6) | 1.3 (G-DOC framing), 1.4 |
| X5 phantom machinery + CI gate (R1-F8, R2-B9, R6-§3, R8-D8/D10, R10-F5) | 1.1, 1.3 |
| X6 moderation.md clobber (R6-F3, R8-D8) | 1.2 (decision owner assigned), 1.3 |
| X7 OpenAI edge fail-open (R3-F1, R10-F4) | **S.1** + standing constraint |
| X8 content-validation posture (R3-F2a, R8-D1) | **S.3** |
| X9 four compose drivers (R1-F4, R2-B1/B4, R10-F3) | 2.1, 2.2 |
| X10 spinner-glyph stderr scraping (R2-B2, R10-F3) | 2.1, 2.2 (`parseComposeStderr` ordering fixed) |
| X11 guardian boot-time npm assembly (R10-F1) | **S.4** |
| X12 thin-harness guards enumerative (R7-F1–F4) | 3.2 |
| X13 non-atomic env/secret writes (R9-F3, R6-F5) | 0.1 |
| X14 secret-strip drops values (R6-F5) | 0.1 |
| X15 ownership machinery (R2-B5, R9-F2, R1-F6) | 0.4 (urgent), 3.6 (gated) |
| X16 install lock (R9-F4, R2-B7) | 3.1 |
| X17 docs/AGENTS/CLAUDE rot (R8-D3–D23, R6-F11) | 1.3 (non-security), S.7 (security) |
| X18 manual install path (R1-F2, R10-F2) | 1.5 |
| X19 UI authority untested (R10-F2) | 3.4 |
| X20 setup wedge / pins outside boundary / single-sample health (R9-F5/F6) | 2.1 (all three halves; counter superseded) |
| R1-F3 self-updating control plane / R1-F5 normalization fragility / R1-F9 tool policy | 3.2 (guards), 2.2 (compose-config routing), S.2.3 |
| R2-B3 image scanner / B6 interpolation / B8 dual addon encodings / B10 minor | 2.1, 2.2, 2.2 (+R2-R8 guard), 3.5 |
| R3-F3 body-before-auth / F4 header trust / F5 rewrite spread / F6 dead flag / F7 stale comments / F8 global frames | S.1, S.7, S.8, 3.5, S.7, S.8 |
| R6-F6 auth.json restore + dir-delete / F7 silent prunes / F8 backup pruning / F9 EXDEV / F10 orphan semantics | 0.3 + 0.4 (log/backup), 1.3 (document, incl. SSH-key file touch), 0.4 (prune protection), 0.1 (atomic-write adjacency; verify EXDEV in same PR), 1.3 (document semantics) |
| R7-F4 fresh-seed gate (downgraded) / F5 release-order (corrected target) / F6–F8 | 3.2, 3.3, 1.3 + 3.2 |
| R9-F7 torn snapshot / S1–S6 scenario set | 0.3, covered across 0.x/2.1 |
| R10-F7 content-screen untested + artifact churn | 3.4, 1.6 |
| rev4-F1 addon net / rev4-F5 `/stats` / rev5-F1/F2 audit / G-SEAM | S.6, S.5, S.2, S.1 + standing constraint |
| Strengthened: dual pin writes / dist artifact / thin-harness script comments / D14 nuance / `--force` prunes backups | 1.4, 1.6, 1.3, 1.3 + S.4, 0.4 |
| Verification corrections #1–#10 | Applied inline at 0.3, 1.4/1.5, 2.2, 2.2, 3.6, 0.3, 3.2, 3.3, 1.2/2.1/2.2/3.1, 0.4 |

*Plan authored 2026-07-05 against `main@002b715b`. This document changes no source code; every
item names its smallest change and expected diff direction, honoring the project's subtraction
bias. Part B requires human sign-off on the S.1 posture, S.3 posture, and S.6 architecture
decisions before implementation.*
