# OpenPalm v1 MVP Readiness Report

**Date:** 2026-02-24
**Version reviewed:** 0.3.4
**Reviewer:** Automated end-to-end review with local manual verification

---

## v1 MVP Requirements

| # | Requirement | Status |
|---|---|---|
| 1 | A non-technical user can easily install and complete initial setup | **Partial** |
| 2 | Once setup is complete the user can easily chat with the assistant in their browser | **Blocked** |
| 3 | End-to-end UX from install to first chat session is failure-proof, always resulting in a working admin UI for troubleshooting | **Partial** |

---

## Executive Summary

The solution has strong architectural foundations: a well-designed CLI installer, a multi-step setup wizard, a robust stack management engine with atomic apply/rollback, and comprehensive test coverage (576 passing tests, 0 failures). Docker images are published to Docker Hub for amd64/arm64, CLI binaries are available on GitHub Releases for all major platforms, and the npm package is published.

However, there are several blocking and high-priority issues that prevent the v1 MVP from meeting its three hard requirements. The most critical is that **the primary path to chatting with the assistant via the browser does not work** due to an authentication/routing mismatch in the OpenCode web interface proxy. Additional issues around error recovery, UX gaps in the wizard, and missing release infrastructure need resolution before release.

---

## Requirement 1: Easy Install and Setup

### What Works

- **One-command install**: `install.sh` (Linux/macOS) and `install.ps1` (Windows) download the pre-compiled CLI binary from GitHub Releases, verify checksums, and delegate to `openpalm install`. This is well-designed for non-technical users.
- **Prerequisites documentation**: The README clearly explains what a container runtime is and links to installation guides for each platform.
- **Runtime detection**: The CLI automatically detects Docker, Podman, or OrbStack and selects the correct compose command.
- **Preflight checks**: The installer checks for disk space (3 GB minimum), port 80 availability, and Docker daemon status before proceeding. Each failure provides clear, actionable guidance.
- **Secret generation**: The admin token and all channel HMAC secrets are auto-generated securely. The admin password is prominently displayed with instructions to save it.
- **Idempotency guard**: Re-running `openpalm install` detects an existing installation and offers to update or force-reinstall.
- **Setup wizard**: An 8-step browser wizard (Welcome, Profile, AI Providers, Security, Channels, Access, Health Check, Complete) walks users through configuration. The wizard is well-paced and uses friendly language.

### Issues Found

#### ISSUE-1: No Published GitHub Release Binaries for v1 (Severity: BLOCKER)

The install script downloads from `https://github.com/itlackey/openpalm/releases/latest/download/openpalm-{os}-{arch}`. While v0.3.4 releases exist with binaries, there is no v1.0.0 release. The current version is `0.3.4` which signals pre-release status to users.

**Recommendation:** Bump version to `1.0.0`, create a GitHub Release tagged `v1.0.0`, and ensure CI builds and attaches binaries for all platforms (linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64). The existing `publish-cli.yml` and `release.yml` workflows appear to handle this.

#### ISSUE-2: Admin Password UX Is Fragile (Severity: HIGH)

During install, the admin password is printed to the terminal with a prominent banner. However:

1. If the terminal scrolls past the password during image pulls, the user may miss it.
2. The installer says "It is also saved in: `{stateEnvFile}`" but non-technical users won't know how to read a `.env` file.
3. The Security step of the wizard says "Look for the line labeled YOUR ADMIN PASSWORD" in the terminal — if the user closed the terminal, they have no way to recover.
4. The password is NOT displayed in the wizard's Complete step.

**Location:** `packages/cli/src/commands/install.ts:166-175`, `packages/ui/src/lib/components/SecurityStep.svelte:20-27`

**Recommendation:**
- Add a "copy to clipboard" mechanism or pause the installer after displaying the password (e.g., "Press Enter to continue").
- Add a password recovery command: `openpalm show-password`.
- In the Security step, add a "show current password" link that reads from the `.env` file when accessed from localhost.

