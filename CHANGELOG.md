# Changelog

All notable changes to OpenPalm are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0-beta.9] - 2026-05-26

### Fixed

- **All CLI commands now guarantee exit code 1 on failure** — ten command
  `run()` handlers (`logs`, `restart`, `start`, `stop`, `status`, `update`,
  `automations`, `scan`, `rollback`, `uninstall`) were missing try-catch.
  Unhandled rejections could leave the process with exit code 0 in scripts and
  CI pipelines. Each handler now catches, prints the error message, and calls
  `process.exit(1)`.
- **`stack.yml` seed file stripped to `version: 2` only** — the repo-shipped
  seed contained a full `capabilities:` block (LLM provider, embedding model,
  memory config) that was removed in the capabilities-to-akm-config migration.
  The stale block was a documentation hazard and incompatible with the current
  `StackSpec` type.
- **CHANGELOG stale `OP_CAP_*` references corrected** — two lines in the
  `[0.11.0]` section described provider/model config as driven by `OP_CAP_*`
  env vars and `stack.yml` capabilities; updated to reflect that config now
  lives in `config/akm/config.json`.

## [0.11.0-beta.8] - 2026-05-26

### Fixed

- **npm `files` whitelist added to `packages/cli`** — the CLI package had no
  `files` field or `.npmignore`, so `npm publish` would have included `src/`,
  test files, and `playwright.config.ts`. Now limited to `bin/`, `dist/`, and
  `README.md`.
- **`install`, `update`, `uninstall` endpoints now return structured errors** —
  unhandled exceptions inside the serial-queue lifecycle callbacks previously
  fell through to a raw SvelteKit 500. Each handler now catches errors and
  returns `errorResponse()` with code `install_failed` / `update_failed` /
  `uninstall_failed`.
- **`@openpalm/lib` now exports `types` field** — TypeScript consumers using
  older toolchains that don't resolve via `exports` can now auto-discover types.

### Docs

- **`SECURITY.md` updated** — supported versions table now shows `0.11.x`
  (was `0.9.x`); stale reference to Caddy reverse proxy replaced with the
  current localhost-binding architecture.

## [0.11.0-beta.7] - 2026-05-26

### Security

- **`stack.env` now written with mode 0o600** — the system env file containing
  `OP_UI_LOGIN_PASSWORD` and HMAC secrets was created world-readable (0o644).
  It is now created with `0o600` and `chmodSync` is applied to enforce the
  permission on pre-existing files.

### Fixed

- **`opencode.jsonc` no longer overwritten on upgrade** — `config/assistant/opencode.jsonc`
  was in the managed-assets refresh list and would silently reset user-customised
  model/agent settings on every `openpalm update`. It is now seeded-only: written
  on first install (or when missing), never overwritten by the upgrade path.
- **Corrupt `stack.env` now backed up before silent discard** — `parseEnvFile`
  previously returned `{}` on any parse error, causing the next write to silently
  discard all existing env vars. It now copies the corrupt file to
  `stack.env.corrupt-<timestamp>` before returning empty.
- **UI tarball extraction clears stale build files** — `seedUiBuild` now removes
  and recreates `state/ui/` before extracting a downloaded tarball, preventing
  old build files from persisting across version changes.
- **Admin API error envelopes** — `stack-version`, `ui-version`, and `versions`
  endpoints now use `errorResponse()` consistently (matching the API contract)
  instead of raw `json({ error })` calls; `versions` also guards against a
  missing `stackDir` before setup completes.

## [0.11.0-beta.6] - 2026-05-26

### Fixed

- **`channel-api`: `forwardToGuardian` not a function** — all three API handlers
  (`/v1/chat/completions`, `/v1/completions`, `/v1/messages`) were calling a
  non-existent method and returning 502 for every request. Replaced with the
  correct `this.forward({ userId, text, metadata })` pattern from `BaseChannel`.
- **`channel-api`: userId not namespaced** — API channel was passing raw user
  values (`u1`, `api-user`) to the guardian without the required
  `${channel}:` prefix. External callers could accidentally collide with other
  channels. Fixed to `${this.name}:${rawUser}` in all three handlers.

### Added

- **"Enable Voice" toggle on Welcome step** — the one-click auto-mode path now
  includes a checkbox (off by default). When checked, the CPU voice addon is
  deployed on first boot (~2.4 GB download). When unchecked, voice is fully
  disabled (no browser fallback). Engine value is passed through directly so
  the Review step shows "Disabled" when unchecked.

## [Unreleased]

