# Docs Cleanup & Reconciliation Plan (0.13.0)

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

| Doc (shipped, historical) | Pinned by | What to do first |
|---|---|---|
| `docs/technical/electron-thin-harness-design.md` | `scripts/validate-thin-harness-boundary.sh` cites `§6.1, §6.6, §6.5/§5` | Inline the boundary rules the script enforces into the script header (or a short `docs/technical/thin-harness-boundary.md` spec), then the design doc is free. |
| `docs/technical/akm-host-assistant-integration-proposal.md` | `packages/lib/src/control-plane/akm-sources.ts:5` cites `§8` | Replace the `§8` comment with a 1–2 line inline summary of the rule, then archive the proposal. |
| `docs/technical/auth-and-proxy-refactor-plan.md` | **35 references** across `packages/`+`containers/` (D3/D6a/Phase labels used as named anchors) | Heaviest. Treat as effectively KEEP for now; only attempt if someone does a deliberate pass to convert the section labels into inline rationale. Low priority. |
| `docs/technical/ui-distribution-gap-analysis.md` | `packages/lib/src/control-plane/ui-assets.ts:593` cites `G1` | Replace the `G1` comment with the actual deferred-behavior note, then archive. |
| `docs/technical/deployment-upgrade-ux-review.md` | cross-linked from `core-principles.md` + `electron-thin-harness-design.md` | Repoint the cross-links (or drop them), then archive. |
| `docs/technical/openpalm-voice-addon.md` | `containers/voice/README.md` links it; doc describes a design **not shipped as written** (`data/registry/`, `enabled-addons.json` no longer exist) | Update `voice/README.md` to drop/replace the link; then either fix the stale parts or archive with a "historical / not-as-shipped" banner. |

> Rule of thumb: a doc is only safe to remove/move once `rg -F "<filename>"` and
> `rg "<section-label>"` return nothing outside the doc itself.

---

## KEEP — referenced by live code (do NOT remove)

These look like "old design docs" but are load-bearing references; leave in place:

- `docs/technical/portal-rich-ux-design.md` — cited by `containers/guardian/src/proxy.ts` (§2–§3).
- `docs/technical/multi-endpoint-session-ux.md` — 6 refs in chat/session code + tests.
- `docs/technical/network-partitioning-d5a.md` — cited by `network-partitioning.test.ts` as the spec.
- `docs/technical/foundations.md`, `design-intent.md`, `core-principles.md` — distinct layers (runtime contract / philosophy / rules), not duplicates. All keep.
- `docs/technical/api-spec.md`, `environment-and-mounts.md`, `opencode-configuration.md`,
  the `*-rules.md` and `*-principles.md` implementation guides — current reference.

---

## ARCHIVE-in-place (annotate, don't delete) once code pins are cleared

Add a one-line banner at the top — `> HISTORICAL: shipped in 0.12.0; kept as a design
record. Current behavior is authoritative in <X>.` — to:

- `electron-thin-harness-design.md`, `deployment-upgrade-ux-review.md`
- `akm-host-assistant-integration-proposal.md`, `akm-integration-implementation-plan.md`,
  `akm-and-build-simplification-proposals.md`
- `ui-distribution-gap-analysis.md`, `ui-independent-versioning-investigation.md`
- `consolidated-stack-env.md`
- `docs/operations/legacy-cleanup-0.11.0.md`

(Optionally relocate all of these under `docs/technical/history/` to physically separate
the archive from current reference — a bigger move; only if desired.)

---

## MERGE

- `docs/technical/testing-stack-in-isolation.md` → fold the port-offset table, the seed
  step, and the `docker compose` example into `docs/technical/testing-workflow.md`
  (a "Stack-in-isolation" subsection), then remove the standalone file. Both are
  contributor docs with genuine overlap; ~163 lines recovered.

---

## REMOVE (candidates needing a human sign-off, but no code pins)

- None outstanding beyond what 0.12.0 already removed. `local-ai-unified-container-plan.md`
  was intentionally **kept** — it is the design for the open 0.13.0 issue **#430**
  (forward-looking, not shipped). Revisit when #430 is closed.

---

## Roadmap archive

`.github/roadmap/0.10.0/**` and `.github/roadmap/0.11.0/**` (~9k lines) are an intentional
historical archive with **no** inbound refs from production code/tests — EXCEPT
`.github/roadmap/0.10.0/fs-layout.md`, which the migration code/tests rely on as the
0.9.x→0.10.x layout reference (**do not remove**). Decision: leave the roadmap tree as-is
(it is already segregated under `.github/roadmap/` and not user-facing). After 0.12.0
ships, move `.github/roadmap/0.12.0/{implementation-plan,remaining-work}.md` into the same
"closed milestone" status.

---

## Code residue tied to docs (separate from #490)

The portal adapters still log under the old service names (`createLogger("channel-discord")`,
`"channel-slack"`) — which is why `docs/technical/bunjs-rules.md` legitimately still shows
those names. Renaming the logger service IDs to `portal-discord`/`portal-slack` belongs with
the **#490** back-compat-removal cleanup (drop `CHANNEL_NAME`, `channel_lan`); update
`bunjs-rules.md` in the same change so doc and code stay in lockstep.

---

## Suggested order of execution (0.13.0)

1. Clear the 5 single-reference code pins (akm-sources `§8`, ui-assets `G1`,
   thin-harness script `§6.x`, voice/README link, deployment-ux cross-links).
2. Add `HISTORICAL` banners to the now-unpinned archive set.
3. Do the `testing-stack-in-isolation` → `testing-workflow` merge.
4. (Optional) relocate the archive set under `docs/technical/history/`.
5. Fold the logger-name rename + `bunjs-rules.md` update into the #490 cleanup.
6. Leave `auth-and-proxy-refactor-plan.md` (35 refs) for a dedicated pass or keep indefinitely.

Each step is independently shippable and revertable; none should be rushed into a release.
