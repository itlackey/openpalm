# UI E2E Tests

## Quick Commands

From the repository root:

```bash
# Self-contained browser contracts, no Docker
bun run ui:test:e2e:mocked

# Production PWA browser lane, no Docker
bun run ui:test:pwa

# Clean isolated stack plus HTTP smoke and stack Playwright
./scripts/dev-e2e-test.sh --playwright

# Reuse already-built dev images and UI output
./scripts/dev-e2e-test.sh --skip-build --playwright
```

Install the configured Chromium build first when needed:

```bash
bun run --cwd packages/ui test:browsers
```

## File Conventions

### `*.pw.ts`: Self-Contained Browser Contracts

Collected when no stack flag is set. `playwright.config.ts` builds the UI and
starts its preview server against a throwaway setup-complete home with a fixed
login password and admin capability. Docker and a real install are not needed.

Current coverage includes:

| File | Coverage |
|---|---|
| `auth-flow.pw.ts` | Login, logout, wrong-password, and protected-route auth contracts |
| `setup-guard.pw.ts` | Setup-complete navigation and setup API auth boundaries |
| `hydration.pw.ts` | Browser hydration regressions |
| `security-headers.pw.ts` | Browser-facing security headers |
| `host-tab-url-navigation.pw.ts` | Host tab URL/navigation state |
| `host-navigation-responsive.pw.ts` | Responsive host navigation |
| `chat-history-navigation.pw.ts` | Chat history navigation |
| `chat-footer-responsive.pw.ts` | Responsive chat/footer layout contracts |

Run them with:

```bash
bun run ui:test:e2e:mocked
```

### `*.stack.ts`: Isolated Stack Integration

Collected when `RUN_DOCKER_STACK_TESTS=1`. The canonical launcher is
`scripts/dev-e2e-test.sh --playwright`; each file also guards itself when the
stack flag is absent. Stack mode additionally reuses `auth-flow.pw.ts`.

Current stack files are:

| File | Coverage |
|---|---|
| `admin-health.stack.ts` | Host health/provider auth and Guardian liveness through the host proxy |
| `opencode-ui.stack.ts` | Assistant OpenCode health, UI, configuration, and session creation without model inference |
| `setup-wizard-api.stack.ts` | Current setup status/system-check API and non-deploying setup dry run |
| `setup-wizard-browser.stack.ts` | Browser setup redirect and Connect-step rendering |
| `chat-ui.stack.ts` | Auth gate and interactive chat controls without sending a real message |
| `install-flow.stack.ts` | Wizard navigation through Review without clicking Install |
| `auth-boundary.stack.ts` | Current `/api/host/*` read/write auth boundaries |
| `secrets.stack.ts` | `env:user` key CRUD, redaction, and input validation |
| `admin-panel-browser.stack.ts` | Browser smoke for host status, systems, journal, connections, and secrets views |
| `lan-access.stack.ts` | Two-device LAN access: enables `networkAccess`, then drives login, an `/oc` chat round trip, and `/voice` reachability against the assistant container's own UI co-process from a non-loopback source address |

## Tier 5 Launcher Contract

`scripts/dev-e2e-test.sh` creates and owns a current-layout test installation:

- Compose project: `openpalm-e2e`
- Home: `.dev-e2e/`, never `.dev/` or `~/.openpalm/`
- Managed compose: `.dev-e2e/system/stack/*.compose.yml`
- User overlay: `.dev-e2e/config/stack/custom.compose.yml`
- Runtime record: `.dev-e2e/state/stack.env`
- Delegated service secrets: `.dev-e2e/private/secrets/`
- Shared provider-auth exception: `.dev-e2e/knowledge/secrets/auth.json`

It enables the `api` addon and `addon.api` profile so the profile-gated Guardian
runs without Discord, Slack, or other external credentials. It builds the UI and
assistant/Guardian images, starts the stack and loopback host admin, then checks:

- assistant, container UI, and API health
- disabled Guardian direct ingress fails closed
- `/api/auth/login`
- unauthenticated and authenticated `/api/host/containers/list`
- authenticated `/api/host/health`
- no Docker socket or delegated `private/` tree mounted into the assistant
- all selected stack Playwright files

The launcher does not test the voice service, voice hardware, model-backed chat,
or real external credentials.

Default isolated ports are:

| Surface | Port |
|---|---|
| Host admin | `3890` |
| Assistant OpenCode | `3891` |
| Assistant-container UI | `3892` |
| Guardian direct listener | `3893` |
| Guardian admin listener | `3894` |
| API edge | `3895` |
| Chat edge reservation (profile not enabled) | `3896` |

The default cleanup trap removes containers, volumes, and `.dev-e2e/`. Use
`--keep` only when retaining the stack/home for inspection is intentional.

## PWA Suite

PWA files live under `e2e/pwa/` and are selected by
`playwright.pwa.config.ts`, not the normal `*.pw.ts`/`*.stack.ts` configuration.

```bash
bun run ui:test:pwa
```

This lane builds the production UI and checks the manifest, Chromium
installability, service-worker control, standalone app mode, persisted browser
state, and network-only boundaries for navigation/API/auth/SSE traffic.

## Manual File

`navbar-visual.manual.ts` is the only current `*.manual.ts` file. It is not
collected by either automated configuration and is run by a human against the
direct UI development server on port `5173`.

`voice.manual.ts`, `scheduler.manual.ts`, and `akm-config.manual.ts` were removed
because they were stale and never collected. Their old requirements are not
part of the automated stack launcher.

## Wizard UX Capture

The separate wizard visual-audit command remains:

```bash
bun run --cwd packages/ui ux:audit:wizard
```

Its repository-local configuration test runs with `bun run ui:test:unit`; the
external audit/judging runner is not part of Playwright collection.

See [Testing Workflow](../../../docs/technical/testing-workflow.md) for the full
five-tier command map.