### Security

- **SEC-4: Setup routes restricted to localhost until setup completes** —
  `hooks.server.ts` now checks the TCP client IP on all `/setup` and
  `/api/setup/*` paths while `isSetupComplete()` is false. Remote clients
  receive a 403; this prevents a race where a remote actor reaches the
  unauthenticated first-run wizard before the owner does. Post-install
  re-runs (`/setup?rerun=1`) require admin auth and are not affected.

### Fixed

- **`readFileSync` missing import in `ui-assets.ts`** — `svelte-check` was
  reporting a TS error; added `readFileSync` to the `node:fs` import.
- **Silent error swallowing in setup wizard** — five `.catch(() => { /* ignore */ })`
  and `.catch(() => { /* fall through */ })` calls now log to `console.error`
  so wizard failures are visible in browser devtools without changing UX.
- **Port conflict message when Docker is unreachable** — system-check response
  now carries `portCheckReliable: boolean`; when false, the conflict hint reads
  "Docker is not running — start Docker and click Retry to confirm" instead of
  "Another program is using this port".

### Added

- **"Use recommended defaults" is now a true one-click auto-install path** —
  clicking the primary button on the Welcome step now completes setup without
  walking through Providers, Models, Voice, or Options:
  - If host providers were already detected (OpenCode running on the host),
    they are imported in the background (spinner: "Importing providers…") and
    the best model defaults are selected automatically.
  - If nothing is detected, the stack installs without a provider and the user
    can add one from the admin panel after first boot.
  - Voice defaults to browser TTS/STT; all other options use their defaults.

### Changed

- **README "Where things stand"** — updated to describe 0.11.0 as a refactor
  and simplification release; 0.12.x will focus on stabilization and hardening
  before v1.
- **`@openpalm/lib` and `@openpalm/channels-sdk` READMEs** — added Bun-only
  notice: these packages ship TypeScript source and require Bun.
- **CLI `_build_note`** — clarified that `prebuild` is npm-only and Bun does
  not run lifecycle hooks.

### Added

- **"System Check" wizard step (index 0)** — runs Docker + Compose v2 detection
  via `/api/setup/system-check`, with platform-specific install/start guidance
  and port-availability warnings. Blocks navigation forward until Docker is
  healthy. Suppresses port-conflict warnings in re-run mode (the running stack
  itself).
- **`FriendlyError` component + `friendlyError()` utility** — every wizard
  error site now maps raw API/network/Docker errors to user-actionable
  `{ title, body, hint, links }` cards. Applied to provider verification,
  setup-complete failures, deploy errors, and deploy-poll loss-of-contact.
- **DeployStep phased progress** — `phase` field surfaced through the
  deploy-status API and consumed by the UI: `writing-config → pulling-images
  → starting → ready`, with realistic ETA copy for first-time image pulls.
- **Wizard re-run from admin** — "Update Settings" in the admin overview links
  to `/setup?rerun=1`. The wizard pre-populates admin token, owner, image tag,
  host AKM toggle, LLM/embedding selections, voice fields, enabled addons, and
  channel credentials from the existing install. System Check still runs but
  doesn't block; auto-redirect on completion is skipped.
- **Electron update banner (notify-only)** — Electron checks the latest
  GitHub release on startup (5 s timeout, 6 h cache). When a newer version
  exists, env vars + a `contextBridge` API are injected into the UI; the new
  `UpdateBanner` component renders a dismissible banner with a download link.
  Dismissal persists per-version in `localStorage`.
- **Electron startup polish** — frameless splash window while `startUIServer`
  runs; main window shows only after the UI server reports ready. The window
  navigates directly to `/setup` or `/chat` based on `setupComplete` status,
  removing the `/` → redirect bounce on first run.
- **Electron auto-publish to GitHub releases** — `electron-builder.yml` now
  publishes installers (`.dmg`, `.exe`, `.AppImage`) to the GitHub release tag
  automatically via `--publish always` in CI.
- **Persistent install prefix (`/opt/persistent`)** — named volume
  `assistant-persistent` mounted into the assistant container; first on
  `$PATH`. Survives `--force-recreate` and image upgrades. Documented in
  `docs/operations/persistent-assistant-tools.md` along with optional
  Pattern 2 (apt manifest) and Pattern 3 (Dockerfile bake).
- **`/api/setup/complete` `dryRun` flag** — persist config without triggering
  a Docker deploy. Used by tests and any validation flow.
