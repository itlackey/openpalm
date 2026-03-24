# P1-5 Implementation Plan: start.sh Drift Cleanup (Post-Deletion)

Date: 2026-03-24  
Backlog item: `P1-5` in `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:215`

## Current State (Confirmed)

- `.openpalm/stack/start.sh` is already deleted (no file present in tree).
- The only `start.sh` currently present is `core/channel/start.sh` (channel image entrypoint), referenced by:
  - `core/channel/Dockerfile:41`
  - `core/channel/Dockerfile:42`
  - `core/channel/Dockerfile:57`
  - `core/channel/README.md:7`
- Therefore, P1-5 should now focus on cleanup of stale references and regression prevention, not script deletion.

## Remaining Drift Surface Inventory

## 1) Docs and reports still referencing deleted path

These references are mostly historical/audit context, but currently read like active guidance unless explicitly marked.

- `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:166`
- `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:178`
- `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:206`
- `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:215`
- `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:226`
- `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:231`
- `docs/reports/end-to-end-solution-review-2026-03-24.md:26`
- `docs/reports/end-to-end-solution-review-2026-03-24.md:113`
- `docs/reports/end-to-end-solution-review-2026-03-24.md:114`
- `docs/reports/end-to-end-solution-review-2026-03-24.md:130`
- `docs/reports/end-to-end-solution-review-2026-03-24.md:209`
- `docs/reports/end-to-end-solution-review-2026-03-24.md:228`

## 2) Roadmap cleanup notes with now-stale statements

These can cause confusion when used as implementation guidance.

- `.github/roadmap/0.10.0/cleanup/01.md:7`
- `.github/roadmap/0.10.0/cleanup/01.md:18`
- `.github/roadmap/0.10.0/cleanup/01.md:40`
- `.github/roadmap/0.10.0/cleanup/01.md:45`
- `.github/roadmap/0.10.0/cleanup/01.md:79`
- `.github/roadmap/0.10.0/cleanup/01.md:191`
- `.github/roadmap/0.10.0/cleanup/02.md:60`
- `.github/roadmap/0.10.0/cleanup/03.md:41`
- `.github/roadmap/0.10.0/cleanup/03.md:60`
- `.github/roadmap/0.10.0/cleanup/04-final.md:76`
- `.github/roadmap/0.10.0/cleanup/05.md:135`
- `.github/roadmap/0.10.0/cleanup/07.md:76`
- `.github/roadmap/0.10.0/cleanup/07.md:305`
- `.github/roadmap/0.10.0/cleanup/08.md:62`

## 3) Plan-doc drift inside `.plans`

- `.plans/p1-2-compose-arg-unification.md:8`
- `.plans/p1-2-compose-arg-unification.md:10`
- `.plans/p1-2-compose-arg-unification.md:192`
- `.plans/p1-2-compose-arg-unification.md:228`

These references are not inherently wrong, but they should be synchronized with P1-5 closure notes to prevent contradictory planning language.

## 4) Tests/scripts drift status

- No `.ts`/`.test.ts`/`.sh`/workflow references to `.openpalm/stack/start.sh` were found in active automation paths.
- CI currently validates compose manifests via `docker compose ... config -q` at `/.github/workflows/ci.yml:85` and `/.github/workflows/ci.yml:92`, but it does not explicitly guard against reintroducing `.openpalm/stack/start.sh`.

## Implementation Tasks

## A) Update docs/reports to clearly mark deletion as complete

1. In `docs/reports/end-to-end-remediation-backlog-2026-03-24.md`:
   - At `:215` section header and `:231` task list, add explicit status note that deletion is complete and remaining work is drift cleanup/guardrails.
   - Keep historical context, but rewrite acceptance bullets at `:237-239` as current-state plus guardrail outcomes.
2. In `docs/reports/end-to-end-solution-review-2026-03-24.md`:
   - At `:113-114` and `:130`, keep evidence text but add "resolved in repository state" note so readers do not treat it as pending work.

## B) Normalize roadmap notes to avoid stale implementation guidance

For each file in the inventory list above (`.github/roadmap/0.10.0/cleanup/*.md`), apply one of:

1. Add a short "Status (2026-03-24): completed" annotation adjacent to the old statement.
2. Or replace language from present tense ("supports") to historical tense ("previously supported").

Do not remove historical rationale; only remove ambiguity about current behavior.

## C) Add regression guardrails (tests/CI)

1. Extend `packages/lib/src/control-plane/cleanup-guardrails.test.ts`:
   - Add a test near the existing guardrail blocks (after `:223` section is a natural location) asserting `.openpalm/stack/start.sh` does not exist.
   - Add a narrow source-scan assertion that active control-plane source files do not reference `.openpalm/stack/start.sh`.
2. Add a lightweight CI assertion in `.github/workflows/ci.yml` after compose validation (`:85-93` region):
   - Fail if `.openpalm/stack/start.sh` exists.
   - Fail if non-report/non-roadmap active docs introduce imperative usage of deleted script.

Keep the guardrail simple and explicit; do not build a complex "drift scanner".

## D) Sync internal planning docs

1. Update `.plans/p1-2-compose-arg-unification.md` references listed at `:8`, `:10`, `:192`, `:228` to point to this P1-5 plan and current status.
2. Ensure wording across P1 plans consistently states:
   - deletion complete,
   - remaining work is canonical lib usage and drift prevention.

## Validation Plan

Run after edits:

1. Repo grep validation:
   - `grep` for `.openpalm/stack/start.sh` across active docs/scripts/tests to confirm only intentional historical mentions remain.
2. Guardrail and package tests:
   - `cd packages/lib && bun test`
   - `cd packages/cli && bun test`
   - `cd packages/admin && npm run check`
3. Security-critical baseline:
   - `cd core/guardian && bun test`
4. CI path validation locally (optional but recommended):
   - run workflow-equivalent compose validation command from `.github/workflows/ci.yml:92`.

## Acceptance Criteria (P1-5 Closure in Current State)

- `.openpalm/stack/start.sh` remains absent.
- Active operator docs do not direct users to deleted script.
- Historical reports/roadmap notes are explicitly marked as historical/resolved where they mention deleted script.
- Guardrail tests/CI checks prevent accidental reintroduction of deleted script path or active references.
- Existing quality gates remain green (`packages/admin` type-check, `core/guardian` tests, plus targeted lib/cli tests).

## Complexity Check

- Avoid introducing broad, generic drift tooling for this item; that would add unjustified complexity.
- Keep scope narrow: status annotation, reference cleanup, and one deterministic guardrail in tests/CI.
