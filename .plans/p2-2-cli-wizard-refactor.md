# P2-2 Implementation Plan: Refactor CLI Setup Wizard High-Complexity File

Date: 2026-03-24  
Backlog source: `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:294`

## Objective

Reduce complexity in `packages/cli/src/setup-wizard/wizard.js` while preserving current wizard behavior, API contracts, and CLI install flow.

Target outcome from backlog:
- Split wizard into state model, prompts, validators, and output renderers.
- Keep external CLI behavior unchanged.
- Improve testability and reduce FTA complexity concentration.

## Evidence and Current-State Baseline

Complexity finding:
- `packages/cli/src/setup-wizard/wizard.js` has FTA score `141.23` (`docs/reports/end-to-end-solution-review-2026-03-24.md:156`).

Why this file is high-risk to modify:
- It is a single ~2,230-line IIFE (`packages/cli/src/setup-wizard/wizard.js:14`, `packages/cli/src/setup-wizard/wizard.js:2230`) mixing:
  - state model (`packages/cli/src/setup-wizard/wizard.js:134`),
  - step navigation/rendering (`packages/cli/src/setup-wizard/wizard.js:201`, `packages/cli/src/setup-wizard/wizard.js:227`),
  - provider auth/network flows (`packages/cli/src/setup-wizard/wizard.js:593`, `packages/cli/src/setup-wizard/wizard.js:623`, `packages/cli/src/setup-wizard/wizard.js:661`),
  - model selection and payload assembly (`packages/cli/src/setup-wizard/wizard.js:1020`, `packages/cli/src/setup-wizard/wizard.js:1777`),
  - deploy polling and UI states (`packages/cli/src/setup-wizard/wizard.js:1936`, `packages/cli/src/setup-wizard/wizard.js:1969`, `packages/cli/src/setup-wizard/wizard.js:2030`, `packages/cli/src/setup-wizard/wizard.js:2063`).

High-coupling boundaries that must stay stable:
- Server embeds static wizard assets at runtime (`packages/cli/src/setup-wizard/server.ts:320`, `packages/cli/src/setup-wizard/server.ts:321`, `packages/cli/src/setup-wizard/server.ts:322`).
- HTML/DOM IDs used by JS and tests are fixed in `packages/cli/src/setup-wizard/index.html` (for example `#step-*` at `packages/cli/src/setup-wizard/index.html:30`, `packages/cli/src/setup-wizard/index.html:76`, `packages/cli/src/setup-wizard/index.html:99`, `packages/cli/src/setup-wizard/index.html:125`, `packages/cli/src/setup-wizard/index.html:141`, `packages/cli/src/setup-wizard/index.html:187`).
- Review parity currently requires both new and legacy review renders (`packages/cli/src/setup-wizard/wizard.js:1527`, `packages/cli/src/setup-wizard/wizard.js:1529`, `packages/cli/src/setup-wizard/index.html:200`).
- CLI install flow waits on wizard completion and pushes deploy status (`packages/cli/src/commands/install.ts:236`, `packages/cli/src/commands/install.ts:258`, `packages/cli/src/commands/install.ts:264`, `packages/cli/src/commands/install.ts:268`).

## Constraints (Authoritative and Quality)

- Keep implementation as thin tooling over existing runtime; do not introduce framework/build-pipeline complexity (`docs/technical/authoritative/core-principles.md:22`, `docs/technical/authoritative/core-principles.md:24`).
- Preserve control-plane behavior and security invariants (no ingress/auth/secret behavior changes through wizard refactor) (`docs/technical/authoritative/core-principles.md:55`).
- Keep modules small and single-responsibility (`docs/technical/code-quality-principles.md:5`, `docs/technical/code-quality-principles.md:19`).

Complexity callout:
- Adding a frontend framework, state library, or bundle step for this refactor is unjustified complexity for P2-2. The right change is decomposition of plain JS into focused modules while preserving no-build behavior.

## Extraction Plan (Phased)

## Phase 0 - Behavioral Baseline Lock

Before moving code, lock the existing behavior with characterization tests (no behavior edits).