- **Cross-OP_HOME compose-project collision guard** — `startDeploy` refuses
  to deploy if existing containers in the same compose project belong to a
  different `OP_HOME`. Prevents the dev/host stacks from clobbering each
  other when both default to project name `openpalm`.
- **Distinct dev compose project name** — `OP_PROJECT_NAME=openpalm-dev`
  is seeded by `scripts/dev-setup.sh` so the dev stack can never collide
  with a production stack on the same machine.
- **README + setup-guide lead with the Electron download** — desktop app is
  the primary install path; the CLI is collapsed into an "Advanced / headless
  install" disclosure. Gatekeeper/SmartScreen first-launch notes added.
- **Assistant `openpalm.md` install-location matrix** — assistant now has
  explicit guidance on where to install tools (`$HOME`-based installers
  persist for free, `/opt/persistent` for prefix-style installs, `apt` for
  one-off session-only tools).

### Changed

- **`MANAGED_ASSETS` points at the v0.11 paths** — `core-assets.ts` now
  refreshes `config/assistant/opencode.jsonc`, `openpalm.md`, and `system.md`
  from `.openpalm/config/assistant/` (was the now-deleted
  `core/assistant/opencode/` directory).
- **`seedOpenPalmDir` always refreshes `state/registry/`** — system-managed
  registry overlays now update on every install/upgrade, fixing the case
  where stale addon overlays (e.g. an old discord overlay missing
  `DISCORD_BOT_TOKEN`) persisted through reinstalls.
- **`performSetup` enables addons end-to-end** — `addons: { discord: true }`
  in the wizard payload now calls `setAddonEnabled`, which copies the
  compose overlay AND generates `CHANNEL_<NAME>_SECRET` in `guardian.env`.
  Previously the addon was never enabled.
- **Provider verification error UX** — inline provider errors run through
  `friendlyError` so raw `Failed to fetch models (HTTP 401)` becomes
  "API key rejected — double-check the key and that it has access to the
  selected model".

### Removed (hard break — no migration path)

- **`core/assistant/opencode/`** — legacy assistant config location. Now lives
  solely at `.openpalm/config/assistant/`.
- **`ControlPlaneState.setupToken`** — field, generator, all test fixtures,
  and the `state.vitest.ts` "generates setupToken on each reset" test.
  Was unused everywhere outside tests.
- **`mirrorUserVaultToAkm()` and `migrateAndCleanupLegacyUserEnv()`** —
  no-op stubs "retained for API compatibility" alongside their call sites
  in `setup.ts` + `lifecycle.ts`, `MirrorResult` type, re-exports in
  `index.ts`, and their test `describe` blocks (~330 lines of test code).
- **Legacy planning artifacts** — `docs/technical/capability-injection.md`,
  `admin-simplification-plan.md`, `akm-capabilities-refactoring-audit.md`,
  `connections-simplification-plan.md`, `release-publish-remediation-plan.md`,
  `proposals/`.
- **`maybe_configure_lmstudio_provider()` in the assistant entrypoint** —
  superseded by OpenCode's auth.json + Connections tab provider management.
  `LMSTUDIO_BASE_URL` plumbing removed from `core.compose.yml`.
- **Commented-out legacy env block** — `core.compose.yml` no longer carries
  the `OP_CAP_*`, `LMSTUDIO_BASE_URL`, or `GOOGLE_APPLICATION_CREDENTIALS`
  commented placeholders.
- **Stale historical comments** — "Phase N of #388 (closes #406)" prefixes
  scrubbed from every active source file and replaced with current-state
  notes. `setup-token.txt` migration comments removed.
- **`release-e2e-test.sh` capability check** — checks for
  `config/akm/config.json` existence instead of `OP_CAP_LLM_PROVIDER` /
  `OP_CAP_LLM_MODEL` in `stack.env`.

### Versioning

- All workspace packages aligned at `0.11.0` (`@openpalm/assistant-tools`,
  `@openpalm/channel-api/discord/slack/voice` were on `0.10.x`).

## [0.11.0] - 2026-05-14

### Added

- **UI as a host process** — the bare `openpalm` command starts the
  SvelteKit UI directly on the host at `http://localhost:3880`. No UI
  container, no docker-socket-proxy. The setup wizard runs at `/setup`
  on first boot and auto-redirects there until setup is complete.
  Configurable via `OP_HOST_UI_PORT`; auth token in `OP_UI_TOKEN`.
- **`openpalm` smart default** — running the bare command detects state
  and does the right thing: bootstraps the install if not installed,
  starts the Docker stack if it's down, then runs the UI server in the
  foreground. There is no separate `admin`/`ui` subcommand.
