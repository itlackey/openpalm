# Docs Cleanup & Reconciliation Plan (0.13.0)

> **Execution status (2026-07-21): COMPLETE.** All actionable items below are
> done or done-previously; the one deliberately-deferred item
> (`auth-and-proxy-refactor-plan.md`, 35 refs) is still explicitly left as KEEP
> per this plan's own low-priority call. Status is annotated inline throughout
> using `[DONE]` / `[DONE-PREVIOUSLY]` / `[SKIPPED-OBSOLETE: reason]` /
> `[OUT OF SCOPE]` markers. This pass also predates-and-postdates the
> 2026-07-15 One-UI refactor (`docs/technical/architecture.md` replaced several
> UI-runtime docs); where a banner target below points at `architecture.md`
> instead of the doc this plan originally named, that is intentional —
> `architecture.md` is now the current authority for the post-One-UI app model.

Follow-up to the 0.12.0 release docs sweep. This tracks the remaining documentation
reconciliation that was **deliberately deferred** out of the 0.12.0 release because it
requires code changes (not just doc edits) and so carries more risk than a release
should absorb.

## Already done in 0.12.0 (for context)

- Completed the `channels → portals` terminology sweep across reference/technical docs
  and READMEs. Preserved legitimate "channel" uses (Discord/Slack platform channels,
  Slack API scopes, Electron IPC channels, release/dist-tag channels, and the
  back-compat identifiers still live in code).
- Fixed the broken README link (`docs/channels/…` → `docs/portals/…`) and a fictitious
  `channel_public` network reference in `managing-openpalm.md`.
- Removed 7 transient/shipped-design docs with **zero** inbound code/test/doc refs:
  `finish.md`, `STATUS-0.12.0.md`, `docs/setup-walkthrough.md`,
  `docs/technical/{setup-wizard-audit-0.11.3,setup-wizard-redesign,master-release-workflow-proposal,ui-dark-mode-plan}.md`.
- Pruned 41 orphaned `worktree-agent-*` local branches.

Corpus after that pass: ~123 tracked `.md` files (~29k lines).

---

## The core problem: docs pinned by code comments

Several historical design docs are fully shipped (pure history), but **code and scripts
cite them by section number as if they were named constants**. They cannot be removed or
moved until those references are inlined or repointed. This is the gating work — do it
FIRST, per doc, then the doc becomes free to archive/remove.