1. Add payload characterization tests for current build behavior from `buildPayload()` (`packages/cli/src/setup-wizard/wizard.js:1777`) covering:
   - capability provider/model wiring,
   - optional `slm` handling (`packages/cli/src/setup-wizard/wizard.js:1868`),
   - channel credential extraction (`packages/cli/src/setup-wizard/wizard.js:1824`),
   - owner optionality (`packages/cli/src/setup-wizard/wizard.js:1873`).
2. Add characterization tests for step validation behavior:
   - step 0 identity/token checks (`packages/cli/src/setup-wizard/wizard.js:278`),
   - step 2 model gate (`packages/cli/src/setup-wizard/wizard.js:1225`),
   - step 4 channel credentials gate (`packages/cli/src/setup-wizard/wizard.js:1497`).
3. Preserve current legacy review-grid behavior used by e2e (`packages/admin/e2e/setup-wizard.test.ts:602`) until tests are migrated.

## Phase 1 - Introduce Wizard State and Constants Modules

Create focused modules under `packages/cli/src/setup-wizard/` and move constant/state initialization without changing behavior.

Proposed files:
- `wizard-constants.js`
  - move provider/group/model constants from `packages/cli/src/setup-wizard/wizard.js:21` to `packages/cli/src/setup-wizard/wizard.js:119`.
- `wizard-state.js`
  - own state shape + initialization currently spread around `packages/cli/src/setup-wizard/wizard.js:134` to `packages/cli/src/setup-wizard/wizard.js:181`.
- `wizard-dom.js`
  - move DOM helpers `$`, `show`, `hide`, `showError`, `hideError` from `packages/cli/src/setup-wizard/wizard.js:124` to `packages/cli/src/setup-wizard/wizard.js:128`.
- `wizard-utils.js`
  - move utilities `esc`, `generateToken`, `generateId`, `maskToken` from `packages/cli/src/setup-wizard/wizard.js:187`, `packages/cli/src/setup-wizard/wizard.js:193`, `packages/cli/src/setup-wizard/wizard.js:2132`, `packages/cli/src/setup-wizard/wizard.js:1744`.

Integration approach:
- Keep `wizard.js` as orchestration entrypoint initially, importing from extracted modules and preserving initialization order (`packages/cli/src/setup-wizard/wizard.js:2142`).

## Phase 2 - Extract Validators and Payload Assembler

Move pure logic first to maximize testability and minimize DOM risk.

Proposed files:
- `wizard-validators.js`
  - extract `validateStep0`, `validateStep2`, `validateStep4` from `packages/cli/src/setup-wizard/wizard.js:278`, `packages/cli/src/setup-wizard/wizard.js:1225`, `packages/cli/src/setup-wizard/wizard.js:1497`.
- `wizard-payload.js`
  - extract `buildChannelsConfig`, `buildPayload`, and hidden-field synchronization helper behavior from `packages/cli/src/setup-wizard/wizard.js:1753`, `packages/cli/src/setup-wizard/wizard.js:1777`, `packages/cli/src/setup-wizard/wizard.js:1208`.

Test advantage:
- These modules can be unit-tested with Bun without browser navigation, reducing dependence on long Playwright flows.

## Phase 3 - Extract Step Renderers and Prompt/UI Builders

Split rendering by step responsibility.

Proposed files:
- `wizard-progress.js`
  - extract `goToStep` and `renderProgressBar` from `packages/cli/src/setup-wizard/wizard.js:201`, `packages/cli/src/setup-wizard/wizard.js:227`.
- `wizard-step-providers.js`
  - extract Step 1 fallback/OpenCode renderers and provider event bindings from `packages/cli/src/setup-wizard/wizard.js:303` to `packages/cli/src/setup-wizard/wizard.js:975`.
- `wizard-step-models.js`
  - extract Step 2 builders/selectors from `packages/cli/src/setup-wizard/wizard.js:981` to `packages/cli/src/setup-wizard/wizard.js:1241`.
- `wizard-step-voice.js`
  - extract Step 3 voice rendering/default resolution from `packages/cli/src/setup-wizard/wizard.js:1247` to `packages/cli/src/setup-wizard/wizard.js:1337`.
- `wizard-step-options.js`
  - extract Step 4 channels/services rendering from `packages/cli/src/setup-wizard/wizard.js:1343` to `packages/cli/src/setup-wizard/wizard.js:1519`.