- **akm stash as the shared knowledge layer** — akm-cli 0.8.0 is installed in
  the assistant container. The stash at `OP_HOME/stash/` is mounted at `/akm`
  and shared with the host-side UI process.
- **Scheduler co-process inside the assistant container** — the standalone
  `scheduler` compose service has been removed. The scheduler now runs as a
  lightweight co-process inside `core/assistant/entrypoint.sh`.
- **Seeds in the akm stash** — built-in skills, commands, and agents are seeded
  into `OP_HOME/stash/` on first install via the CLI embedded assets.
- **Periodic `akm improve` automation** — a catalog automation that runs
  `akm improve` on a schedule to continuously refine stash assets.
- **SSH addon overlay** — SSH port binding is now an optional addon
  (`config/stack/addons/ssh/`) rather than baked into the core compose file.
- **`withAdminBody` route handler helper** — new typed request-body helper for
  admin API route handlers, replacing ad-hoc body parsing.
- **`askAssistant()` one-shot semantics** — the channels-SDK `askAssistant()`
  function now automatically deletes the OpenCode session after receiving a
  response. Pass `{ keepSession: true }` to retain the session.

### Changed

- **Directory layout restructured** — the `OP_HOME` layout is now:
  - `config/stack/` — compose runtime: `core.compose.yml`, `stack.env`,
    `guardian.env`, `addons/`
  - `stash/` — akm knowledge; `stash/vaults/user.env` replaces `vault/user/`
  - `state/` — service-persistent data (replaces `data/`)
  - `cache/` — regenerable data (akm cache, rollback snapshots)
  - `workspace/` — shared `/work` mount
- **Provider/model configuration moved to `config/akm/config.json`** —
  `OP_CAP_*` env vars and `stack.yml` capabilities removed. No more env-schema files.
- **akm secret store replaces vault/user** — user secrets live in the akm
  `vault:user` store at `stash/vaults/user.env`. The assistant entrypoint
  sources this at startup; compose no longer passes it as `--env-file`.
- **`opencode-providers.ts` split into focused modules** — provider logic split
  into `providers-read`, `providers-write`, and `providers-dispatch`.
- **Single-implementation interfaces converted to type aliases** — unnecessary
  interface indirection removed across packages.
- **Channel SDK unified** — channel adapter internals consolidated.
- **`readUserVaultSync` removed** — replaced with async `readUserVault`.
- **socat lmstudio proxy** — `core/assistant/entrypoint.sh` now includes an
  explicit guard and documentation for the 127.0.0.1:1234 → LMSTUDIO_BASE_URL
  proxy pattern.

### Fixed

- **Path traversal guard in assistant-client** — requests escaping the allowed
  path prefix are rejected before reaching the assistant.
- **HMAC constant-time comparison in guardian** — timing-safe comparison for all
  channel HMAC validation, closing a potential timing-oracle side channel.
- **Session cleanup ordering** — OpenCode session teardown follows correct
  dependency order, preventing resource leaks on shutdown.
- **argv-leak test coverage made unconditional** — secret-in-argv tests run in
  all CI contexts without an opt-in flag.
- **`akm vault` secret operations use stdin** — secrets passed via stdin, not
  command-line arguments.

### Removed

- **Admin container** — `openpalm/admin` Docker image is gone. The UI runs
  as a host process via the bare `openpalm` command. `docker-socket-proxy`
  also removed.
- **`admin`/`ui` subcommand** — folded into the bare `openpalm` command.
  Use `openpalm --no-open` for headless invocation (systemd, scripts).
- **Shared `openpalm-base` Docker image** — inlined into
  `core/assistant/Dockerfile` since it was the only consumer. Removes the
  separate `build-base-image` CI job and the two-step `dev:build`.
- **Memory service** (`packages/memory`) — the Bun-based memory service and all
  OpenMemory integration deleted. Memory and knowledge recall now live in the
  shared akm stash.
- **`*.env.schema` files and varlock** — env-schema validation removed.
  Provider/model configuration migrated to `config/akm/config.json`.
- **Standalone `scheduler` compose service** — replaced by the in-process
  co-process inside the assistant container.
- **OpenViking roadmap documents** — superseded project planning documents
  removed.
- **Dead code and dead exports** — unused functions, types, and barrel re-exports
  deleted across all packages.
- **SSH port binding from core compose** — SSH is no longer exposed by default.

### Security

- **HMAC constant-time compare** — guardian uses timing-safe comparison for all
  channel HMAC validation.
