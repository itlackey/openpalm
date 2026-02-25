# OpenPalm Product Requirements Document (PRD)

## 1) Document Control

- **Product:** OpenPalm
- **Version:** 1.0 (living PRD)
- **Audience:** Product, engineering, design, DevOps, QA, docs
- **Primary objective:** Define complete functional and non-functional requirements for OpenPalm with emphasis on:
  1. **Ease of use**
  2. **Reliable installation and operations**
  3. **Extensibility** through channels, services, and extensions
  4. **Self-healing / self-maintaining** behavior through internal automations

---

## 2) Product Vision

OpenPalm is a local-first, container-orchestrated AI assistant platform that lets users install once, configure through a guided setup wizard, and operate a secure multi-channel assistant via a centralized admin control plane. OpenPalm should remain a thin wrapper around generated Docker Compose and Caddy artifacts, while keeping operational complexity hidden from end users.

The v1 MVP architecture is intentionally lean and lightweight: prioritize a small number of proven runtime paths, avoid custom orchestration complexity, and keep seams clean so additional features can be layered in later without reworking the core control plane.

### 2.1 Product Principles

1. **Simple by default:** one-command install, wizard-guided setup, sensible defaults.
2. **Secure by default:** private/LAN-first exposure, gateway-validated ingress, token-authenticated admin actions.
3. **Composable and extensible:** users can add channels, services, and OpenCode SDK extension integrations without rebuilding core.
4. **Operationally resilient:** automated health checks, repair loops, update jobs, and maintenance tasks.
5. **Transparent control plane:** surfacing runtime and Docker errors directly for diagnosability.
6. **Lean MVP foundation:** optimize for lightweight architecture now, with explicit extension seams for future growth.

---

## 3) Goals, Non-Goals, and Success Metrics

## 3.1 Goals

- Enable first-time users to install OpenPalm with minimal infrastructure expertise.
- Provide reliable setup and day-2 operations with Docker as the official runtime and OrbStack as secondary support.
- Offer secure multi-channel ingress while preserving a single validated path through Gateway.
- Support assistant capability expansion through OpenCode SDK extension points.
- Support extension of deployment via custom channels and internal services.
- Continuously maintain system health through built-in maintenance and automation cron jobs.

## 3.2 Non-Goals

- Replacing Docker Compose with a custom orchestrator.
- Allowing channels to bypass Gateway and call assistant directly.
- Turning maintenance internals into user-programmable infrastructure orchestration.
- Managing arbitrary enterprise IAM/SSO in current scope.

## 3.3 Success Metrics (Target)

- **Install success rate:** ≥ 95% on supported OS/runtime combinations.
- **Time to first successful setup:** ≤ 15 minutes (p50).
- **Bootstrap reliability:** Admin setup endpoint healthy within target timeout for ≥ 99% of successful installs.
- **Gateway enforcement:** 100% of channel traffic validated through signature + schema + rate limit pipeline.
- **Maintenance effectiveness:** automatic health job recovers failed core services in ≥ 95% of recoverable incidents.
- **Extensibility usability:** users can add/configure a supported channel from Admin UI or CLI without manual compose edits.

---

## 4) Users and Personas

1. **Solo builder / hobbyist**
   - Wants a private personal assistant with fast setup.
   - Prioritizes easy install, default safety, simple updates.

2. **Power user / AI tinkerer**
   - Wants OpenCode extension control and custom channel/service integrations.
   - Prioritizes flexibility, transparent configs, and runtime control.

3. **Small team operator**
   - Wants stable operations, observability, backups, and predictable upgrade/rollback.
   - Prioritizes reliability and maintainability.

---

## 5) Scope Overview

OpenPalm product scope includes:

- CLI-driven installation lifecycle and runtime operations.
- Setup wizard and admin control plane.
- Core services: admin, assistant runtime, gateway, caddy, memory/data services.
- Channel adapters (chat, discord, telegram, voice, webhook/API-class adapters as supported).
- OpenCode SDK-based extension model with OpenPalm core extensions and user-provided extension directories.
- Secrets/config/state management with XDG directory strategy.
- Built-in maintenance and user-defined automations.

---

## 6) High-Level System Context

### 6.1 Architecture Contract

- Channels receive platform-native events.
- Channels forward normalized payloads to Gateway only.
- Gateway validates and guards channel intake.
- Gateway dispatches approved requests to assistant runtime.
- Admin service owns stack orchestration and compose lifecycle operations.
- Shared config generation/validation belongs in common library code.

### 6.2 Configuration Contract

- **Intent config:** YAML-first stack intent (`openpalm.yaml`).
- **Secrets:** env-file based secret storage (`secrets.env`) with `${SECRET_NAME}` references.
- **Rendered artifacts:** generated compose/caddy/env runtime artifacts.
- **XDG paths:** separate data, config, and state homes.