| Doc (shipped, historical) | Pinned by | What to do first | Status |
|---|---|---|---|
| `docs/technical/electron-thin-harness-design.md` | `scripts/validate-thin-harness-boundary.sh` cites `§6.1, §6.6, §6.5/§5` | Inline the boundary rules the script enforces into the script header (or a short `docs/technical/thin-harness-boundary.md` spec), then the design doc is free. | **[DONE]** Section-number citations replaced with self-contained rule text directly in the script's comments (top header + `ALLOWED_IMPORTS` block); the script no longer depends on the doc's live section numbers. Doc archived with a HISTORICAL banner pointing at `core-principles.md`. |
| `docs/technical/akm-host-assistant-integration-proposal.md` | `packages/lib/src/control-plane/akm-sources.ts:5` cites `§8` | Replace the `§8` comment with a 1–2 line inline summary of the rule, then archive the proposal. | **[DONE-PREVIOUSLY]** `akm-sources.ts` no longer cites `§8` (verified: no `§8` / filename match in the file). Doc archived with a HISTORICAL banner pointing at `core-principles.md` in this pass. |
| `docs/technical/auth-and-proxy-refactor-plan.md` | **35 references** across `packages/`+`containers/` (D3/D6a/Phase labels used as named anchors) | Heaviest. Treat as effectively KEEP for now; only attempt if someone does a deliberate pass to convert the section labels into inline rationale. Low priority. | **[SKIPPED-OBSOLETE: N/A — intentionally deferred, not obsolete]** Left as KEEP per this row's own instruction; not attempted this pass. |
| `docs/technical/ui-distribution-gap-analysis.md` | `packages/lib/src/control-plane/ui-assets.ts:593` cites `G1` | Replace the `G1` comment with the actual deferred-behavior note, then archive. | **[DONE-PREVIOUSLY]** `ui-assets.ts` no longer cites `G1` (verified: no `G1` / filename match in the file). Doc archived with a HISTORICAL banner in this pass — repointed to `architecture.md` (not the doc's original successor) because the doc analyzes the pre-One-UI Electron-shell + SvelteKit split, which the 2026-07-15 One-UI refactor superseded. |
| `docs/technical/deployment-upgrade-ux-review.md` | cross-linked from `core-principles.md` + `electron-thin-harness-design.md` | Repoint the cross-links (or drop them), then archive. | **[DONE]** Both cross-links annotated as pointing to historical material (`core-principles.md` now says "historical design record" / "historical; current install/update behavior is authoritative in `install-update-constitution.md`"; `electron-thin-harness-design.md`'s companion-review link now says "also historical"). Doc archived with a HISTORICAL banner pointing at `install-update-constitution.md`. |
| `docs/technical/openpalm-voice-addon.md` | `containers/voice/README.md` links it; doc describes a design **not shipped as written** (`data/registry/`, `enabled-addons.json` no longer exist) | Update `voice/README.md` to drop/replace the link; then either fix the stale parts or archive with a "historical / not-as-shipped" banner. | **[DONE-PREVIOUSLY]** `containers/voice/README.md` no longer references `openpalm-voice-addon.md`, `data/registry/`, or `enabled-addons.json` (verified). Not in this pass's archive-banner list (not one of the plan's 9 named ARCHIVE-in-place candidates below), so left untouched — a HISTORICAL banner on this doc is a reasonable future follow-up but was not part of the literal ARCHIVE-in-place list executed here. |

> Rule of thumb: a doc is only safe to remove/move once `rg -F "<filename>"` and
> `rg "<section-label>"` return nothing outside the doc itself.

---

## KEEP — referenced by live code (do NOT remove)

**[DONE — no action needed]** Re-verified 2026-07-21: all still exist and none were
touched by this pass.

These look like "old design docs" but are load-bearing references; leave in place:

- `docs/technical/portal-rich-ux-design.md` — cited by `containers/guardian/src/proxy.ts` (§2–§3).
- `docs/technical/multi-endpoint-session-ux.md` — 6 refs in chat/session code + tests.
- `docs/technical/network-partitioning-d5a.md` — cited by `network-partitioning.test.ts` as the spec.
- `docs/technical/foundations.md`, `design-intent.md`, `core-principles.md` — distinct layers (runtime contract / philosophy / rules), not duplicates. All keep.
- `docs/technical/api-spec.md`, `environment-and-mounts.md`, `opencode-configuration.md`,
  the `*-rules.md` and `*-principles.md` implementation guides — current reference.

---

## ARCHIVE-in-place (annotate, don't delete) once code pins are cleared

**[DONE 2026-07-21]** Added the `> HISTORICAL: shipped in 0.12.0; kept as a design
record. Current behavior is authoritative in <X>.` banner to all 9 files below. `<X>`
was resolved per-file to whatever doc is actually authoritative today (in two cases —
`ui-distribution-gap-analysis.md` and `ui-independent-versioning-investigation.md` —
that meant pointing at `architecture.md`/`release-architecture.md` rather than the doc
this plan implicitly assumed, because those two analyses were written against the
pre-One-UI Electron-shell + SvelteKit split that the 2026-07-15 One-UI refactor
superseded):

- `electron-thin-harness-design.md` → `core-principles.md`
- `deployment-upgrade-ux-review.md` → `install-update-constitution.md`
- `akm-host-assistant-integration-proposal.md` → `core-principles.md`
- `akm-integration-implementation-plan.md` → `core-principles.md`
- `akm-and-build-simplification-proposals.md` → `core-principles.md`
- `ui-distribution-gap-analysis.md` → `architecture.md` (post-One-UI; not the doc's original era)
- `ui-independent-versioning-investigation.md` → `release-architecture.md` + `architecture.md`
- `consolidated-stack-env.md` → `environment-and-mounts.md`
- `docs/operations/legacy-cleanup-0.11.0.md` → `core-principles.md`

Note: `consolidated-stack-env.md`'s own **Status** line says "IMPLEMENTED in 0.11.0",
so the banner's literal "shipped in 0.12.0" phrase is slightly imprecise for that one
file (it shipped in 0.11.0). Kept verbatim per this plan's exact wording rather than
special-cased — flagging here instead so a future editor can decide.

(Optionally relocate all of these under `docs/technical/history/` to physically separate
the archive from current reference — a bigger move; only if desired.) **[NOT DONE —
still optional/not attempted this pass, per the plan's own "only if desired."]**

---

## MERGE

- `docs/technical/testing-stack-in-isolation.md` → fold the port-offset table, the seed
  step, and the `docker compose` example into `docs/technical/testing-workflow.md`
  (a "Stack-in-isolation" subsection), then remove the standalone file. Both are
  contributor docs with genuine overlap; ~163 lines recovered.
  **[DONE 2026-07-21]** Folded the Port Isolation table, the `.dev-test/` seed step, and
  the `docker compose up -d` example into a new "Stack-in-Isolation (Manual Setup)"
  section in `testing-workflow.md` (placed after Tier 6, before Quick Reference).
  Deleted the standalone file. Confirmed via repo-wide grep that nothing besides this
  plan file referenced the old filename, so no repointing of inbound links was needed.

---

## REMOVE (candidates needing a human sign-off, but no code pins)

**[DONE — no action needed]** Re-verified 2026-07-21: still none outstanding.

- None outstanding beyond what 0.12.0 already removed. `local-ai-unified-container-plan.md`
  was intentionally **kept** — it is the design for the open 0.13.0 issue **#430**
  (forward-looking, not shipped). Revisit when #430 is closed.

---

## Roadmap archive

**[OUT OF SCOPE for this pass]** `.github/roadmap/**` is not under `docs/**` and was not
part of this execution pass's assigned scope (`docs/**`, the thin-harness script, and
this plan file). As of 2026-07-21, `.github/roadmap/0.12.0/{implementation-plan,
remaining-work}.md` still exist and have not been relabeled/moved to "closed milestone"
status — that remains open for whoever owns `.github/roadmap/` bookkeeping.

`.github/roadmap/0.10.0/**` and `.github/roadmap/0.11.0/**` (~9k lines) are an intentional
historical archive with **no** inbound refs from production code/tests — EXCEPT
`.github/roadmap/0.10.0/fs-layout.md`, which the migration code/tests rely on as the
0.9.x→0.10.x layout reference (**do not remove**). Decision: leave the roadmap tree as-is
(it is already segregated under `.github/roadmap/` and not user-facing). After 0.12.0
ships, move `.github/roadmap/0.12.0/{implementation-plan,remaining-work}.md` into the same
"closed milestone" status.

---

## Code residue tied to docs (separate from #490)

**[DONE-PREVIOUSLY]** Re-verified 2026-07-21: the portal adapters now log under
`createLogger("portal-discord")` / `createLogger("portal-slack")` (asserted by
`packages/lib/src/control-plane/dead-surface-cleanup.test.ts`), and
`docs/technical/bunjs-rules.md:96` already documents the `"portal-discord"`/
`"portal-slack"` names. No `channel-discord`/`channel-slack` logger names remain
anywhere in `packages/` or `containers/`. This landed ahead of (or as part of) #490;
no further doc/code action needed here.

The portal adapters still log under the old service names (`createLogger("channel-discord")`,
`"channel-slack"`) — which is why `docs/technical/bunjs-rules.md` legitimately still shows
those names. Renaming the logger service IDs to `portal-discord`/`portal-slack` belongs with
the **#490** back-compat-removal cleanup (drop `CHANNEL_NAME`, `channel_lan`); update
`bunjs-rules.md` in the same change so doc and code stay in lockstep.

---

## Suggested order of execution (0.13.0)

1. Clear the 5 single-reference code pins (akm-sources `§8`, ui-assets `G1`,
   thin-harness script `§6.x`, voice/README link, deployment-ux cross-links).
   **[DONE — akm-sources `§8` and ui-assets `G1` were DONE-PREVIOUSLY; voice/README
   link was DONE-PREVIOUSLY; thin-harness script `§6.x` and deployment-ux cross-links
   DONE in this pass.]**
2. Add `HISTORICAL` banners to the now-unpinned archive set.
   **[DONE in this pass — see ARCHIVE-in-place above.]**
3. Do the `testing-stack-in-isolation` → `testing-workflow` merge.
   **[DONE in this pass — see MERGE above.]**
4. (Optional) relocate the archive set under `docs/technical/history/`.
   **[NOT DONE — optional, not attempted.]**
5. Fold the logger-name rename + `bunjs-rules.md` update into the #490 cleanup.
   **[DONE-PREVIOUSLY — verified landed; see Code residue above.]**
6. Leave `auth-and-proxy-refactor-plan.md` (35 refs) for a dedicated pass or keep indefinitely.
   **[SKIPPED-OBSOLETE: N/A — intentionally left as KEEP, not obsolete, per this row.]**

Each step is independently shippable and revertable; none should be rushed into a release.
