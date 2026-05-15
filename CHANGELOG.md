# Changelog

All notable changes to OpenPalm are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.0] - 2026-05-14

### Added

- **akm stash as the shared knowledge layer** — akm-cli 0.8.0 is now installed
  in the assistant and admin containers. A shared stash at `OP_HOME/data/stash`
  is mounted into both containers (`/home/opencode/.akm` for the assistant,
  `/akm` for admin). The guardian receives its own isolated stash at
  `OP_HOME/data/guardian-stash`.
- **Scheduler co-process inside the assistant container** — the standalone
  `scheduler` compose service has been removed. The scheduler now runs as a
  lightweight Bun co-process started by `core/assistant/entrypoint.sh` inside
  the assistant container. Trigger sentinel files continue to use
  `OP_HOME/data/scheduler/`.
- **Seeds in the akm stash** — built-in skills, commands, and agents that were
  previously baked into config directories are now seeded into the shared akm
  stash on first boot, making them immediately available to the assistant and
  admin OpenCode instance.
- **Periodic `akm improve` automation** — a new catalog automation runs
  `akm improve` on a schedule to continuously refine stash assets. Drop it into
  `config/automations/` to enable.
- **SSH addon overlay** — SSH port binding is now an optional addon
  (`stack/addons/ssh/`) rather than baked into the core compose file. Enable it
  only when needed.
- **Shared base image** — admin and assistant containers now share a common base
  image, reducing total image surface and keeping OpenCode versions consistent
  across containers.
- **`withAdminBody` route handler helper** — new typed request-body helper for
  admin API route handlers, replacing ad-hoc body parsing.
- **`askAssistant()` one-shot semantics** — the channels-SDK `askAssistant()`
  function now automatically deletes the OpenCode session after receiving a
  response. Pass `{ keepSession: true }` to retain the session across calls.

### Changed

- **Provider/model configuration uses `OP_CAP_*` capability env vars** —
  provider and model settings are now driven by `config/stack.yml` capabilities
  and written to `stack.env` as `OP_CAP_*` variables. No more env-schema
  validation files.
- **akm secret store replaces vault/user mirroring** — secrets from
  `vault/user/` are now surfaced through the akm secret store (Phase 1: UI
  visibility; Phase 2: full vault/user mirror removed). The akm secret store is
  the primary visibility and access mechanism for user secrets.
- **`opencode-providers.ts` split into focused modules** — provider logic
  reorganised into `providers-read`, `providers-write`, and `providers-dispatch`
  to reduce coupling and surface area per module.
- **Single-implementation interfaces converted to type aliases** — removed
  unnecessary interface indirection across packages; concrete types are used
  directly where only one implementation exists.
- **Channel SDK unified** — channel adapter internals consolidated;
  redundant abstractions removed.
- **`readUserVaultSync` removed** — replaced with the async `readUserVault`
  throughout. No synchronous vault reads remain in the hot path.
- **socat lmstudio proxy guard and documentation** — the socat injection in
  `core/assistant/entrypoint.sh` now includes an explicit guard and improved
  inline documentation explaining the 127.0.0.1:1234 → LMSTUDIO_BASE_URL
  proxy pattern.
- **CLI type assertions removed** — runtime coercions replaced with proper
  typed helpers; coercion helpers consolidated in admin.

### Fixed

- **Path traversal guard in assistant-client** — requests that escape the
  allowed path prefix are now rejected before reaching the assistant.
- **HMAC constant-time comparison in guardian** — timing-safe byte comparison
  is now enforced for all HMAC validation, closing a potential timing-oracle
  side channel.
- **Session cleanup ordering** — OpenCode session teardown now follows the
  correct dependency order, preventing resource leaks on shutdown.
- **argv-leak test coverage made unconditional** — secret-in-argv tests no
  longer require an opt-in environment flag; they run in all CI contexts.
- **`akm vault` secret operations use stdin** — secrets are passed to
  `akm vault` commands via stdin rather than command-line arguments, eliminating
  the risk of secrets appearing in process listings.

### Removed

- **Memory service** (`packages/memory`) — the Bun-based memory service and all
  OpenMemory integration have been deleted. Persistent memory and knowledge
  recall now live entirely in the shared akm stash.
- **`*.env.schema` files and varlock** — env-schema validation has been removed.
  Provider/model configuration migrated to declarative `OP_CAP_*` capability
  vars.
- **Standalone `scheduler` compose service** — replaced by the in-process
  scheduler co-process inside the assistant container.
- **OpenViking roadmap documents** — superseded project planning documents
  removed.
- **Dead code and dead exports** — unused functions, types, and barrel re-exports
  identified in the audit sweep have been deleted across all packages.
- **SSH port binding from core compose** — SSH is no longer exposed by default;
  use the `ssh` addon overlay to opt in.

### Security

- **HMAC constant-time compare** — guardian now uses timing-safe comparison for
  all channel HMAC validation, eliminating a timing-oracle attack surface.
- **Path traversal rejection** — assistant-client rejects requests that attempt
  to escape the allowed path prefix before forwarding to the assistant.
- **argv-leak prevention** — `akm vault` secret operations pass secrets via
  stdin; unconditional test coverage verifies no secrets appear in process
  arguments.

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
