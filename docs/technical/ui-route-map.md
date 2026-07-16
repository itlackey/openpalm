# UI Route Map

**Package:** `packages/ui` (`@openpalm/ui` — the single UI, served in the
container / Electron / as a PWA; see [`architecture.md`](./architecture.md))
**Status:** current truth. `/admin/*` is a **dead namespace** (router 404, no
alias): pages live at `/host`, privileged JSON endpoints at `/api/host/*`,
assistant-owned settings at `/api/assistant/*`, session lifecycle at
`/api/auth/*`. Chat and connections views live in this one package — there is
no separate client app.

Surfaces: **Host** = host control plane (stack lifecycle, secrets,
privileged ops), **Assistant** = chat against the active connection +
assistant-owned settings, **Connection** = connection management, **Entry** =
landing/auth/first-run plumbing shared by all surfaces.

## Landing resolution

Every document navigation to `/` (and the legacy `/splash` path) is redirected
by `hooks.server.ts` to the landing resolved by `resolveLanding(ctx,
launchState)` (`src/lib/resolve-landing.ts`):

| Condition (in precedence order) | Landing |
|---|---|
| `host:setup` capability + migration pending | `/attention` |
| `host:setup` + local `not_installed` (no accessible connection) | `/setup` |
| `host:setup` + local `not_installed` (accessible connection exists, #440) | `/chat` |
| `host:setup` + local `setup_incomplete` | `/setup` |
| `host:setup` + local `installed_offline` | `/host` |
| `host:setup` + local `installed_broken` | `/host?tab=diagnostics` |
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
- **host capability gate** — `/host/*` pages require the server to advertise
  the `host:*` capability set (`electron-host`/`host-ui`); otherwise redirects
  to `/chat`. UX only — the security boundary is per-endpoint.
- **requireAdmin()** — per-endpoint session check in `+server.ts` handlers
  (`$lib/server/helpers.js`); JSON 401, never an HTML redirect.
- **requireCapability(cap)** — per-endpoint server-side capability check
  (`hasCapability()` in components is UX only). Every
  `/api/host/*` endpoint carries one (enforced by
  `src/routes/api/host/guard-hygiene.vitest.ts`), as does every
  `/api/assistant/*` endpoint — a valid admin session in a mode without the
  capability is still refused with 403 `capability_not_available`.
- **setup localhost** — SEC-4: `/setup` + `/api/setup/*` are unauthenticated
  before first-run completes but restricted to loopback clients (unless
  `OP_ALLOW_REMOTE_SETUP`); after completion, re-runs require admin auth.
- **host/origin** — SEC-1/SEC-2 Host-header allowlist + Origin check apply to
  every request; host admin stays loopback-only.

`/admin/*` has **no guard and no alias**: hooks let it fall through to the
router, which 404s because the route tree is deleted.

## Page routes

| Path | Surface | Guard | Notes |
|---|---|---|---|
| `/` | Entry | launch-routing (pre-auth) | Never renders: hooks (document nav) + `+page.server.ts` (client-side nav) redirect to the resolved landing |
| `/splash` | Entry | launch-routing (pre-auth) | **Route removed** in Phase 3; the path 302s to the resolved landing for this release |
| `/attention` | Entry | auth | Migration/blocking surface split out of `/splash`; landing when `migration.status === 'pending'` (no producer yet) |
| `/login` | Entry | public | Password login; posts to `/api/auth/login`, which issues the `op_session` cookie |
| `/setup` | Host | setup localhost | First-run wizard; `?rerun=1` after completion requires admin auth |
| `/chat` | Assistant | auth | Stillness chat; own corner chrome (hides the navbar); imports domain clients directly, never the `$lib/api.js` barrel (#555) |
| `/advanced` | Assistant | auth | Embedded OpenCode web UI; mounts `ChatNavbar` (chat chrome composition) |
| `/connections` | Connection | auth (page) + `connections:manage` (its API) | Connection manager; mounts `ChatNavbar`; `?new=1` opens the add form |
| `/connections/new` | Connection | auth | pwa-static "no connections yet" landing; 302 alias to `/connections?new=1` |
| `/host` | Host | host capability gate + auth | Dashboard (tabbed); mounts the chat-free `Navbar` shell (#555); honors `?tab=diagnostics` (Systems tab) |
| `/admin`, `/admin/*` | — | none | **404.** Dead namespace since Phase 4 (the Phase 2 `/admin/endpoints` → `/connections` alias is gone too) |

## API routes

| Namespace | Surface | Guard | Endpoints |
|---|---|---|---|
| `/api/runtime` | Entry | **public** | GET server runtime context — the contract-version handshake |
| `/health` | Entry | public | Liveness probe |
| `/guardian/health` | Entry | public | Guardian reachability probe |
| `/api/auth/{login,logout,session}` | Entry | public (login) / session | Session lifecycle. Deliberately **outside** `/api/host` — a capability guard on login would lock assistant-container out before it could authenticate |
| `/api/setup/*` | Host | setup localhost | 19 endpoints: `status`, `system-check`, `recommend`, `detect-providers`, `current-config`, `complete`, `deploy-status`, `retry-deploy`, `host-status`, `import-host`, `models/[provider]`, `ollama-profiles`, `voice-profiles`, `opencode/{ensure,status,providers,auth/[provider],provider/[provider]/oauth/{authorize,callback}}` |
| `/api/connections`, `/api/connections/[id]`, `/api/connections/active` | Connection | requireAdmin + `requireCapability('connections:manage')` | Connection CRUD + activation (Phase 2, #486 — stays here, not under `/api/host`) |
| `/api/assistant/*` | Assistant | requireAdmin + `requireCapability('assistant-settings:read'/'write')` | Assistant-owned settings — editable from assistant-container: `persona` (config/assistant/persona.md), `akm` (config/akm/config.json), `model` (OpenCode default/small model) |
| `/api/host/*` | Host | requireAdmin + `requireCapability('host:…')` per endpoint | Privileged host control plane (see below); 403 `capability_not_available` in assistant-container/pwa-static even with a valid session |
| `/api/speak`, `/api/transcribe` | Assistant | requireAdmin | Voice TTS/STT relays |
| `/api/electron/update-status` | Host | (Electron harness) | Control-plane self-update status |
| `/proxy/assistant/[...path]` | Assistant | requireAdmin (same-origin cookie) | Same-origin assistant broker; resolves the active connection per request. Host app only |

`/api/host/*` JSON endpoints (each carries requireAdmin + the listed
`requireCapability` guard):

- Stack (`host:setup`/`host:stack:*`/`host:recovery`/`host:logs`): `install`,
  `uninstall`, `update`, `unlock`, `health`, `logs`, `config/validate`,
  `backups`, `stack` (project name + bind address — the host half of the old
  assistant tab)
- Containers (`host:containers`): `containers/{list,up,down,restart,pull,stats,events}`
- Versions (`host:updates`): `versions`, `versions/{releases,ui}`, `ui-version`
- Add-ons (`host:addons`): `addons`, `addons/[name]`, `addons/[name]/credentials`
- Automations (`host:stack:*`/`host:logs`): `automations`, `automations/[name]/{file,log,run}`
- AKM host-level (`host:containers`, `host:akm-sharing`, `host:stack:read`):
  `akm/{health,health-report,stats,reindex,host-sharing}`,
  `akm/embedding/{detect,test}` — the assistant-scoped AKM config lives at
  `/api/assistant/akm`
- Voice (`host:stack:*`): `voice`
- Providers (`host:secrets`): `providers`, `providers/[id]`,
  `providers/{host-status,import-host}`, `providers/assistant-clis`,
  `providers/assistant-clis/[toolId]/use-provider`,
  `providers/oauth/{start,finish}`, `providers/oauth/[providerId]/callback`,
  `opencode/providers/[id]/{auth,models}`
- Secrets (`host:secrets`): `secrets`, `secrets/[name]`, `secrets/user-env`, `secret-notice`

## Chrome composition (#555)

| Module | Used by | Imports chat modules? |
|---|---|---|
| `lib/components/chrome/Navbar.svelte` | `/host` | **No** — brand + capability-driven chat/host buttons (`runtimeContext.routes` + `hasCapability()`) + theme toggle |
| `lib/components/chrome/ChatNavbar.svelte` | `/advanced`, `/connections` | Yes — composes the shell with `EndpointSwitcher`, `SessionPicker`, `VoiceControl`, `ModeSwitch` |
| `/chat` corner chrome | `/chat` | Chat page renders its own minimal corner chrome and hides the navbar |

Hygiene is enforced by unit tests:
`src/lib/features-admin-hygiene.vitest.ts` (no component reads the legacy
admin flag), `src/lib/components/chrome/chrome-untangle-hygiene.vitest.ts`
(the chrome the admin surface mounts imports no chat modules),
`src/routes/chat/page-imports.vitest.ts` (chat page never imports the
`$lib/api.js` barrel), `src/routes/api/host/guard-hygiene.vitest.ts` (every
`/api/host/*` endpoint calls `requireCapability`), and
`src/lib/api/admin-paths-hygiene.vitest.ts` (no client code calls or links a
dead `/admin` path).

## Testing

The landing matrix is unit-tested in `src/lib/resolve-landing.vitest.ts`; the
hooks routing in `src/hooks.server.landing.vitest.ts`,
`src/hooks.server.vitest.ts` and `src/hooks.server.admin-404.vitest.ts` (the
Phase 4 dead-namespace contract). Playwright coverage lives in
`e2e/setup-guard.pw.ts` (guard/landing smoke) and the `*.stack.ts` suites;
browsers cannot be downloaded in the sandboxed CI container, so the Playwright
suites run only in environments with a real browser + Docker.
