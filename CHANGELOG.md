# Changelog

All notable changes to OpenPalm are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.1] - 2026-06-08

A macOS + setup-experience stabilization patch. No migration needed from 0.11.0.

### Changed

- **Desktop app ships as plain archives for the simplest unsigned install.** macOS
  is a `.app` `.zip` and Windows is a portable `.zip` (extract and run) instead of
  a `.dmg` / NSIS installer — removing the installer + Gatekeeper/SmartScreen
  install-time friction. macOS still shows a one-time prompt for unsigned apps
  (right-click → Open, or clear quarantine). Trade-off: the desktop app no longer
  auto-updates (it never could on unsigned macOS anyway) — re-download to update.

### Added

- **GPU-aware setup recommendation.** When setup starts with no provider
  configured, OpenPalm now detects host GPUs (VRAM-aware) and local providers and
  recommends the right path automatically: use a connected cloud provider; or
  auto-add a host Ollama/LM Studio that's already running; or, when a capable GPU
  (≥ 8 GB VRAM) is present, enable in-stack Ollama with the matching hardware
  profile; otherwise prompt to connect a provider (OpenCode flow or a custom
  OpenAI-compatible endpoint). (#453, #454)
- **Semantic embeddings work out of the box with no configuration.** The default
  local embedding model is pre-baked into the assistant image, so akm self-embeds
  offline on first run instead of silently falling back to keyword search. (#453)

### Fixed

- **macOS: app failed to launch from the Finder icon.** The desktop app now runs
  the UI server with its bundled Node and augments PATH, fixing the silent launch
  failure (terminal-only PATH). Added file logging to `~/Library/Logs/OpenPalm/`
  and a "Show Logs" tray item. (#456)
- **macOS: oversized menu-bar tray icon** is now correctly sized. (#455)
- **macOS/OrbStack: Ollama failed to start** ("access denied creating
  `data/ollama`"). The data dir is mounted at Ollama's native `$HOME/.ollama`
  path (no container mounts a generic `/data`), and pre-created bind-mount targets
  are owned by the operator UID. (#452)
- **Setup wizard dark mode** is readable again — the wizard inherits the app's
  themeable design tokens instead of a light-only stylesheet. (#451)
- **No more needless Ollama embedding config.** Enabling Ollama no longer writes
  an embedding config that overrode akm's local embedder. (#454)
- **Check-up: installing version `latest` failed** with a raw GitHub asset error.
  `latest` now resolves to the concrete newest release tag before fetching stack
  assets (or fails with a clear message). (#449)
- **"Update now" now recreates the guardian and channel containers** so channel
  adapters re-resolve their npm dist-tag packages and guardian picks up the new
  image. (#450)
- **Admin no longer re-prompts for the UI password with a valid session.** The
  session cookie is cookie-first with sliding renewal (httpOnly, Secure on HTTPS
  only so LAN installs still work). (#437)

## [0.11.0] - 2026-06-07

### Changed (BREAKING — automatic migration on upgrade)

The secrets/env filesystem layout was reorganized to align with the akm
`env` + `secret` asset model and to consolidate all env files and secrets out
of `config/stack/`. **`openpalm update` migrates an existing 0.10.x home
automatically** — it takes a full backup first, then copies your env/secret
files into the new locations (copy-only; your original `vault/` is left in place
as a recovery copy, with a `README.md` describing safe removal) and aborts with
no changes if the backup fails. **Upgrading from 0.10.x? Start with the
[0.10.x → 0.11.0 upgrade guide](docs/operations/upgrade-0.10-to-0.11.md)** (what
the migration does, file/env/port mapping, ordered procedure). The only manual
follow-up is re-adding provider API keys (Connections) and LLM/embedding config
(`config/akm/config.json`), whose formats changed.

- **akm `vault` → `env` + `secret`** — akm 0.8.0 removed the `vault` type
  (per-entry `vault set`/`unset` hard-error). The user-managed env moves from
  `vault:user` at `knowledge/vaults/user.env` to the akm **`env`** type
  `env:user` at `knowledge/env/user.env`. OpenPalm now owns the file directly —
  admin writes/deletes are atomic `.env` edits (mode 0600), no `akm vault`
  subprocess. The admin route `/admin/secrets/user-vault` is now
  `/admin/secrets/user-env` (`envRef: env:user`). gws-setup credentials move
  from `knowledge/vaults/.gws` to `knowledge/secrets/.gws`.
- **`config/stack/stack.env` → `knowledge/env/stack.env`** — the Compose
  `--env-file` (non-secret system config) joins the env files under
  `knowledge/env/` as `env:stack`.
- **`config/stack/auth.json` → `knowledge/secrets/auth.json`** — OpenCode
  provider credentials move out of `config/stack/`; `config/stack/` now holds
  only non-secret compose assembly (compose files + `stack.yml`).
- akm-cli is pinned to the stable **0.8.0** release (it provides the `env` +
  `secret` asset types).
- **`OP_ADMIN_PORT` → `OP_HOST_UI_PORT`** — the host admin/UI port env var was
  renamed and the legacy name is no longer emitted or read anywhere. The
  auto-migration renames it for you (in `knowledge/env/stack.env`); installs that
  never customized it simply pick up the default `3880`.
  `OP_ADMIN_OPENCODE_PORT` and `OP_GUARDIAN_PORT` were removed outright (emitted
  but never read; the guardian is network-only, no host port mapping).
- **`config/stack/stack.yml` is removed entirely** — stack composition + versions
  are consolidated into `knowledge/env/stack.env` as the single authoritative
  record: addon enablement is `OP_ENABLED_ADDONS` (was `stack.yml addons[]`), and
  versions are `OP_IMAGE_TAG` / `OP_LAYOUT_VERSION` / `OP_UI_VERSION`. The
  `capabilities:` block / `OP_CAP_*` are gone; LLM/embedding config lives in
  `config/akm/config.json`. The auto-migration converts `addons[]` →
  `OP_ENABLED_ADDONS` and deletes nothing.
- **Admin UI is now a host process** (`openpalm ui serve`, `@openpalm/ui` from
  npm), not a container. The `admin` container/service, `docker-socket-proxy`,
  and the Caddy reverse proxy are all gone — services bind localhost (LAN-first).
  Anything referencing an `admin` compose service or addon no longer applies.
- **`memory` (mem0/Python) and `scheduler` containers removed** — memory is
  handled through the akm knowledge tools and scheduling runs inside the
  assistant (`crond` + `akm tasks sync`).
- **Custom addon drops moved to the compose-profile model** — addon overlays
  under `config/stack/` activated via `--profile addon.<name>` (the old
  `registry/addons/<name>/compose.yml` layout no longer applies).

### Added

- **Rich channel UX (live streaming)** — the guardian runs a transparent OpenCode
  reverse proxy (`/oc`), so Discord/Slack/API channels stream assistant responses
  in real time with typing indicators and tool-activity reactions, plus opt-in
  fail-closed content moderation (heuristic screen → local OpenCode moderator).
- **Advanced chat view** — an embedded OpenCode web UI under a full-width
  navbar (Chat / Advanced / Admin).
- **Voice addon** — local speech (Kokoro TTS + faster-whisper STT) as an opt-in
  addon with CPU/CUDA compose profiles, a prebuilt model bundle, and out-of-band
  image publishing decoupled from the platform release.
- **Independent UI distribution** — the operator UI ships as `@openpalm/ui` on
  npm and is fetched + integrity-verified at runtime, versioned independently of
  the platform.
- **Host ↔ assistant knowledge sharing** — the host akm stash can be shared
  (symmetric, writable) with the assistant.
- **Automatic 0.10.x → 0.11.0 layout migration** — `openpalm update` / `install`
  (and a standalone `openpalm migrate [--dry-run]`) detect a 0.10.x home and
  migrate it to the `knowledge/env` + `knowledge/secrets` layout: full backup
  first, copy-only (originals retained, with a safe-removal `README.md` written
  into `vault/`), channel-secret split, `stack.yml addons[]` → `OP_ENABLED_ADDONS`,
  gated by `OP_LAYOUT_VERSION` and idempotent. Aborts safely (no changes) if the
  backup fails.
- **Desktop tray mic** — the Electron app supports push-to-talk voice recording
  from the system tray with updated shortcuts.

### Changed

- **OpenCode runtime bumped to 1.15.13** (assistant + admin tools).
- **Portal adapters are baked into the portal image**, and the OpenAI-compatible
  API is served by the guardian image.
- **Runtime env vars are `OP_`-prefixed** (e.g. `OP_TTS_*`, `OP_STT_*`,
  `OP_VOICE_*`) to avoid host-environment collisions.
- **Release pipeline consolidated** into a single coordinated, manually-dispatched
  `platform-release.yml` orchestrator (version-synced bump → ordered npm publish →
  Docker/CLI/Electron/voice → tag + GitHub release last; fail-safe, resumable).
  Auto-publish-on-merge triggers removed.
- **CI moved off the deprecated Node 20 actions runtime** to Node 24
  (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`,
  `actions/download-artifact`, `softprops/action-gh-release`).
- **Operator UI: server-side auth** — admin auth is enforced in the SvelteKit
  server hook with a dedicated `/login` route; the login screen no longer flashes
  on navigation and pages carry no client-side auth code.
- **Operator UI: standardized chrome + chat layout** — shared `IconButton` /
  `ToggleButton` components; the assistant + session selectors are drawers, with
  a persistent assistant/session side panel on large screens; centralized
  date/time formatting; session names OpenCode left as a default timestamp now
  render as a formatted date.

### Fixed

- **Stack upgrade no longer fails resolving the asset version** — the target
  release tag is passed explicitly into the core-asset download. It previously
  degraded to `"main"` when `@openpalm/lib` was bundled into the UI/electron
  (the `import.meta.url` package.json read does not resolve in a bundle), 404ing
  the compose files on both the release and raw URLs.
- **`/login` no longer redirects to a 404 after sign-in** — a stale post-login
  navigation target (`invalidateAll()` racing the redirect) sent the browser to
  `/undefined`; it now navigates to the originally-requested page.

## [0.11.0-beta.11] - 2026-05-29

### Changed

- **Assistant compose mounts simplified** — logs and lifecycle backups moved
  under `data/`, AKM cache/data share the backed-up `data/akm` runtime
  data, and `/opt/persistent` is documented as an escape hatch for global-prefix
  installs while `$HOME/.local/bin` remains the preferred install target.

### Fixed

- **Secret files now live under `stash/vaults/secrets/`** — Compose file grants,
  dev/release scripts, validation, and setup docs now use the stash-backed
  secret path instead of `config/stack/secrets/`, keeping assistant-readable
  secrets out of the general stack config tree.
- **First-run auth no longer auto-materializes an admin password** — secret
  bootstrap now leaves `OP_UI_LOGIN_PASSWORD` unset until setup explicitly
  writes it, so setup/login routes correctly preserve the unconfigured state.
- **Host OpenCode import now preserves model defaults** — host imports fill in
  `model`, `small_model`, and `disabled_providers` only when the destination
  config has not already set them, avoiding silent resets while still carrying
  forward useful defaults.

## [0.11.0-beta.10] - 2026-05-26

### Changed

- **Removed dead code left by the capabilities → akm migration** — `readStackSpec`
  dead import in `lifecycle.ts`, unused `stackSpecFilePath` export in `paths.ts`,
  `stackSpecPath` helper in `stack-spec.ts` (never called in production), and the
  unused `spec: StackSpec` parameter in `deriveSystemEnvFromSpec`. Stale wizard
  comment referencing `stack.yml capabilities.tts.provider` updated to reflect
  current stack.env path.

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

- **System-managed config files now written with restrictive modes** —
  `stack.env` and files under `config/stack/secrets/` are created with
  restrictive permissions, and `chmodSync` is applied to enforce permissions on
  pre-existing files.

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

## [0.11.0] - 2026-05-26

### Security

- **SEC-4: Setup routes restricted to localhost until setup completes** —
  `hooks.server.ts` now checks the TCP client IP on all `/setup` and
  `/api/setup/*` paths while `isSetupComplete()` is false. Remote clients
  receive a 403; this prevents a race where a remote actor reaches the
  unauthenticated first-run wizard before the owner does. Post-install
  re-runs (`/setup?rerun=1`) require admin auth and are not affected.
- **HMAC constant-time compare** — guardian uses timing-safe comparison for all
  channel HMAC validation.
- **Path traversal rejection** — assistant-client rejects path-escape requests.
- **argv-leak prevention** — `akm vault` secret operations pass secrets via
  stdin; unconditional CI test coverage verifies this.

### Added

- **"Use recommended defaults" is now a true one-click auto-install path** —
  clicking the primary button on the Welcome step now completes setup without
  walking through Providers, Models, Voice, or Options. If host providers were
  already detected (OpenCode running on the host), they are imported in the
  background and the best model defaults are selected automatically. If nothing
  is detected, the stack installs without a provider.
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
  channel credentials from the existing install.
- **Electron update banner (notify-only)** — Electron checks the latest
  GitHub release on startup (5 s timeout, 6 h cache). When a newer version
  exists, a dismissible banner is shown with a download link. Dismissal
  persists per-version in `localStorage`.
- **Electron startup polish** — frameless splash window while `startUIServer`
  runs; main window shows only after the UI server reports ready. The window
  navigates directly to `/setup` or `/chat` based on `setupComplete` status.
- **Electron auto-publish to GitHub releases** — `electron-builder.yml`
  publishes installers (`.dmg`, `.exe`, `.AppImage`) to the GitHub release tag
  automatically via CI.
- **`@openpalm/admin-tools-plugin` bundled in Electron** — the admin OpenCode
  plugin is now prebuilt and shipped as an Electron `extraResource` instead of
  resolving from npm. The plugin path is resolved from `process.resourcesPath`
  (packaged) or the workspace `dist/` directory (dev), with an npm name as a
  last-resort fallback. `@openpalm/admin-tools-plugin` added to platform
  manifests so it version-syncs with the rest of the release.
- **Persistent install prefix (`/opt/persistent`)** — named volume
  `assistant-persistent` mounted into the assistant container; first on
  `$PATH`. Survives `--force-recreate` and image upgrades.
- **`/api/setup/complete` `dryRun` flag** — persist config without triggering
  a Docker deploy. Used by tests and any validation flow.
- **Cross-OP_HOME compose-project collision guard** — `startDeploy` refuses
  to deploy if existing containers in the same compose project belong to a
  different `OP_HOME`. Prevents the dev/host stacks from clobbering each other.
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
- **UI as a host process** — the bare `openpalm` command starts the
  SvelteKit UI directly on the host at `http://localhost:3880`. No UI
  container, no docker-socket-proxy. The setup wizard runs at `/setup`
  on first boot and auto-redirects there until setup is complete.
  Configurable via `OP_HOST_UI_PORT`; operator password is stored in
  `config/stack/secrets/op_ui_login_password`.
- **`openpalm` smart default** — running the bare command detects state
  and does the right thing: bootstraps the install if not installed,
  starts the Docker stack if it's down, then runs the UI server in the
  foreground. There is no separate `admin`/`ui` subcommand.
- **akm stash as the shared knowledge layer** — akm-cli 0.8.0 is installed in
  the assistant container. The stash at `OP_HOME/stash/` is mounted at `/stash`
  and shared with the host-side UI process.
- **Scheduler co-process inside the assistant container** — the standalone
  `scheduler` compose service has been removed. The scheduler now runs as a
  lightweight co-process inside `containers/assistant/entrypoint.sh`.
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

- **`MANAGED_ASSETS` points at the v0.11 paths** — `core-assets.ts` now
  refreshes `config/assistant/opencode.jsonc`, `openpalm.md`, and `system.md`
  from `.openpalm/config/assistant/`.
- **`seedOpenPalmDir` always refreshes system-managed stack assets** — fixed
  compose files now update on every install/upgrade, fixing the case where
  stale overlays persisted through reinstalls.
- **`performSetup` enables addons end-to-end** — `addons: { discord: true }`
  in the wizard payload now calls `setAddonEnabled`, which copies the
  compose overlay AND generates the channel HMAC secret file under
  `config/stack/secrets/`.
  Previously the addon was never enabled.
- **Provider verification error UX** — inline provider errors run through
  `friendlyError` so raw `Failed to fetch models (HTTP 401)` becomes a
  user-actionable card.
- **README "Where things stand"** — updated to describe 0.11.0 as a refactor
  and simplification release; 0.12.x will focus on stabilization and hardening
  before v1.
- **`@openpalm/lib` and `@openpalm/channels-sdk` READMEs** — added Bun-only
  notice: these packages ship TypeScript source and require Bun.
- **Directory layout restructured** — the `OP_HOME` layout is now:
  - `config/stack/` — compose runtime: `core.compose.yml`, non-secret
    `stack.env`, file-based `secrets/`, `addons/`
  - `stash/` — akm knowledge; `stash/vaults/user.env` replaces `vault/user/`
  - `state/` — service-persistent data, logs, AKM cache/data, backups, rollback
  - `workspace/` — shared `/work` mount
- **Provider/model configuration moved to `config/akm/config.json`** —
  `OP_CAP_*` env vars and `stack.yml` capabilities removed. No more env-schema files.
- **akm secret store replaces vault/user** — user secrets live in the akm
  `vault:user` store at `stash/vaults/user.env`. It is not passed to Compose as
  an env-file; stack/service secrets live under `config/stack/secrets/`.
- **`opencode-providers.ts` split into focused modules** — provider logic split
  into `providers-read`, `providers-write`, and `providers-dispatch`.
- **Single-implementation interfaces converted to type aliases** — unnecessary
  interface indirection removed across packages.
- **Channel SDK unified** — channel adapter internals consolidated.
- **`readUserVaultSync` removed** — replaced with async `readUserVault`.

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

- **`containers/assistant/opencode/`** — legacy assistant config location. Now lives
  solely at `.openpalm/config/assistant/`.
- **`ControlPlaneState.setupToken`** — field, generator, all test fixtures,
  and the `state.vitest.ts` "generates setupToken on each reset" test.
  Was unused everywhere outside tests.
- **`mirrorUserVaultToAkm()` and `migrateAndCleanupLegacyUserEnv()`** —
  no-op stubs alongside their call sites in `setup.ts` + `lifecycle.ts`,
  `MirrorResult` type, re-exports in `index.ts`, and their test `describe`
  blocks (~330 lines of test code).
- **Legacy planning artifacts** — `docs/technical/capability-injection.md`,
  `admin-simplification-plan.md`, `akm-capabilities-refactoring-audit.md`,
  `connections-simplification-plan.md`, `release-publish-remediation-plan.md`,
  `proposals/`.
- **`maybe_configure_lmstudio_provider()` in the assistant entrypoint** —
  superseded by OpenCode's auth.json + Connections tab provider management.
  `LMSTUDIO_BASE_URL` plumbing removed from `core.compose.yml`.
- **Admin container** — `openpalm/admin` Docker image is gone. The UI runs
  as a host process via the bare `openpalm` command. `docker-socket-proxy`
  also removed.
- **`admin`/`ui` subcommand** — folded into the bare `openpalm` command.
  Use `openpalm --no-open` for headless invocation (systemd, scripts).
- **Shared `openpalm-base` Docker image** — inlined into
  `containers/assistant/Dockerfile` since it was the only consumer.
- **Memory service** (`packages/memory`) — the Bun-based memory service and all
  OpenMemory integration deleted. Memory and knowledge recall now live in the
  shared akm stash.
- **`*.env.schema` files and varlock** — env-schema validation removed.
  Provider/model configuration migrated to `config/akm/config.json`.
- **Standalone `scheduler` compose service** — replaced by the in-process
  co-process inside the assistant container.
- **Dead code and dead exports** — unused functions, types, and barrel re-exports
  deleted across all packages.
- **SSH port binding from core compose** — SSH is no longer exposed by default.
- **Stale historical comments** — "Phase N of #388 (closes #406)" prefixes
  scrubbed from every active source file. `setup-token.txt` migration comments
  removed.

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
- **Guardian** (`containers/guardian/`) — Bun HTTP server enforcing HMAC verification,
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