### 6.3 Assistant extension contract (OpenCode SDK)

- Assistant runtime uses the OpenCode SDK and its built-in extension points.
- OpenPalm ships core OpenCode extensions inside the assistant container for secure-by-default baseline behavior.
- OpenPalm provides a configured host directory where users can add their own OpenCode-compatible extensions.
- Extension loading must preserve the lean v1 architecture by avoiding new orchestration paths.

---

## 7) Functional Requirements

## 7.1 Installation and Bootstrap (Ease of Use + Reliability)

### FR-1: One-command installer wrappers
- System SHALL provide bash and PowerShell installation paths that fetch CLI binary and delegate to `openpalm install`.

### FR-2: Runtime support and selection
- Installer SHALL support Docker as the official runtime.
- Installer SHOULD support OrbStack as a secondary runtime path.

### FR-3: Pre-flight validation
- Installer SHALL run pre-flight checks before provisioning:
  - available disk warning threshold
  - required port availability checks
  - container daemon reachability checks

### FR-4: Deterministic two-phase install
- System SHALL execute setup in two phases:
  1. setup/bootstrap artifact generation and minimal service start
  2. early admin UI availability for setup wizard completion

### FR-5: Secure token and env initialization
- Installer SHALL generate required secure tokens/passwords and persist canonical env state.

### FR-6: Idempotent setup behavior
- Installer SHOULD detect pre-existing stack state and guard against accidental destructive overwrite.

### FR-7: Setup-only ingress mode
- System SHALL generate minimal setup Caddy + compose artifacts to bring up admin setup safely prior to full stack render.

### FR-8: Setup wizard-driven full stack activation
- Setup completion SHALL apply stack intent, validate references and compose config, write artifacts, and start core runtime services.

### FR-9: Browser launch UX
- Installer SHOULD auto-open setup URL unless explicitly suppressed by option.

## 7.2 Admin Control Plane

### FR-10: Centralized management surface
- Admin UI SHALL provide pages for system status, service control, config editing, extension management, secrets, and automations.

### FR-11: Authenticated write operations
- All mutating admin operations SHALL require valid admin token.

### FR-12: Safe configuration editing
- Config editor SHALL enforce parse/validate/lint/atomic-write-with-backup workflow.
- Policy lint SHALL block unsafe permission widening in protected flows.

### FR-13: Service lifecycle operations
- Admin SHALL execute allowlisted compose lifecycle actions for approved services.

### FR-14: API for orchestration
- Admin SHALL expose API endpoints used by UI and CLI domain commands for service/channel/automation operations.

## 7.3 Channel Ingress and Communication Extensibility

### FR-15: Channel abstraction
- Platform SHALL support multiple channel adapters with channel-specific configuration and credentials.

### FR-16: Gateway-only ingress
- Channels SHALL send inbound traffic exclusively to Gateway for validation and dispatch.

### FR-17: Exposure controls
- Each channel SHALL support private/LAN/public exposure intent where applicable.

### FR-18: Per-channel setup UX
- System SHALL provide channel setup/configuration workflow with status visibility.

### FR-19: Signed intake
- Channel payloads SHALL be signed and verified before processing.

### FR-20: Payload validation and abuse controls
- Gateway SHALL validate payload shape/content, rate-limit users, and reject invalid or abusive traffic.

### FR-21: Auditability
- Gateway SHALL retain audit logs for accepted, denied, and failed channel actions.

## 7.4 Assistant Runtime and Extension Extensibility

### FR-22: Extension types
- Assistant SHALL use OpenCode SDK extension points as the primary extension model.

### FR-23: OpenCode extension lifecycle management
- Admin/CLI SHALL support managing OpenCode extension integrations required for runtime behavior.

### FR-24: Runtime safety boundaries
- Channel intake guardrail path SHALL process untrusted input in restricted agent context before full-assistant dispatch.

### FR-25: Core and user extension loading model
- System SHALL include bundled core OpenPalm extensions in the assistant container.
- System SHALL provide a configured host directory for user-provided OpenCode extensions.

## 7.5 Services Extensibility

### FR-26: Internal service model
- Platform SHALL allow internal-only service containers for assistant capability expansion.

### FR-27: Private-by-design services
- Services SHALL not require public exposure controls and remain internal network scoped by default.

### FR-28: Stack intent to runtime mapping
- System SHALL render runtime artifacts from declarative stack intent and enforce validation before apply.

## 7.6 Secrets and Configuration

### FR-29: Secret references in config
- Configuration fields MAY reference secrets by `${SECRET_NAME}` syntax.