#### ISSUE-3: Setup Wizard Allows Skipping Required Steps (Severity: HIGH)

The AI Provider step (step 3 - "serviceInstances") does not validate that the user has entered an Anthropic API key before proceeding. The field is labeled "Required" with a link to console.anthropic.com, but the Next button proceeds without validation. If a user skips this step, the assistant container will start without an API key and every chat request will fail silently.

**Location:** `packages/ui/src/lib/components/SetupWizard.svelte:82-133`, `packages/ui/src/lib/components/ProvidersStep.svelte:37-38`

**Recommendation:**
- Add client-side validation in `wizardNext()` for the `serviceInstances` step: require that `wiz-anthropic-key` has a non-empty value (or that `state?.anthropicKeyConfigured` is already true).
- Show a clear inline error if the user tries to proceed without an API key.

#### ISSUE-4: Port 80 Conflict Has No Resolution Path (Severity: MEDIUM)

The preflight check warns if port 80 is in use, but the install still proceeds and silently fails when Caddy can't bind. Non-technical users won't know how to free port 80.

**Location:** `packages/lib/src/preflight.ts:46-82`

**Recommendation:**
- Make port 80 conflict fatal with clear guidance: "Close the application using port 80 (e.g., Apache, nginx) or run: `openpalm install --port 8080`".
- Add a `--port` flag to allow an alternate port.
- Alternatively, pick a non-privileged default port (e.g., 8080) that's less likely to conflict.

#### ISSUE-5: npx/bunx Alternative Install Not Tested for v1 Path (Severity: LOW)

The README mentions `npx openpalm install` as an alternative, and the npm package is published. However, the npm package only contains the CLI source — the `npx` path would need `bun` or a compatible runtime installed, which is not a standard user prerequisite.

**Recommendation:** Either remove the `npx`/`bunx` alternative from the README for v1 (since the binary installer is the primary path), or ensure the npm package has a proper `bin` entry that works with Node.js.

---

## Requirement 2: Chat with Assistant in Browser

### What Works

- **OpenCode web interface**: The assistant container runs `opencode web --hostname 0.0.0.0 --port 4096` which serves the full OpenCode web chat interface.
- **Caddy direct proxy**: The Caddy config generator creates a route at `/services/opencode*` that strips the prefix and reverse-proxies to `assistant:4096`. This route supports WebSocket and SSE natively through Caddy.
- **Admin dashboard QuickLinks**: The dashboard shows an "Open OpenCode" card with a link.

### Issues Found

#### ISSUE-6: "Open OpenCode" Link Is Broken — Authentication Mismatch (Severity: BLOCKER)

This is the most critical issue found. The "Open OpenCode" link in `QuickLinks.svelte` points to `${base}/opencode/` which routes through the SvelteKit admin app (`routes/opencode/[...path]/+server.ts`). This proxy handler checks `locals.authenticated` — which requires the `x-admin-token` HTTP header.

**The problem:** When a user clicks the "Open OpenCode" link (which opens in a new browser tab via `target="_blank"`), the browser sends a standard GET request **without** the `x-admin-token` header. The SvelteKit hooks check `event.request.headers.get('x-admin-token')` and set `locals.authenticated = false`. The proxy route returns a 401 JSON error. **The user cannot access the OpenCode web interface.**

**Location:**
- `packages/ui/src/lib/components/QuickLinks.svelte:5` — link URL: `${base}/opencode/`
- `packages/ui/src/routes/opencode/[...path]/+server.ts:18` — checks `locals.authenticated`
- `packages/ui/src/hooks.server.ts:26` — auth only from header, no cookie support

**Meanwhile:** The Caddy route at `/services/opencode*` works correctly — it proxies directly to `assistant:4096` with LAN IP restriction, no admin token needed. But this URL is not used anywhere in the UI.

**Recommendation (two options):**

**Option A (Recommended for v1 — simplest fix):** Change the QuickLinks `assistantUrl` from `${base}/opencode/` to `/services/opencode/`. This leverages the existing Caddy direct proxy which handles WebSocket/SSE natively and is already LAN-restricted. Remove the SvelteKit `/opencode/[...path]` proxy route or repurpose it for API-only access.

