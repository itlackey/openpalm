---
description: Run a comprehensive prerelease stabilization loop — inventory, build hygiene, code quality, testing, UX polish, and documentation — across six iterative passes to make the repo production-ready.
---

# Prerelease Stabilization Loop

## Objective

You are performing a comprehensive prerelease end-to-end repository cleanup, code quality improvement, and stabilization pass. Your goal is to ensure this solution is **production-ready, fully tested, proven to work consistently, and delivers a smooth user experience**.

Work in iterative passes. Each pass should focus on a specific layer of concern. Do NOT move to the next pass until the current one is clean. If you discover issues that cascade across passes, track them and revisit.

---

## Pass 1 — Inventory & Orientation

- Read every README, CHANGELOG, and config file at the project root.
- Map the full directory structure and understand the architecture.
- Identify all entry points, build scripts, test suites, and deployment artifacts.
- List all dependencies and their versions. Flag anything outdated, deprecated, or pinned to a pre-release version.
- Identify dead files, orphaned modules, unused assets, and leftover scaffolding that should not ship.
- **Deliverable:** Write a brief summary of the repo's current state and a prioritized punch list of everything that needs attention.

---

## Pass 2 — Build & Environment Hygiene

- Ensure the project builds from a clean clone with no manual steps beyond what is documented.
- Verify all environment variables, secrets placeholders, and config files are documented and have sensible defaults or `.env.example` entries.
- Remove or consolidate duplicate config (e.g., competing tsconfig files, redundant Docker stages, duplicate CI definitions).
- Ensure `.gitignore`, `.dockerignore`, and any ignore files are complete — no build artifacts, secrets, editor configs, or OS files leak into the repo.
- Lock dependency versions. Run a clean install and confirm no peer dependency warnings or resolution conflicts.
- **Deliverable:** A repo that builds cleanly on first try from documented instructions alone.

---

## Pass 3 — Code Quality & Consistency

- Run the project's linter and formatter. Fix all errors and warnings. If no linter/formatter is configured, set one up using the project's conventions.
- Eliminate dead code, commented-out blocks, TODO/FIXME/HACK comments (resolve them or file them as tracked issues and remove the inline noise).
- Normalize naming conventions, file organization, and import patterns across the codebase.
- Ensure consistent error handling — no swallowed errors, no bare `catch {}` blocks, no unhandled promise rejections.
- Review all `any` types, unsafe casts, and type suppressions. Replace with proper types wherever feasible.
- Remove all `console.log` debugging statements. Replace with proper structured logging where logging is appropriate.
- Ensure secrets, credentials, and sensitive values are never hardcoded.
- **Deliverable:** A codebase that is clean, consistent, and would pass a senior engineer's code review.

---

## Pass 4 — Testing & Verification

- Run the full test suite. Fix all failing tests. Remove tests for features that no longer exist.
- Identify critical paths that lack test coverage and write tests for them. Prioritize:
  - Core business logic and data transformations
  - API endpoints and their error responses
  - User-facing workflows end-to-end
  - Edge cases and boundary conditions in parsing, validation, and input handling
- Run the application end-to-end. Manually trace every user-facing flow:
  - Happy path — does it work as intended?
  - Error path — does it fail gracefully with clear feedback?
  - Edge cases — empty states, missing data, rapid interactions, unexpected input
- If integration or E2E tests exist, run them. If they don't and the project warrants them, scaffold the critical ones.
- **Deliverable:** A green test suite and documented proof that all primary user workflows function correctly.

---

## Pass 5 — User Experience Polish

- Review every user-facing surface (UI, CLI output, API responses, error messages).
- Ensure loading states, empty states, and error states are all handled — no blank screens, cryptic errors, or silent failures.
- Verify responsive behavior, accessibility basics (contrast, focus management, semantic markup), and performance (no unnecessary re-renders, no blocking operations on the main thread).
- Ensure all copy, labels, and messages are clear, consistent in tone, free of typos, and helpful.
- Check that navigation, routing, and deep linking all behave correctly including back/forward and refresh.
- Verify all external links, images, and assets load correctly.
- **Deliverable:** A user experience that feels intentional, polished, and trustworthy.

---

## Pass 6 — Documentation & Ship Readiness

- Update the README to accurately reflect the current state of the project: what it is, how to install, how to run, how to develop, how to deploy.
- Ensure all API endpoints or public interfaces are documented.
- Update or create a CHANGELOG entry for this release.
- Verify the version number is correct and consistent across all manifests (package.json, pyproject.toml, Cargo.toml, etc.).
- Confirm CI/CD pipelines are green and deployment scripts work.
- Do one final clean build and full test run from scratch.
- **Deliverable:** A repo that is ready to tag, release, and confidently hand to users.

---

## Operating Principles

- **Fix it, don't flag it.** If you can resolve an issue directly, do so. Only flag things that require human decisions (product direction, breaking API changes, license concerns).
- **Don't break what works.** Run tests after every meaningful change. If something breaks, fix it before continuing.
- **Prefer small, atomic changes.** Each fix should be isolated and understandable. Avoid sweeping refactors that change 50 things at once.
- **Be opinionated but pragmatic.** Apply best practices, but don't gold-plate. The goal is production-ready, not perfect.
- **Leave it better than you found it.** Every file you touch should be cleaner when you're done.

---

## Loop Behavior

After completing all six passes, do a final review of your punch list from Pass 1. Confirm every item is resolved. If anything remains, do a targeted cleanup pass. Then provide a concise **Release Readiness Report** summarizing:

1. What was cleaned up / fixed
2. What was added (tests, docs, config)
3. Any remaining known issues or decisions that need human input
4. Confidence assessment: is this ready to ship?