- `wizard-step-review.js`
  - extract Step 5 review renderers from `packages/cli/src/setup-wizard/wizard.js:1525` to `packages/cli/src/setup-wizard/wizard.js:1742`.

Important parity requirement:
- Keep both review implementations (`renderReview` + `renderReviewLegacy`) intact until admin e2e moves off `#review-grid` selectors (`packages/cli/src/setup-wizard/wizard.js:1527`, `packages/admin/e2e/setup-wizard.test.ts:602`).

## Phase 4 - Extract Network and Deploy Flow Handlers

Isolate side-effectful APIs and polling.

Proposed files:
- `wizard-api.js`
  - extract `apiFetchModels`, provider detection, and OpenCode auth/OAuth flows from `packages/cli/src/setup-wizard/wizard.js:2082`, `packages/cli/src/setup-wizard/wizard.js:2114`, `packages/cli/src/setup-wizard/wizard.js:593`, `packages/cli/src/setup-wizard/wizard.js:623`, `packages/cli/src/setup-wizard/wizard.js:661`.
- `wizard-install.js`
  - extract install/deploy orchestration from `packages/cli/src/setup-wizard/wizard.js:1885` to `packages/cli/src/setup-wizard/wizard.js:2076`.

Risk-sensitive behavior to preserve:
- verify generation anti-stale guard (`packages/cli/src/setup-wizard/wizard.js:932`),
- deploy poll error fallback to `--no-start` completion (`packages/cli/src/setup-wizard/wizard.js:1961` to `packages/cli/src/setup-wizard/wizard.js:1964`),
- retry path semantics on deploy error (`packages/cli/src/setup-wizard/wizard.js:2216`).

## Phase 5 - Asset Routing and Entry Wiring (only if needed)

Current server ships a single JS asset path (`/setup/wizard.js`) via embedded text import (`packages/cli/src/setup-wizard/server.ts:138`, `packages/cli/src/setup-wizard/server.ts:321`).

Preferred implementation to keep parity and avoid route churn:
- Keep `/setup/wizard.js` as stable entrypoint.
- Let `wizard.js` import extracted local modules (same directory) and keep `index.html` script tag unchanged (`packages/cli/src/setup-wizard/index.html:281`).

Fallback if import resolution causes runtime issues in Bun static serving:
- Add explicit static routes in `server.ts` for new module files and convert script tag to module form in `index.html`.
- This fallback is acceptable only if parity tests fail under the preferred approach.

## Behavioral Parity Strategy

Behavioral contract to freeze during refactor:

1. Wizard API endpoints unchanged:
   - `/api/setup/status`, `/api/setup/detect-providers`, `/api/setup/models/:provider`, `/api/setup/complete`, `/api/setup/deploy-status` as documented in header comments (`packages/cli/src/setup-wizard/wizard.js:8`) and served in `server.ts` (`packages/cli/src/setup-wizard/server.ts:154`, `packages/cli/src/setup-wizard/server.ts:165`, `packages/cli/src/setup-wizard/server.ts:177`, `packages/cli/src/setup-wizard/server.ts:204`, `packages/cli/src/setup-wizard/server.ts:240`).
2. DOM IDs and test selectors unchanged:
   - all `#btn-step*`, `#review-summary`, `#review-grid`, `#deploy-*` from `packages/cli/src/setup-wizard/index.html`.
3. Step navigation gates unchanged:
   - validation guards in progress-click and next-step flows (`packages/cli/src/setup-wizard/wizard.js:248`, `packages/cli/src/setup-wizard/wizard.js:2169`, `packages/cli/src/setup-wizard/wizard.js:2181`, `packages/cli/src/setup-wizard/wizard.js:2191`).
4. Setup payload shape unchanged:
   - root shape and `spec.version=2` from `buildPayload` (`packages/cli/src/setup-wizard/wizard.js:1846`) matching e2e assertions (`packages/admin/e2e/setup-wizard.test.ts:717`, `packages/admin/e2e/setup-wizard.test.ts:890`).
5. Deploy status UX semantics unchanged:
   - done and error states (`packages/cli/src/setup-wizard/wizard.js:2030`, `packages/cli/src/setup-wizard/wizard.js:2063`).