**Option B (More robust, longer-term):** Add cookie-based session auth to the admin UI. When the user enters their admin token, set a secure HTTP-only cookie. The hooks.server.ts would then check both the header and the cookie for authentication. This would allow the `/opencode/` route to work with browser navigation.

#### ISSUE-7: SvelteKit Proxy Cannot Handle WebSocket/SSE (Severity: BLOCKER if Option A in ISSUE-6 is not chosen)

The SvelteKit route handler at `routes/opencode/[...path]/+server.ts` uses `fetch()` to proxy requests. SvelteKit route handlers do not support WebSocket upgrades. The OpenCode web interface uses WebSocket or SSE for streaming chat responses.

Additionally, the proxy has a 5-second timeout (`AbortSignal.timeout(5000)`) which will abort any AI response that takes longer than 5 seconds — which is virtually all of them.

**Location:** `packages/ui/src/routes/opencode/[...path]/+server.ts:27`

**Recommendation:** If Option A from ISSUE-6 is adopted (use `/services/opencode/` via Caddy), this issue is automatically resolved since Caddy handles WebSocket and SSE natively with no timeout. If the SvelteKit proxy is kept, the timeout must be increased to at least 120 seconds and WebSocket support must be added.

#### ISSUE-8: OpenCode Web Interface Requires Separate Auth Flow (Severity: MEDIUM)

Even with the URL fix (ISSUE-6), the OpenCode web interface at `assistant:4096` has its own auth model. It may prompt for authentication or API keys independently. Users who just completed the setup wizard may be confused by a second authentication prompt.

**Recommendation:** Investigate whether OpenCode web supports pre-configured auth via environment variables. If so, pass the necessary config in the assistant container's environment. If not, document this as a known step in the setup completion flow and add instructions in the CompleteStep component.

---

## Requirement 3: Failure-Proof UX — Always End with Working Admin UI

### What Works

- **Two-phase install**: The installer first starts only Caddy + Admin (Phase 2: "Early UI access"), then the setup wizard brings up remaining services. This means even if the full stack fails, the admin UI is available.
- **Fallback compose and Caddy configs**: The installer writes `docker-compose-fallback.yml` and `caddy-fallback.json` as minimal configs that only run Caddy + Admin. The stack-apply-engine can roll back to these if a full apply fails.
- **Atomic stack apply**: `stack-apply-engine.ts` stages artifacts to `.next` temp files, validates them, then atomically promotes via rename. If anything fails mid-apply, the previous files remain intact.
- **Health gates**: The apply engine can wait for services to pass health checks before proceeding (safe rollout mode).
- **Self-test on startup**: The admin entrypoint runs `self-test-fallback.js` which validates fallback bundle integrity.
- **Comprehensive health checks**: The admin UI shows real-time health status for Gateway, Assistant, Memory, and Admin.

### Issues Found

#### ISSUE-9: Setup Wizard Complete Step Has No Failure Recovery (Severity: HIGH)

The `finishSetup()` function in `SetupWizard.svelte` calls `setup.complete` which triggers `applyStack()` + `composeAction('up', [...CoreStartupServices])`. If this fails (e.g., image pull failure, compose error, port conflict), the user sees a generic error. There is no retry button, no guidance on what went wrong, and the wizard is stuck.

**Location:** `packages/ui/src/lib/components/SetupWizard.svelte:168-203`, `packages/ui/src/routes/setup/complete/+server.ts:22-43`

**Recommendation:**
- Add error handling in `finishSetup()` — catch the error, display a user-friendly message with specific guidance.
- Add a "Retry" button on the Complete step.
- If `setup.complete` fails, still mark setup as completed but with a `degraded` flag, so the user lands on the admin dashboard where they can troubleshoot via Health Status and OperationsManager.

#### ISSUE-10: CompleteStep Polling Timeout Has No Actionable Guidance (Severity: MEDIUM)

