# Issue #304 - Brokered admin-authorized OpenCode instance inside the admin container

## Scope

Implement roadmap phases 1-2 for issue #304: add an admin-side OpenCode runtime that is reachable only through admin APIs, is authorized as an admin client of the Admin API, and is limited to diagnostics/configuration-help flows first. This work must preserve the existing control-plane and isolation model: no Docker/socket bypass, no direct privileged shell contract, no new public ingress, and no violation of assistant isolation.

## Dependency summary

- Depends on #300 Phase 1 auth split landing first so `ADMIN_TOKEN` and `ASSISTANT_TOKEN` are distinct across admin, assistant, guardian, and scheduler.
- Must follow the lib-first rule: reusable control-plane logic belongs in `packages/lib/`, with admin route handlers as thin consumers.
- Must align with the 0.10.0 filesystem/port changes, especially `~/.openpalm/`, the vault boundary, and `3881` for the admin OpenCode runtime.
- Must preserve the design decision that this is Admin-API-authorized, not system-authorized: authority comes from authenticated admin endpoints, not container placement.

## Non-goals for phases 1-2

- No direct Docker access from the brokered runtime.
- No new Caddy route, guardian route, or host/public ingress beyond the existing admin surface.
- No arbitrary filesystem mutation contract for the brokered runtime.
- No phase 3 remediation toolset beyond diagnostics/configuration-help primitives.
- No phase 4 hardening features beyond what is needed to ship a safe phase 1-2 baseline.

## Implementation plan

### Phase 1 - Foundations

1. Establish the runtime layout in shared control-plane/path helpers.
   - Add admin-OpenCode-specific path helpers in `packages/lib/src/control-plane/` for config, data, logs/state, and runtime metadata under the 0.10.0 layout.
   - Keep admin-managed OpenCode assets separate from the normal assistant paths so user extensions and project-level `opencode.json` do not bleed into the elevated runtime.
   - Persist only admin-managed seed files automatically; do not auto-overwrite user-owned config locations.

2. Normalize seeded config for a dedicated admin runtime.
   - Replace the current coarse `data/admin/opencode.jsonc` seeding with a dedicated admin-opencode location and naming scheme that matches the new filesystem contract.
   - Keep the dedicated config limited to admin tooling/persona needed for diagnostics/config help.
   - Preserve read-deny rules for OpenCode credential files and mirror the assistant-side redaction posture where applicable.

3. Rework the admin container process model around a supervisor/broker boundary.
   - Replace the current entrypoint pattern that blindly starts SvelteKit plus background OpenCode with a small supervisor model that can: start on demand, report status, restart cleanly, and shut down child processes deterministically.
   - Keep SvelteKit as the primary admin service, but make the OpenCode child process explicitly broker-managed instead of "always start and hope".
   - Record PID/state/health information in an internal runtime state file or in-memory broker state owned by admin.

4. Align Docker/runtime setup with 0.10.0 rules.
   - Update `core/admin/Dockerfile` and compose wiring so OpenCode and Bun remain runtime dependencies only for the admin container; do not change the build-time Node/Vite dependency model.
   - Move host/container ports to the 38XX scheme and reserve `3881` for the admin OpenCode listener.
   - Prefer localhost binding inside the container and avoid any new external exposure; if a host bind remains temporarily for local diagnostics, keep it loopback-only and treat it as transitional until all traffic is brokered through admin.
   - Keep Docker access restricted to the admin process via docker-socket-proxy; the brokered runtime itself must not gain direct socket semantics.

5. Add foundational lib/admin modules.
   - In `packages/lib/`, add portable helpers for admin-opencode path resolution, seeded asset installation, runtime status typing, and request/response DTOs that are not SvelteKit-specific.
   - In admin server code, add a thin broker/supervisor module responsible for spawning the runtime, checking health, and forwarding sanitized requests.
   - Keep OpenCode HTTP client logic separate from broker policy logic so tests can cover each layer independently.

6. Ship minimum phase-1 APIs.
   - `GET /admin/elevated/status`: report disabled/starting/ready/error state, pid if known, last start attempt, and broker-visible health.
   - `POST /admin/elevated/start`: explicitly start the runtime if not running; safe to call repeatedly.
   - Require admin auth for both endpoints, and include request IDs plus audit events for start/status operations.

### Phase 2 - Admin-authorized diagnostics and configuration help

1. Add brokered session APIs.
   - `POST /admin/elevated/session`: create an elevated session for either a direct user flow or an assistant-mediated flow.
   - `POST /admin/elevated/session/:id/message`: proxy message traffic to the admin OpenCode runtime.
   - Optionally add `GET /admin/elevated/session/:id` or `GET /admin/elevated/session/:id/events` only if needed for diagnostics UX; avoid widening the surface unless the UI requires it.

