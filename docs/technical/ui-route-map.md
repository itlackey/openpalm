# UI Route Map

**Date:** 2026-07-06 (Phase 3 of `ui-runtime-modes-plan.md`)
**Package:** `packages/ui` (`@openpalm/ui` — the host app)
**Status:** current truth after the Phase 3 landing/navigation split. Phase 4
renames `/admin` → `/host` (no alias; `HOST_ADMIN_LANDING` in
`src/lib/resolve-landing.ts` flips with it). Phase 5 moves the chat +
connections views into `packages/client`.

Surfaces (plan §1): **Host** = host control plane (stack lifecycle, secrets,
privileged ops), **Assistant** = chat against the active connection,
**Connection** = connection management, **Entry** = landing/auth/first-run
plumbing shared by all surfaces.

## Landing resolution

Every document navigation to `/` (and the legacy `/splash` path) is redirected
by `hooks.server.ts` to the landing resolved by `resolveLanding(ctx,
launchState)` (`src/lib/resolve-landing.ts`, plan §6.5):

| Condition (in precedence order) | Landing |
|---|---|
| `host:setup` capability + migration pending | `/attention` |
| `host:setup` + local `not_installed` (no accessible connection) | `/setup` |
| `host:setup` + local `not_installed` (accessible connection exists, #440) | `/chat` |
| `host:setup` + local `setup_incomplete` | `/setup` |
| `host:setup` + local `installed_offline` | `/admin` (Phase 4: `/host`) |
| `host:setup` + local `installed_broken` | `/admin?tab=diagnostics` |
| `host:setup` + local `running` | `/chat` |
| no `host:setup`, `assistant-container` mode | `/chat` |
| no `host:setup`, `pwa-static` mode, 0 connections | `/connections/new` |
| no `host:setup`, `pwa-static` mode, ≥1 connection | `/chat` |
| anything else | `/chat` |

The launch-routing guard fires **before** the auth guard, so `/` and stale
`/splash` bookmarks never bounce through `/login` first. `/splash` no longer
exists as a route; the path keeps redirecting to the resolved landing for this
release only.

## Guards (defined in `src/hooks.server.ts` unless noted)

- **auth** — document navigations (GET + `Accept: text/html`) without a valid
  `op_session` cookie redirect to `/login?redirectTo=…`. API/data requests are
  left to the endpoint's own JSON 401.
- **admin gate** — `/admin/*` requires a host-capable mode
  (`electron-host`/`host-ui`, the legacy `features.admin` alias — server-side
  only, removed with Phase 4); otherwise redirects to `/chat`
  (`/admin/endpoints` → `/connections`).
- **requireAdmin()** — per-endpoint session check in `+server.ts` handlers
  (`$lib/server/helpers.js`); JSON 401, never an HTML redirect.
- **requireCapability(cap)** — per-endpoint server-side capability check
  (plan §8.5; `hasCapability()` in components is UX only).
- **setup localhost** — SEC-4: `/setup` + `/api/setup/*` are unauthenticated
  before first-run completes but restricted to loopback clients (unless
  `OP_ALLOW_REMOTE_SETUP`); after completion, re-runs require admin auth.
- **host/origin** — SEC-1/SEC-2 Host-header allowlist + Origin check apply to
  every request; host admin stays loopback-only (plan §8.3).

## Page routes

| Path | Surface | Guard | Notes |
|---|---|---|---|
| `/` | Entry | launch-routing (pre-auth) | Never renders: hooks (document nav) + `+page.server.ts` (client-side nav) redirect to the resolved landing |
| `/splash` | Entry | launch-routing (pre-auth) | **Route removed** in Phase 3; the path 302s to the resolved landing for this release |
| `/attention` | Entry | auth | Migration/blocking surface split out of `/splash`; landing when `migration.status === 'pending'` (no producer yet) |
| `/login` | Entry | public | Password login; issues the `op_session` cookie |
| `/setup` | Host | setup localhost | First-run wizard; `?rerun=1` after completion requires admin auth |
| `/chat` | Assistant | auth | Stillness chat; own corner chrome (hides the navbar); imports domain clients directly, never the `$lib/api.js` barrel (#555) |
| `/advanced` | Assistant | auth | Embedded OpenCode web UI; mounts `ChatNavbar` (chat chrome composition) |
| `/connections` | Connection | auth (page) + `connections:manage` (its API) | Connection manager; mounts `ChatNavbar`; `?new=1` opens the add form |
| `/connections/new` | Connection | auth | pwa-static "no connections yet" landing; 302 alias to `/connections?new=1` |
| `/admin` | Host | admin gate + auth | Dashboard (tabbed); mounts the chat-free `Navbar` shell (#555); honors `?tab=diagnostics` (Systems tab). Phase 4: `/host` |
| `/admin/endpoints` | Connection | admin gate | 302 alias to `/connections` (0.13.0 only; Phase 4 makes `/admin/*` 404) |

## API routes

| Namespace | Surface | Guard | Endpoints |
|---|---|---|---|
| `/api/runtime` | Entry | **public** | GET server runtime context — the contract-version handshake (plan §6.4) |
| `/health` | Entry | public | Liveness probe |
| `/guardian/health` | Entry | public | Guardian reachability probe |
| `/api/setup/*` | Host | setup localhost | 19 endpoints: `status`, `system-check`, `recommend`, `detect-providers`, `current-config`, `complete`, `deploy-status`, `retry-deploy`, `host-status`, `import-host`, `models/[provider]`, `ollama-profiles`, `voice-profiles`, `opencode/{ensure,status,providers,auth/[provider],provider/[provider]/oauth/{authorize,callback}}` |
| `/api/connections`, `/api/connections/[id]`, `/api/connections/active` | Connection | `requireCapability('connections:manage')` | Connection CRUD + activation (Phase 2, #486) |
| `/api/speak`, `/api/transcribe` | Assistant | requireAdmin | Voice TTS/STT relays |
| `/api/electron/update-status` | Host | (Electron harness) | Control-plane self-update status |
| `/proxy/assistant/[...path]` | Assistant | requireAdmin (same-origin cookie) | Same-origin assistant broker; resolves the active connection per request. Host app only (plan §6.4) |
| `/admin/auth/{login,logout,session}` | Entry | public (login) / session | Session lifecycle |
| `/admin/*` (everything below) | Host | admin gate + requireAdmin per endpoint | Phase 4 moves these under `/api/host/*` semantics with `host:*` capability guards |

`/admin/*` JSON endpoints (all admin gate + requireAdmin):

- Stack: `install`, `uninstall`, `update`, `unlock`, `health`, `logs`,
  `config/validate`, `backups`
- Containers: `containers/{list,up,down,restart,pull,stats,events}`
- Versions: `versions`, `versions/{latest,releases,ui}`, `ui-version`
- Add-ons: `addons`, `addons/[name]`, `addons/[name]/credentials`
- Automations: `automations`, `automations/[name]/{file,log,run}`
- AKM: `akm`, `akm/{health,health-report,stats,reindex,host-sharing}`,
  `akm/embedding/{detect,test}`
- Assistant/persona: `assistant`, `voice`
- Providers: `providers`, `providers/[id]`, `providers/{host-status,import-host}`,
  `providers/assistant-clis`, `providers/assistant-clis/[toolId]/use-provider`,
  `providers/oauth/{start,finish}`, `providers/oauth/[providerId]/callback`,
  `opencode/model`, `opencode/providers/[id]/{auth,models}`
- Secrets: `secrets`, `secrets/[name]`, `secrets/user-env`, `secret-notice`
- Connections (legacy JSON alias, this release only):
  `endpoints`, `endpoints/[id]`, `endpoints/active`

## Chrome composition (#555)

| Module | Used by | Imports chat modules? |
|---|---|---|
| `lib/components/chrome/Navbar.svelte` | `/admin` | **No** — brand + capability-driven chat/host buttons (`runtimeContext.routes` + `hasCapability()`) + theme toggle |
| `lib/components/chrome/ChatNavbar.svelte` | `/advanced`, `/connections` | Yes — composes the shell with `EndpointSwitcher`, `SessionPicker`, `VoiceControl`, `ModeSwitch` |
| `/chat` corner chrome | `/chat` | Chat page renders its own minimal corner chrome and hides the navbar |

Hygiene is enforced by unit tests:
`src/lib/features-admin-hygiene.vitest.ts` (no component reads the legacy
admin flag), `src/lib/components/chrome/chrome-untangle-hygiene.vitest.ts`
(the chrome the admin surface mounts imports no chat modules) and
`src/routes/chat/page-imports.vitest.ts` (chat page never imports the
`$lib/api.js` barrel).

## Testing

The landing matrix is unit-tested in `src/lib/resolve-landing.vitest.ts`; the
hooks routing in `src/hooks.server.landing.vitest.ts` and
`src/hooks.server.vitest.ts`. Playwright coverage lives in
`e2e/setup-guard.pw.ts` (guard/landing smoke) and the `*.stack.ts` suites;
browsers cannot be downloaded in the sandboxed CI container, so the Playwright
suites run only in environments with a real browser + Docker.