### FR-30: Secret existence validation
- Stack apply SHALL fail fast when referenced secrets are missing.

### FR-31: Partitioned configuration files
- System SHALL separate generated system env, user-editable runtime config, and secrets to reduce misconfiguration/leak risk.

## 7.7 CLI and Operator Workflows

### FR-32: Lifecycle CLI
- CLI SHALL provide install/uninstall/update/start/stop/restart/logs/status operations.

### FR-33: Domain CLI
- CLI SHALL provide domain commands for service, channel, automation, and extensions.

### FR-34: API mode fallback
- CLI SHOULD support local compose execution and admin-API mode via environment-based configuration.

### FR-35: Development scaffolding
- CLI SHALL provide channel scaffolding helpers for extensibility workflows.

## 7.8 Automations and Self-Maintaining System

### FR-36: User-defined automations
- Users SHALL be able to create scheduled prompt automations with name, prompt, schedule, and enabled state.

### FR-37: Automation lifecycle controls
- Users SHALL be able to enable/disable, edit, run-now, and delete automations.

### FR-38: Session isolation
- Each automation run SHALL execute in an isolated session scope.

### FR-39: Dynamic automation pickup
- Cron host SHOULD detect automation payload changes without requiring service restart.

### FR-40: Built-in maintenance automations
- System SHALL run non-configurable internal maintenance jobs including:
  - image pull/restart loop
  - health checks and restart attempts
  - log rotation and retention
  - image pruning
  - best-effort security scanning
  - database maintenance
  - temp file cleanup
  - metrics snapshots with retention

### FR-41: Maintenance observability
- System SHALL persist maintenance logs to stable state path for troubleshooting/audit.

---

## 8) Non-Functional Requirements

## 8.1 Usability and UX

### NFR-U1: Onboarding clarity
- First install flow MUST provide explicit next steps and surfaced admin credential.

### NFR-U2: Guided completion
- Setup wizard MUST support progressive step completion and resumability while setup is incomplete.

### NFR-U3: Low cognitive load
- Common operations (status, restart, logs, channel setup, automation testing) SHOULD be available via UI and concise CLI commands.

## 8.2 Reliability and Availability

### NFR-R1: Compose validation boundary
- Runtime artifact generation MUST validate compose output before apply.

### NFR-R2: Fail-fast with actionable errors
- Docker/runtime failures MUST be surfaced directly with guidance; system MUST avoid opaque custom recovery layers.

### NFR-R3: Health monitoring
- Core services MUST be health-checked periodically by internal maintenance workflow.

### NFR-R4: Automated recovery
- Non-running core services SHOULD be restarted automatically when safe and detected by health jobs.

### NFR-R5: Install determinism
- Installer SHOULD avoid network dependency for config templates by using embedded templates.

## 8.3 Security and Privacy

### NFR-S1: Secure-by-default network stance
- Management and internal surfaces MUST default to private/LAN exposure unless explicitly widened.

### NFR-S2: Signed ingress
- Gateway MUST enforce HMAC signature verification for channel ingress.

### NFR-S3: Abuse protection
- Gateway MUST enforce per-user rate limiting and input validation.

### NFR-S4: Authenticated control plane
- Admin API and mutating operations MUST require admin token.

### NFR-S5: Least privilege orchestration
- Assistant MUST NOT require direct Docker socket access for orchestration; admin remains orchestrator boundary.

### NFR-S6: Secret handling
- Secrets MUST be stored separately from general config and referenced indirectly where possible.

## 8.4 Extensibility and Maintainability

### NFR-E1: Plugin-based capability growth
- New assistant capabilities SHOULD be addable through OpenCode SDK extension points without core control-plane redesign.

### NFR-E2: Channel/service modularity
- New channels/services SHOULD integrate through declared stack intent and generator pipeline.

### NFR-E3: Single orchestration path
- Platform MUST retain one compose-runner/orchestration path to reduce divergence and defects.

### NFR-E4: Config source of truth
- Intent config and generated runtime artifacts MUST remain clearly separated.

## 8.5 Portability and Environment Support

### NFR-P1: Runtime compatibility
- Product MUST support Docker as the official runtime.
- Product SHOULD support OrbStack as a documented secondary runtime.

### NFR-P2: XDG compliance
- Product MUST resolve and honor data/config/state directories and related overrides.

### NFR-P3: Cross-platform install entry points
- Product SHOULD provide install flows for Linux/macOS (bash) and Windows (PowerShell).

## 8.6 Observability and Diagnostics

### NFR-O1: Logs access
- Operators MUST be able to retrieve service logs by service name via CLI/compose.

### NFR-O2: Maintenance logs
- Internal maintenance output MUST be retained with bounded retention policies.