`CompleteStep.svelte` polls `setup/health-check` up to 120 times (2 minutes). If services don't become healthy, it shows "Some services are still starting. You can continue anyway." with a secondary "Continue to Admin" button. The message doesn't explain what might be wrong or what to do next.

**Location:** `packages/ui/src/lib/components/CompleteStep.svelte:28-31`

**Recommendation:**
- Show which specific services are not healthy (the data is available from the health-check response).
- Add troubleshooting guidance: "Check your API key. Check Docker logs with `openpalm logs`."
- Consider showing the health status inline during the polling phase.

#### ISSUE-11: No Admin UI Accessible if Caddy Fails to Start (Severity: MEDIUM)

If port 80 is occupied and Caddy can't bind, the entire web UI becomes unreachable. The fallback mechanism only helps if Caddy itself is running but the full stack compose is broken. If Caddy is the failing component, the user has no web interface.

**Location:** `packages/cli/src/commands/install.ts:364-395`

**Recommendation:**
- The installer's health check loop already handles this gracefully (shows "Setup did not come online within 3 minutes" with diagnostic steps).
- Enhance by adding: direct admin access URL at `http://localhost:8100` as a bypass.
- Expose admin port 8100 directly in the minimal compose file so users can access admin even if Caddy fails.

#### ISSUE-12: Minimal Compose Missing `channel_net` Network Usage (Severity: LOW)

The minimal compose file (Phase 2 of install) defines `channel_net` network but no services use it. This is harmless but may cause a warning in some Docker Compose versions.

**Location:** `packages/cli/src/commands/install.ts:324-327`

**Recommendation:** Remove the unused `channel_net` from the minimal compose, or add a comment explaining it's a placeholder for the full stack.

---

## Additional Findings

### ISSUE-13: CORS Hardcoded to `http://localhost` (Severity: MEDIUM)

`hooks.server.ts` hardcodes `access-control-allow-origin: http://localhost`. If the user accesses the admin UI via their machine's IP address (e.g., `http://192.168.1.50`), API requests from the browser will fail due to CORS. This breaks the LAN access scope feature.

**Location:** `packages/ui/src/hooks.server.ts:5`

**Recommendation:** Dynamically set the CORS origin based on the access scope:
- `host` → `http://localhost`
- `lan` → `*` or reflect the request Origin header if it's a private IP
- `public` → reflect the request Origin

### ISSUE-14: Channel Config Fields Show Raw Env Var Names (Severity: MEDIUM)

In the Channels step, credential fields are labeled with raw environment variable names like `DISCORD_BOT_TOKEN` instead of friendly labels like "Discord Bot Token". This is confusing for non-technical users.

**Location:** `packages/ui/src/lib/components/ChannelsStep.svelte:79-89`

**Recommendation:** Use the `helpText` from channel definitions as labels, or add a `label` field to channel env metadata. Fall back to humanizing the env var name (split on `_`, title case).

### ISSUE-15: No Version Pinning for OpenMemory Images (Severity: MEDIUM)

The docker-compose.yml uses `mem0/openmemory-mcp:latest` and `mem0/openmemory-ui:latest` with a TODO comment acknowledging this. Using `latest` tags means:
- Installs are not reproducible
- A breaking change upstream could break all OpenPalm installations
- Users can't pin to a known-good version

**Location:** `packages/lib/src/embedded/state/docker-compose.yml:49,70`

**Recommendation:** Pin to specific versions before v1 release. Monitor the mem0 release cycle and test with specific versions.

### ISSUE-16: No Telemetry or Error Reporting for Install Failures (Severity: LOW)

When the install fails (network error, image pull failure, compose error), there's no way for the project to learn about failure patterns. For a v1 focused on non-technical users, understanding failure modes is critical.

**Recommendation:** Add opt-in anonymous telemetry for install success/failure metrics (with clear disclosure and easy opt-out). Alternatively, add a "Report Issue" link in error messages that pre-fills a GitHub issue template.