2. Define the auth model explicitly.
   - User-initiated admin UI/API calls authenticate with `ADMIN_TOKEN` and may create or message elevated sessions directly.
   - Assistant-originated calls must be accepted only through explicitly allowlisted elevated endpoints after #300's token split; the assistant still uses `ASSISTANT_TOKEN` and never receives `ADMIN_TOKEN`.
   - The admin broker, not the assistant, supplies admin authorization when calling the internal OpenCode runtime or downstream admin capabilities.
   - Preserve the rule from roadmap/review decisions: this runtime is an admin agent conceptually, but the trust boundary is still the Admin API contract.

3. Define the session/message flow.
   - User or assistant calls admin elevated endpoint.
   - Broker ensures runtime is started, creates an OpenCode session if needed, and tags the session with initiator metadata (`user`, `assistant`, request ID, optional parent session ID).
   - Broker forwards the message to the local OpenCode API.
   - OpenCode uses admin-scoped tools/config already baked into its dedicated config.
   - Any state-changing follow-up still goes through existing admin endpoints/control-plane functions; nothing talks to Docker or mutable host paths directly.
   - Broker returns streamed or buffered output in a shape that admin UI and assistant flows can both consume.

4. Audit and attribution.
   - Append audit records for runtime start, session creation, each proxied message, authorization failures, and broker/runtime failures.
   - Preserve both the authenticated caller and the effective initiator in audit payloads so an assistant-originated elevated action is not mislabeled as a human-only action.
   - Avoid logging prompt bodies or secret-bearing tool output verbatim; log identifiers, operation classes, result state, and request/session IDs instead.

5. Diagnostics and UI touchpoints.
   - Add an admin diagnostics panel or status card showing runtime availability, last error, and a controlled way to open an elevated help session.
   - Keep this within the admin UI; do not expose a separate OpenCode UI route through Caddy.
   - Optionally expose lightweight diagnostics actions first: config validation help, connection troubleshooting, artifact inspection guidance, and read-only stack inspection.

6. Failure handling.
   - If the runtime is unavailable, surface actionable broker errors without blocking existing shell-automation fallbacks described in roadmap decision Q5.
   - Distinguish broker startup failures, OpenCode transport failures, and downstream admin-tool failures in API responses.
   - Make repeated `start` and `session` requests idempotent enough for UI retries.

## Task breakdown by workstream

### Docker and runtime setup

- Update `core/admin/Dockerfile` for 0.10.0 ports and keep OpenCode/Bun runtime-only.
- Update `core/admin/entrypoint.sh` or replace it with a supervisor-friendly launcher.
- Update `assets/admin.yml` to use `3880` and `3881`, keep loopback-only host binds, and avoid any new Caddy wiring for the elevated runtime.
- Update any admin OpenCode environment variables to point at the local broker/runtime using 38XX defaults.

### Broker and supervisor modules

- Add lib types/helpers for runtime status, session metadata, and admin-opencode path helpers.
- Add an admin server broker module for spawn/health/proxy behavior.
- Add an internal OpenCode client wrapper specifically for the admin runtime, separate from the existing assistant-facing localhost client assumptions.
- Ensure broker code is thin where possible and delegates shared logic into `packages/lib/`.

### API endpoints

- Add status/start endpoints in phase 1.
- Add session/message endpoints in phase 2.
- Reuse existing helper patterns for request IDs, JSON envelopes, actor resolution, and audit logging.
- Apply token-aware auth checks that reflect #300's split instead of assuming a single admin token world.

### Session and message flow

- Validate session IDs and message payloads strictly.
- Preserve initiator metadata across session creation and message proxying.
- Keep the runtime off the public network path; all access must transit admin endpoints.
- Treat tool execution as admin-API-mediated work, not container-level privilege.

### Audit and auth handling

- Extend auth helpers to distinguish admin-only, assistant-allowed, and elevated-broker endpoints after #300.
- Add explicit audit event names for elevated runtime lifecycle and session traffic.
- Ensure logs remain structured and redact sensitive payloads.

### UI and diagnostics touchpoints

- Add a minimal admin UI affordance for elevated runtime status and open-session entry.
- Keep the UX framed as "diagnostics/configuration help" to avoid implying unrestricted remediation.
- If the assistant can invoke elevated help, make the resulting audit trail visible from admin diagnostics or audit views.

### Tests

- Add unit tests in `packages/lib/` for new path helpers, DTO validation, and any reusable elevated-runtime helpers.
- Add admin server tests for authz, status/start behavior, session/message proxying, invalid session IDs, broker failures, and audit emission.
- Add integration or E2E coverage that verifies no new public route is exposed and that elevated flows still require admin-mediated access.
- Update existing OpenCode stack tests for the new 38XX ports and ensure they do not assume direct host access to a privileged OpenCode UI.