Implementation discipline for parity:
- Extract in small commits by concern (constants/state -> pure logic -> renderers -> side effects).
- After each extraction, run targeted tests before proceeding.
- Do not remove legacy review path until e2e selectors are migrated and validated.

## Test Plan

## A) Existing test suites to keep green

- Wizard server unit routes:
  - `packages/cli/src/setup-wizard/server.test.ts`
- Wizard server error scenarios:
  - `packages/cli/src/setup-wizard/server-errors.test.ts`
- Wizard server integration behavior:
  - `packages/cli/src/setup-wizard/server-integration.test.ts`
- UI flow and payload assertions:
  - `packages/admin/e2e/setup-wizard.test.ts`

## B) New tests to add for extracted modules

1. `packages/cli/src/setup-wizard/wizard-payload.test.ts`
   - table-driven payload snapshots for:
   - single provider + llm/embeddings,
   - separate `slm` provider,
   - channels with credentials,
   - owner optional fields omitted.
2. `packages/cli/src/setup-wizard/wizard-validators.test.ts`
   - validation error strings and pass/fail boundaries for steps 0/2/4.
3. `packages/cli/src/setup-wizard/wizard-state.test.ts`
   - provider state initialization invariants and verify-generation stale-response handling.
4. Optional targeted renderer tests (if practical with Bun DOM):
   - `wizard-step-review.test.ts` for preserving `#review-summary` and `#review-grid` content parity.

## C) Regression focus areas

- OpenCode availability fallback and provider rendering switch (`packages/cli/src/setup-wizard/wizard.js:709`).
- OAuth long-poll behavior and timeout message (`packages/cli/src/setup-wizard/wizard.js:688`).
- `--no-start` deploy completion behavior (`packages/cli/src/setup-wizard/wizard.js:1955`, `packages/cli/src/setup-wizard/wizard.js:2058`).

## Risk Controls

1. **State drift risk** (highest):
   - Control: centralize mutable wizard state in one module/factory; no duplicate local caches per renderer.
2. **DOM contract break risk**:
   - Control: preserve existing IDs/`data-*` selectors from `index.html` and e2e tests.
3. **Payload schema drift risk**:
   - Control: snapshot tests for `buildPayload()` before/after extraction.
4. **Async race regressions**:
   - Control: keep verify generation mechanism exactly (`packages/cli/src/setup-wizard/wizard.js:932`) and add unit tests for stale-result suppression.
5. **Legacy review compatibility risk**:
   - Control: keep `renderReviewLegacy()` active until e2e migration is complete (`packages/cli/src/setup-wizard/wizard.js:1646`).
6. **Unjustified architecture growth**:
   - Control: no new framework, no bundler, no new backend routes unless module serving requires it.

Rollback plan:
- Since this is structural refactor, rollback is straightforward by reverting extracted module introduction and restoring previous `wizard.js` composition. No data migration required.

## Verification Commands

From repo root `/home/founder3/code/github/itlackey/openpalm`:

1) CLI wizard/server tests
```bash
bun test packages/cli/src/setup-wizard/server.test.ts packages/cli/src/setup-wizard/server-errors.test.ts packages/cli/src/setup-wizard/server-integration.test.ts
```

2) Full CLI test suite
```bash
bun test --cwd packages/cli
```

3) Mocked wizard e2e (fast parity gate)
```bash
cd packages/admin && npm run test:e2e:mocked -- setup-wizard.test.ts
```

4) Project-required checks from delivery checklist
```bash
cd packages/admin && npm run check
```

```bash
cd core/guardian && bun test
```

5) Complexity verification (post-refactor)
```bash
bun run analysis:fta
```

Success criteria for complexity verification:
- `packages/cli/src/setup-wizard/wizard.js` drops materially from baseline 141.23 and extracted modules remain within maintainable ranges.

## Definition of Done for P2-2

- `packages/cli/src/setup-wizard/wizard.js` is reduced to orchestration-level complexity with concern-specific logic extracted.
- State model, validators, prompt/render builders, and install/deploy side effects live in separate focused modules.
- API contracts, DOM selectors, and payload shape are behaviorally equivalent to current flow.
- Existing wizard server and e2e tests pass, and new unit-level wizard module tests are in place.
- No new complexity is introduced beyond justified modular decomposition.
