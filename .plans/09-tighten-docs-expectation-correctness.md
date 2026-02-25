# Implementation Plan: Tighten Docs for Expectation Correctness (P2)

## Goal

Align user-facing documentation with the actual install/setup behavior and authentication terminology:

- Installer boots only bootstrap services first (`caddy` + `admin`).
- Full runtime services are applied and started during wizard completion.
- Initial credential language uses temporary admin token terminology (not "admin password").

Recommendation source: `dev/docs/install-setup-simplification-reliability-report-consolidated.md:335`.

## Baseline References

- Recommendation details and current mismatch notes: `dev/docs/install-setup-simplification-reliability-report-consolidated.md:337`, `dev/docs/install-setup-simplification-reliability-report-consolidated.md:343`, `dev/docs/install-setup-simplification-reliability-report-consolidated.md:344`.
- Existing user-facing mismatch in top-level docs: `README.md:49`, `README.md:50`.

## User-Facing Docs Requiring Wording Updates

1. `README.md`
   - `README.md:49` uses "secure admin password".
   - `README.md:50` says installer "starts all services".
   - `README.md:75` says "Everything is password-protected" (should be harmonized with token-backed admin auth wording).
   - `README.md:103` says "password auth" for Admin.

2. `docs/cli.md`
   - `docs/cli.md:61` says "Display admin password prominently".
   - `docs/cli.md:95` says "Print URL + admin password".
   - `docs/cli.md:151` still documents `setup.start_core` as a wizard flow step; this conflicts with simplified expectation that full runtime startup is tied to completion.

3. `core/admin/docs/admin-guide.md`
   - `core/admin/docs/admin-guide.md:26` says installer "starts all services".
   - `core/admin/docs/admin-guide.md:32` says "admin password from your .env file".
   - `core/admin/docs/admin-guide.md:57` labels credential as "Admin password" while `core/admin/docs/admin-guide.md:58` correctly references `x-admin-token`; terminology should be unified.

4. `core/admin/README.md`
   - `core/admin/README.md:23` says "Admin password is generated during install".
   - `core/admin/README.md:90` says "Generate admin password".
   - `core/admin/README.md:95` says user enters "admin password from .env".

## Docs Not Requiring This Specific Update (for scope clarity)

- `docs/security.md` uses token terminology consistently for Admin API (`docs/security.md:47`, `docs/security.md:49`, `docs/security.md:76`).
- `docs/concepts.md`, `docs/maintenance.md`, `docs/troubleshooting.md`, and `docs/host-system-reference.md` do not currently make the bootstrap-vs-full-runtime or admin password/token claims targeted by this recommendation.

## Precise Edit Plan

### 1) Standardize install/setup phase wording

- In `README.md:46`-`README.md:51`, rewrite the install flow bullets to explicitly state:
  - installer prepares state and starts bootstrap services (`caddy` + `admin`),
  - browser opens setup wizard,
  - wizard completion applies full stack and starts/verifies core runtime services.

- In `core/admin/docs/admin-guide.md:26`, replace "starts all services" with bootstrap-first wording and point full runtime startup to wizard completion.

- In `docs/cli.md:67`-`docs/cli.md:72` and flow tables (`docs/cli.md:149`-`docs/cli.md:156`), ensure phase wording consistently reflects:
  - Phase 2 = early UI access via bootstrap services,
  - setup completion = full runtime startup path.

### 2) Standardize token vs password terminology

- Replace user-facing references to "admin password" with "temporary admin token" where describing install-time credential emission:
  - `README.md:49`
  - `docs/cli.md:61`
  - `docs/cli.md:95`
  - `core/admin/docs/admin-guide.md:32`
  - `core/admin/docs/admin-guide.md:57`
  - `core/admin/README.md:23`
  - `core/admin/README.md:90`
  - `core/admin/README.md:95`

- Where plain-language UX still benefits from "sign in", use "admin token" explicitly in the same sentence to avoid ambiguity (for example: "Sign in using the temporary admin token from `.env` or installer output").

### 3) Remove/adjust stale setup command narrative in user docs

- In `docs/cli.md:151`, either:
  - remove `setup.start_core` from the user-facing setup step report, or
  - relabel it as implementation detail and clearly state user-visible success should be expected only at `setup.complete`.

Preferred wording for expectation correctness: keep user docs centered on authoritative completion behavior, not background/internal startup commands.

## Consistency Checks

Create a small terminology/style checklist and apply it to each edited file:

- "bootstrap services" always refers to `caddy` + `admin`.
- "core/full runtime services" refers to post-wizard stack (assistant, gateway, openmemory, openmemory-ui, postgres, qdrant, plus supporting services).
- "temporary admin token" is used for install-time credential; avoid "admin password" unless documenting a future UX that truly sets a password.
- `x-admin-token` header references match token terminology.
- No sentence claims installer alone starts full runtime.

## Docs Validation Steps

1. Phrase-scan for stale wording in user docs:
   - `rg -n "admin password|starts all services|Print URL \+ admin password|Display admin password" README.md docs core/admin`
2. Positive-scan for expected wording:
   - `rg -n "bootstrap|temporary admin token|wizard completion|full runtime" README.md docs/cli.md core/admin/docs/admin-guide.md core/admin/README.md`
3. Link and formatting sanity check:
   - Render/read modified markdown locally and verify no broken relative links in edited sections.
4. Optional repo markdown lint/check if available in project scripts.

## Acceptance Criteria

1. No edited user-facing doc claims installer "starts all services" before wizard completion.
2. Install-time admin credential is consistently labeled "temporary admin token" across the identified docs.
3. CLI/install flow descriptions consistently communicate bootstrap-first then full runtime completion.
4. Wording remains aligned with current behavior described in `dev/docs/install-setup-simplification-reliability-report-consolidated.md:335`-`dev/docs/install-setup-simplification-reliability-report-consolidated.md:346`.
