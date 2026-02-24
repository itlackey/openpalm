# Changelog

All notable platform changes are documented in this file.

## [0.3.4] - 2026-02-24

### Fixed
- Update Qdrant image tag to use semantic versioning.

### CI/CD
- Migrate release and versioning workflows to Bun for dependency management and YAML parsing.

## [0.3.3] - 2026-02-24

### Changed
- Rename OpenAI facade channel to `channel-api`; fix CI typecheck breaks and align release/build wiring (#121).
- Remove `channel-api` service from the base docker-compose (it is now generated on demand).
- Refactor compose infrastructure to use a single shared compose runner (#122).
- Streamline test-ui workflow working directory configuration.
- Refactor testing workflows and enhance documentation for test tiers.

## [0.3.2] - 2026-02-23

### Fixed
- Stabilize publish-cli CI by relaxing brittle admin source path assertion (#118).

## [0.3.1] - 2026-02-23

### CI/CD
- Add reusable `test-ui.yml` workflow for Playwright E2E tests; fix missing `OPENPALM_DATA_ROOT` in E2E server env (#116).
- Align release workflow permissions with the reusable test-ui workflow requirements (#117).

## [0.3.0] - 2026-02-23

### Platform-wide
- Reorganized core services under `core/` and updated references across docs/build paths.
- Completed YAML-first stack configuration migration and removed JSON bridge compatibility layers.
- Moved runtime artifacts to state-rooted fallback assets with safer compose/caddy fallback behavior.

### Core services
- **admin**
  - Reorganized admin library modules for clearer `src` ownership.
  - Improved setup completion flow to start core services reliably.
  - Hardened compose runner runtime-env/path handling and healthcheck URL alignment.
- **gateway**
  - Updated paths and integration behavior after core directory migration.
  - Kept channel intake + routing aligned with v0.3 config/runtime layout.
- **assistant**
  - Updated core pathing and packaging references as part of core migration.

### Channels
- Updated credential management endpoints for chat, discord, telegram, voice, and webhook adapters.
- Updated channel build/runtime references to align with v0.3 directory and stack changes.

### Packages
- **lib/cli/ui**
  - Migrated root assets into embedded `lib`/`cli` resources.
  - Removed stale stack-spec bridge code and resolved schema validation regressions.
  - Fixed UI/server shared library pathing mismatches introduced during migration.

### Reliability and quality
- Addressed brittle build/test paths after rebase and stack migration.
- Fixed container healthchecks and integration URL expectations.

## [0.2.10] - 2026-02-23

### Changed
- Migrate stack editor UI and developer tooling from JSON to YAML (#107).
- Remove all remaining JSON stack spec references; stack editor now exchanges YAML text directly with the `/stack/spec` endpoint.

## [0.2.9] - 2026-02-23

### Fixed
- Allow unauthenticated local setup commands during the initial setup wizard (#104).
- Tighten setup command pre-auth skip condition: verify 401 setup status means completed before skipping (#105).

## [0.2.8] - 2026-02-23

### Fixed
- Fix admin image workspace dependency (`workspace:*`) resolution in CI Docker build (#102).
- Eliminate `workspace:*` sed hack from admin Dockerfile; use plain `bun install` with `createRequire` for yaml path resolution.
- Fix `opencode-ai` version pin in the assistant Dockerfile.

### Documentation
- Add comprehensive CI and test brittleness analysis report (#103).

## [0.2.7] - 2026-02-22

### Changed
- Migrate admin container to SvelteKit root UI routing (#101).
- Stabilize UI Playwright startup by building server output on demand.
- Gate Docker stack integration tests behind an explicit opt-in env var (`OPENPALM_RUN_DOCKER_STACK_TESTS`).
- Add Copilot agent instructions for the OpenPalm repository.

## [0.2.6] - 2026-02-22

### Changed
- Consolidate workflow test scripts into a single `test-workflows.sh` file.
- Add pre-push workflow testing instructions to developer documentation.
- Update package names and versions for consistency across CLI and Docker workflows.
- Add hostname-based Caddy routes for core containers.

## [0.2.5] - 2026-02-22

### Changed
- Move core service aliases to `/services/*` routes and document legacy `/admin` route cleanup (#99).

### Fixed
- Fix CLI publish workflow to avoid `workspace:` protocol failures in npm publish.

## [0.2.4] - 2026-02-22

### Fixed
- Run admin and gateway containers as non-root to prevent bind-mount file permission issues.
- Recursively `chown` `/config` and `/state` in the admin entrypoint.
- Enhance install scripts to detect and write `OPENPALM_UID`/`OPENPALM_GID`.

### Tests
- Enhance Docker integration tests and update CLI versioning logic.
- Implement Bun.YAML parsing for automation snippets.

## [0.2.3] - 2026-02-22

### Changed
- Enforce `--frozen-lockfile` in all CI workflows and add a pre-commit hook that blocks commits when `bun.lock` is stale.

### Fixed
- Standardize auth error responses across the admin API.

## [0.2.2] - 2026-02-22

### Fixed
- Add `skipLibCheck` to tsconfig to resolve `bun-types` declaration errors (#95).
- Resolve 36 test failures and 10 Playwright load errors (stack spec version assertion, .pw.ts rename, `describe.skipIf` guards).
- Add `composeExec` timeout and skip Docker-dependent tests gracefully in CI.

## [0.2.1] - 2026-02-22

### Fixed
- Repair CLI release pipeline: fix binary builds, add SHA256 checksums, remove unsupported `bun-windows-arm64` target (#94).

### Tests
- Implement comprehensive Playwright E2E tests for admin API and UI (health, auth, setup, stack, secrets, automations, channels).

## [0.2.0] - 2026-02-22

### Added
- Initialize `packages/ui` SvelteKit project with Playwright testing setup.
- Add logger utility for structured logging across services.
- Implement comprehensive gateway HTTP pipeline and payload validation tests.
- Add integration tests for admin authentication and health checks.
- Add contract tests for the setup wizard gate.

### Changed
- Migrate stack specification format to YAML (`openpalm.yaml`).
- Update docker-compose and stack generator to use `assistant_net` for service networks.
- Refactor preflight checks and required directory handling.
- Add `batch upsertEnvVars` function to lib for efficient env file updates.

## [0.1.0] - 2026-02-21

### Added
- Add `system.env` for managing system-derived state values; inject into admin and gateway containers.
- Add `packages/lib/docs/specification.md` — detailed stack generation pipeline reference (#88).

### Changed
- Reorganize docs: move to `admin/docs/` and `dev/docs/`; add per-service and per-channel READMEs (#87).
- Fix CI: use repo root build context for admin and channel Docker images.

## [0.0.6] - 2026-02-21

### Added
- Add Playwright E2E tests for the setup wizard and admin navigation.

### Changed
- Simplify release versioning by removing `versions.json`; switch to manifest-based version lookup (#85).
- Refactor admin UI from a 4-page app to a single dashboard with stack spec editor, secrets editor, and setup wizard (#86).
- Enhance setup wizard with inline channel credential fields (Discord, Telegram, etc.).
- Reorder wizard steps: Welcome → AI Providers → Security → Channels → Access → Health.

## [0.0.5] - 2026-02-19

### Added
- Accessibility improvements: ARIA labels, focus trapping in modals, keyboard navigation skip-to-content link, larger touch targets for wizard steps.
- Documentation: add `backup-restore.md`, `upgrade-guide.md`, `troubleshooting.md`, `plugin-authoring.md`, and `docs/README.md` with suggested reading order.
- Developer experience: webhook channel admin management, community registry integration in the extension gallery, `example-greeter` agent extension.

### Fixed
- Hide hour picker when "Every hour" automation preset is selected.
- Verify admin token against server before saving to localStorage.

## [0.0.4] - 2026-02-19

### Added
- Introduce Connections and Automations concepts (replace Cron terminology with Automations).
- Add webhook channel service to docker-compose and admin UI.
- Add health-check and memory-query tools for OpenMemory integration.

### Changed
- Redesign admin UI with improved terminology and channel management (#55).
- First-run UX: promote `ANTHROPIC_API_KEY` and AI provider fields to a top-level wizard step; display admin token location in wizard and install output.
- Fix HMAC verification order in gateway to enhance security.

## [0.0.3] - 2026-02-19

### Added
- Implement OpenMemory HTTP pipeline plugin for memory recall and write-back.
- Add comprehensive API reference (`api-reference.md`) and testing plan (`testing-plan.md`).
- Add pre-flight checks script (`preflight.ts`) to verify required directories and files at startup.

### Tests
- Add layered test suites with exported test seams for controller and channel adapters (#47).

## [0.0.2] - 2026-02-19

### Added
- Initial Docker Compose setup for all OpenPalm services (Caddy, PostgreSQL, Qdrant, OpenMemory, OpenCode, Gateway, Admin, channel adapters).
- Externalize OpenCode extensions from the container image; seed to host config directory during install and volume-mount at runtime (#45).
- Integrate OpenMemory dashboard via Caddy routing.
- Add uninstall scripts for PowerShell (`uninstall.ps1`) and Bash (`uninstall.sh`).
- Add `host-system-reference.md` documenting the XDG directory layout and files created by the installer.