- **Path traversal rejection** — assistant-client rejects path-escape requests.
- **argv-leak prevention** — `akm vault` secret operations pass secrets via
  stdin; unconditional CI test coverage verifies this.

## [0.9.0-rc2] - 2026-03-10

### Added

- **SvelteKit admin UI** — full rewrite of admin panel as a SvelteKit app with
  server-side rendering, typed API routes, and Svelte 5 runes.
- **Setup wizard** — browser-based first-boot wizard that walks through provider
  connection, channel selection, and stack startup.
- **Connection profiles** — named LLM provider configurations (`connections/profiles.json`)
  with assignment to system, embedder, and channel roles via the admin UI and API.
- **Bun-based memory service** — replaced the Python/mem0 memory backend with a
  lightweight Bun.js service using sqlite-vec for vector storage. Removes the
  Python runtime dependency entirely.
- **Channels SDK** (`packages/channels-sdk/`) — `BaseChannel` abstract class,
  HMAC crypto helpers, structured logger, and typed payload definitions for
  building channel adapters.
- **Channel adapters** — web chat (`channel-chat`), OpenAI-compatible API
  (`channel-api`), and Discord (`channel-discord`) channels, each running as a
  standalone Docker container.
- **Guardian** (`core/guardian/`) — Bun HTTP server enforcing HMAC verification,
  timestamp skew rejection, replay detection, and rate limiting on all channel
  ingress traffic.
- **Automation scheduler** — in-process Croner-based scheduler on the admin
  container. Drop a YAML file into `automations/` to schedule API calls, HTTP
  requests, or shell commands on a cron expression.
- **XDG directory model** — three-tier filesystem layout (CONFIG_HOME /
  DATA_HOME / STATE_HOME) following the XDG Base Directory Specification.
  CONFIG_HOME is user-owned and never overwritten by automatic lifecycle
  operations.
- **Docker socket proxy** — admin accesses Docker via `tecnativa/docker-socket-proxy`
  over an isolated network instead of mounting the socket directly. Eliminates
  socket permission and GID issues across Docker Desktop, OrbStack, Colima, and
  Podman.
- **CLI** (`packages/cli/`) — cross-platform CLI for setup, status, and stack
  management. Builds native binaries for Linux, macOS, and Windows via Bun.
- **One-line installer** — `setup.sh` (Mac/Linux) and `setup.ps1` (Windows)
  scripts that bootstrap the XDG directory tree, download core assets, generate
  an admin token, and start the stack.
- **Channel registry** — catalog of channel definitions in `registry/` bundled
  into the admin image. Channels are installed from the registry via API or by
  file-drop into CONFIG_HOME.
- **Assistant tools plugin** (`packages/assistant-tools/`) — OpenCode plugin
  providing stack management tools, memory integration, and operational skills
  to the assistant.

### Changed

- Admin API endpoints moved under `/admin/` prefix with `x-admin-token`
  authentication.
- Compose file uses `--env-file` flags instead of `.env` convention for
  explicit env file precedence.
- Memory API switched from REST to a filter-based query model
  (`POST /api/v1/memories/filter`) to work around upstream pagination issues.

### Security

- All channel traffic is HMAC-signed and validated by the guardian before
  reaching the assistant.
- Assistant container has no Docker socket access and communicates with the
  stack exclusively through the admin API.
- Admin panel and all dashboards are LAN-restricted by default (bound to
  `127.0.0.1`).
- Audit logging for admin operations (`admin-audit.jsonl`) and guardian
  requests (`guardian-audit.log`).

## [0.8.0] - 2026-01-15

### Added

- Docker Compose orchestration for core services (Caddy, admin, assistant,
  guardian, memory).
- OpenCode integration as the assistant runtime with project-scoped config.
- Basic admin API for container lifecycle management (start, stop, restart,
  pull).
- Python-based memory service using mem0 for conversation history and context
  recall.
- Channel system foundation with compose overlay and Caddy route discovery.
- Caddy reverse proxy with automatic LAN/public network segmentation.
- Initial XDG directory structure with CONFIG_HOME and DATA_HOME tiers.

[Unreleased]: https://github.com/itlackey/openpalm/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/itlackey/openpalm/compare/v0.9.0-rc2...v0.11.0
[0.9.0-rc2]: https://github.com/itlackey/openpalm/compare/v0.8.0...v0.9.0-rc2
[0.8.0]: https://github.com/itlackey/openpalm/releases/tag/v0.8.0