### ISSUE-17: Uninstall Script Not Linked from Admin UI (Severity: LOW)

The admin dashboard has no uninstall option. Users must know to run `openpalm uninstall` from the terminal.

**Recommendation:** Add an "Uninstall" section in the admin dashboard under an "Advanced" or "Danger Zone" area.

---

## Test Coverage Summary

| Category | Status |
|---|---|
| Unit tests | 576 pass, 0 fail, 27 skip |
| TypeScript typecheck | Clean (0 errors) |
| UI build (SvelteKit) | Successful |
| CLI binary build | Working (`openpalm v0.3.4`) |
| Docker images (Docker Hub) | Published: admin, assistant, gateway, channel-chat, channel-discord, etc. (amd64 + arm64) |
| GitHub Release binaries | Published for linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64 |
| npm package | Published at v0.3.4 |
| E2E Playwright tests | Written (10 test files) but require running stack |
| Contract tests | Written but require running stack |

---

## Priority Matrix for v1 Release

### Must Fix (Blockers)

| Issue | Summary | Effort |
|---|---|---|
| ISSUE-6 | "Open OpenCode" link broken — auth mismatch | Small (change one URL) |
| ISSUE-7 | SvelteKit proxy can't handle WebSocket/SSE | Resolved by ISSUE-6 fix |
| ISSUE-1 | No v1.0.0 release tag/binaries | Small (version bump + release) |
| ISSUE-3 | Wizard allows skipping API key | Small (add validation) |

### Should Fix (High Priority)

| Issue | Summary | Effort |
|---|---|---|
| ISSUE-2 | Admin password UX is fragile | Medium |
| ISSUE-9 | Setup complete has no failure recovery | Medium |
| ISSUE-13 | CORS hardcoded to localhost breaks LAN | Small |

### Nice to Have (Medium Priority)

| Issue | Summary | Effort |
|---|---|---|
| ISSUE-4 | Port 80 conflict has no resolution path | Medium |
| ISSUE-8 | OpenCode web may need separate auth | Investigation needed |
| ISSUE-10 | Complete step timeout lacks guidance | Small |
| ISSUE-11 | No admin access if Caddy fails | Small |
| ISSUE-14 | Channel config shows raw env var names | Small |
| ISSUE-15 | OpenMemory images not version-pinned | Small |

### Post-v1

| Issue | Summary |
|---|---|
| ISSUE-5 | npx/bunx install path |
| ISSUE-12 | Unused network in minimal compose |
| ISSUE-16 | Install telemetry |
| ISSUE-17 | Uninstall from admin UI |

---

## Recommended v1 Release Checklist

1. **Fix ISSUE-6**: Change QuickLinks URL to `/services/opencode/` (one-line fix)
2. **Fix ISSUE-3**: Add Anthropic API key validation in wizard
3. **Fix ISSUE-13**: Dynamic CORS origin based on access scope
4. **Fix ISSUE-9**: Add error handling and retry in setup completion
5. **Fix ISSUE-2**: Add password recovery command or display mechanism
6. **Bump version to 1.0.0** and create release
7. **Pin OpenMemory image versions** (ISSUE-15)
8. **Manual smoke test**: Full install → setup → chat flow on macOS, Linux, and Windows

---

## Architecture Strengths

The following architectural decisions are well-executed and should be preserved:

1. **Two-phase install** (Caddy + Admin first, then full stack via wizard) ensures admin UI access even during partial failures
2. **Atomic stack apply** with staged artifacts and rollback capability
3. **Fallback bundle** (minimal compose + caddy config) as last-resort recovery
4. **LAN-restricted access** with Caddy IP guards and configurable scope
5. **Cryptographic HMAC verification** for channel messages
6. **Secret detection** in the policy-and-telemetry plugin prevents storing credentials in memory
7. **Comprehensive health check** infrastructure across all services
8. **Clean separation** of concerns: CLI (install/manage) → Admin (control plane) → Gateway (message routing) → Assistant (AI runtime) → Channels (adapters)