### NFR-O3: System status visibility
- Admin UI SHOULD expose service health/status summaries.

---

## 9) Detailed Requirement Mapping to Priority Themes

## 9.1 Ease of Use

- One-command install wrappers.
- Guided setup wizard with resumable steps.
- Admin UI for routine operations.
- Human-friendly channel and automation setup.
- CLI parity for operators preferring terminal workflows.

## 9.2 Reliable Installs

- Pre-flight checks and runtime validation.
- Setup-only bootstrap with health polling.
- Compose validation before full apply.
- Idempotent and guarded re-install behavior.
- Explicit troubleshooting and rollback paths.

## 9.3 Extensibility (Channels, Services, OpenCode Extensions)

- Modular channel adapters with per-channel config.
- Internal private service model for assistant capabilities.
- OpenCode SDK extension points with core-in-container defaults.
- User extension directory for OpenCode-compatible additions.
- Channel scaffolding command for development workflows.

## 9.4 Self-Healing / Self-Maintaining

- User-defined automations for proactive assistant behavior.
- Internal maintenance cron suite for platform health.
- Automated health probes and restart attempts.
- Routine image update/pull and cleanup cycles.
- Maintenance observability for audit and debugging.

---

## 10) User Experience Requirements

1. **Install UX:** User receives clear command, visible progress, explicit admin credential, and direct setup URL.
2. **Setup UX:** User completes profile, service instance keys, channel selection, access scope, and final activation in ordered steps.
3. **Operations UX:** User can observe system status and restart/log services from a single console.
4. **Channel UX:** User can enable and configure channels with clear status and exposure settings.
5. **Automation UX:** User can schedule recurring prompts, test immediately, and iterate safely.
6. **Error UX:** User receives raw runtime errors with contextual remediation hints.

---

## 11) Data and State Requirements

- System MUST persist three path classes:
  - data (databases/blobs)
  - config (intent/source-of-truth + secrets)
  - state (generated runtime artifacts, logs, and ephemeral operational state)
- Stack apply MUST be deterministic from intent + secrets + environment context.
- Automation definitions MUST be persisted as durable payload files in state.
- Setup completion state MUST be persisted and consulted for auth behavior during initial setup.

---

## 12) Operational Requirements

- Product MUST support backup/restore of data, config, and secrets.
- Product SHOULD support in-place upgrade by image pull + compose recreation.
- Product SHOULD support rollback via restore workflow.
- Product MUST provide uninstall workflows with optional data/image removal.

---

## 13) API and Interface Requirements

- Admin API SHALL be stable enough for first-party CLI and UI orchestration workflows.
- Setup endpoints SHALL enforce local/private access rules while setup is incomplete.
- Service control endpoints SHALL enforce service allowlist boundaries.

---

## 14) Acceptance Criteria (Release Gate)

A release is acceptable when all are true:

1. Fresh install succeeds on supported target environments with documented command path.
2. Setup wizard can complete from zero-state and starts full stack.
3. At least one channel can be enabled end-to-end through Gateway.
4. Plugin lifecycle actions (install/list/uninstall) succeed from admin or CLI.
5. User automation can be created, run-now executed, and observed.
6. Internal maintenance jobs execute on schedule and produce logs.
7. Health-check maintenance job restarts a deliberately stopped recoverable core service.
8. Backup and restore procedures are validated in test environment.
9. Security checks confirm token-authenticated admin writes and gateway ingress validation.

---

## 15) Risks and Mitigations

1. **Runtime diversity risk (Docker/OrbStack behavior differences)**
   - Mitigation: prioritize Docker-first paths and keep OrbStack compatibility documented and validated.

2. **Misconfiguration risk (secrets/config drift)**
   - Mitigation: secrets reference validation, partitioned env files, schema + policy lint.

3. **Public exposure risk**
   - Mitigation: private/LAN defaults, explicit exposure toggles, gateway protections.

4. **Extension safety risk**
   - Mitigation: OpenCode SDK extension boundary controls, core bundled extensions, and guarded channel-intake flow.

5. **Maintenance job side effects**
   - Mitigation: bounded schedules, logs, allowlisted operations, and explicit observability paths.

---

## 16) Open Questions / Future Enhancements

- Should enterprise auth providers (OIDC/SAML) be added to admin control plane?
- Should maintenance schedules become partially configurable with policy constraints?
- Should channel marketplace metadata be introduced for discoverability/one-click installs?
- Should SLO dashboards and alert routing be built into Admin by default?

---

## 17) Traceability Notes

This PRD is derived from current OpenPalm product and developer documentation and is intentionally implementation-aware so requirements remain testable against existing architecture, installer flow, and operational model.