### Docs

- Update architecture/runtime docs to describe the brokered admin runtime, its dedicated config paths, and its authorization model.
- Update any roadmap-linked implementation docs if actual file paths or startup behavior differ from the original proposal.
- Document the degraded path: shell automation remains available if the brokered runtime is down or not yet enabled.

## Deferred after phases 1-2

- Phase 3: admin-mediated remediation tools, confirmation UX for state-changing actions, and broader repair flows.
- Phase 4: session TTLs, one-shot grants, stronger delegation semantics, restart/upgrade hardening, and deeper abuse resistance.
- Any direct exposure of a separate elevated OpenCode UI should remain deferred indefinitely unless there is a new architecture review; phases 1-2 should assume brokered API-only access.

## Acceptance criteria

- Admin can report whether the brokered runtime is stopped, starting, ready, or failed via a dedicated status endpoint.
- Admin can start the runtime on demand without changing the orchestrator model or exposing Docker/socket access to the runtime.
- User and assistant can open brokered elevated sessions only through authenticated admin endpoints.
- Elevated session messages are proxied through admin, audit-logged, and attributed to the real initiator.
- The elevated runtime uses admin-authorized API capability, not direct container/system authority.
- No new public ingress, no new guardian bypass, and no new direct Caddy route are introduced.
- Shared control-plane logic for paths/types/portable helpers lands in `packages/lib/` where applicable.
- Existing shell-automation fallback remains viable if the runtime is unavailable.

## Risks and watchpoints

- The repo already contains partial #304 scaffolding; implementation should reconcile it with the stricter 0.10.0 model instead of layering more ad hoc behavior on top.
- A background child process without real supervision can leave stale PIDs, unclear health state, and fragile restart behavior.
- Auth mistakes around #300 could accidentally let assistant flows reach admin-only behavior without explicit brokerage.
- Host port exposure for `3881` can drift into a de facto direct interface if not clearly treated as internal/brokered-only.
- Audit payloads can accidentally capture sensitive prompts/tool output unless message logging is deliberately minimized.
- If broker logic stays in admin-only code, CLI/admin behavior will diverge from the shared-library rule over time.

## Relevant files

- `.github/roadmap/0.10.0/README.md:108` - #304 scope, deliverables, dependency on #300, and deferred phases.
- `.github/roadmap/0.10.0/README.md:219` - cross-cutting lib-first rule for control-plane logic.
- `.github/roadmap/0.10.0/review-decisions.md:81` - admin OpenCode uses `ADMIN_TOKEN` conceptually as an admin agent.
- `.github/roadmap/0.10.0/review-decisions.md:97` - degraded shell-automation fallback if #304 is delayed.
- `.github/roadmap/0.10.0/openpalm-pass-impl-v3.md:1490` - token access matrix and explicit dependency on the auth split.
- `docs/technical/core-principles.md:23` - admin is the only orchestrator and Docker socket holder.
- `docs/technical/core-principles.md:25` - assistant isolation boundary.
- `docs/technical/core-principles.md:32` - file-assembly rule and shared control-plane rule.
- `docs/technical/core-principles.md:52` - vault boundary and mount restrictions.
- `docs/technical/core-principles.md:128` - `packages/lib/` as the shared control-plane library.
- `docs/technical/core-principles.md:146` - 38XX service port assignments, including admin OpenCode on `3881`.
- `assets/admin.yml:59` - current admin service overlay, host binds, env wiring, and admin OpenCode port exposure.
- `assets/admin-opencode.jsonc:1` - dedicated admin OpenCode config asset and current plugin/permission policy.
- `core/admin/Dockerfile:61` - current admin runtime image already installs OpenCode/Bun and exposes the admin OpenCode port.
- `core/admin/entrypoint.sh:4` - current process model starts SvelteKit plus background OpenCode with minimal supervision.
- `packages/lib/src/control-plane/core-assets.ts:232` - current admin OpenCode config seeding path.
- `packages/admin/src/lib/server/control-plane.ts:18` - admin re-export of lib control-plane functions including admin OpenCode config seeding.
- `packages/admin/src/lib/server/helpers.ts:67` - current admin-token-only auth helper that will need #300-aware extension for elevated endpoints.
- `packages/admin/src/lib/opencode/client.server.ts:9` - existing localhost OpenCode client assumptions to revisit for the brokered runtime.
- `packages/admin/e2e/opencode-ui.test.ts:17` - current tests assume direct host access to OpenCode ports and will need adjustment.
