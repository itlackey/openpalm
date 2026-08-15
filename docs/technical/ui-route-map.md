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

The **client-only lane** is the same `@openpalm/ui` build served by stack-less
`openpalm app` or installed as a PWA. It exposes Entry, Assistant, and Connection
routes, but has no `host:*` capabilities: `/host` redirects away and
`/api/host/*` returns 403. Its canonical local origin is
`http://localhost:${OP_HOST_UI_PORT:-3880}`. There is no separate client package
or client-only runtime mode.

## Landing resolution

Every document navigation to `/` (and the legacy `/splash` path) is redirected
by `hooks.server.ts` to the landing resolved by `resolveLanding(ctx,
launchState)` (`src/lib/resolve-landing.ts`):

Being ABLE to host (the `host:setup` capability) and actually HOSTING it
(`OP_HOST_ENABLED`, recorded by an install) are different things. Only both
together select the host rows — a host-capable process that hosts nothing wants
exactly what a plain client wants, which is why there is one client row rather
than a second branch.

| Condition (in precedence order) | Landing |
|---|---|
| hosting + migration pending | `/attention` |
| hosting + local `installed_broken` | `/host?tab=diagnostics` |
| hosting + local `installed_offline` | `/host` |
| hosting + local `running` | `/chat` |
| hosting, anything else | `/setup` |
| not hosting, nowhere to chat | `/connections/new?onboarding=1` |
| not hosting, somewhere to chat | `/chat` |

"Somewhere to chat" is either a server-visible connection or the browser's own,
reported by the `op_has_connections` hint below.

`/connections/new?onboarding=1` finishes the decision in the browser, where the
IndexedDB connection list is authoritative. Its first screen is the
install-or-connect choice, shown only to a host-capable process — a client-only
browser or standalone PWA has no stack to install and goes straight to the
connect form.

The launch-routing guard fires **before** the auth guard, so `/` and stale
`/splash` bookmarks never bounce through `/login` first. `/splash` no longer
exists as a route; the path keeps redirecting to the resolved landing for this
release only.

## Guards (defined in `src/hooks.server.ts` unless noted)

- **auth** — document navigations (GET + `Accept: text/html`) without a valid
  `op_session` cookie redirect to `/login?redirectTo=…`. API/data requests are
  left to the endpoint's own JSON 401.
- **host capability gate** — `/host/*` pages require the server to advertise
  the `host:*` capability set (an admin-capable process — Electron or `openpalm
  admin`); otherwise redirects to `/chat`. UX only — the security boundary is
  per-endpoint.
- **not-installed `/host` (NOT a guard)** — the admin surface renders its own
  not-installed state from `(app)/host/+page.server.ts`. It is deliberately a
  page load rather than a redirect: a `load` runs for client-side navigations
  too, which the `Accept: text/html` guards above never see, and the in-app
  admin button is exactly such a navigation. `/host` also joins the client-only
  public lane in this state so removing the old redirect cannot strand a
  first-run admin process at a `/login` that answers 503.
- **`OP_HOST_ENABLED` (a recorded fact, not a guard)** — whether this machine
  hosts a stack, written to `state/stack.env` by an install (`markSetupComplete`
  and the CLI's `prepareInstallFiles`) and read by `readHostEnabled`. Default
  false; `isSetupComplete` answers for installs that predate the flag, so no
  migration is needed. It exists because the managed `system/` tree is re-seeded
  on every launch, so disk state says only "the app has run here" — reading
  intent out of it pinned anyone using a remote assistant to a local-install
  wizard on every restart.
- **`op_has_connections` (client hint, not a guard)** — a boolean cookie the
  browser writes so the landing can tell whether THIS browser has connections;
  they live in IndexedDB and are otherwise invisible to the server, and one
  server can be serving many browsers. Client-controlled and therefore never an
  authorization: it only picks between two public client routes.
- **requireAdmin()** — per-endpoint session check in `+server.ts` handlers
  (`$lib/server/helpers.js`); JSON 401, never an HTML redirect.
- **requireCapability(cap)** — per-endpoint server-side capability check
  (`hasCapability()` in components is UX only). Every
  `/api/host/*` endpoint carries one (enforced by
  `src/routes/api/host/guard-hygiene.vitest.ts`), as does every
  `/api/assistant/*` endpoint — a valid admin session in a mode without the
  capability is still refused with 403 `capability_not_available`.
- **setup localhost + capability** — SEC-4: `/setup` + mutating
  `/api/setup/*` require `host:setup`. They are unauthenticated before first-run
  completes but restricted to a loopback browser origin; after completion,
  re-runs require admin auth. `/api/setup/status` remains public.
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
| `/advanced` | Assistant | auth | Embedded OpenCode web UI — framed at the connection when it is itself an OpenCode origin, otherwise at the **workspace listener** on the server's `opencodeWorkspace` port (the locked `/oc` connection is an API proxy, and OpenCode's UI is a root-mounted SPA, so it needs an origin whose root is OpenCode). The address is composed from the page the browser is on — same host, same scheme, that port — then probed; an address nothing answers falls back to the native chat surface. `routes/(app)/advanced/embeddable.ts` owns the whole classification and is the place to read it. Mounts `ChatNavbar` (chat chrome composition) |
| `/connections` | Connection | auth (page); `connections:manage` UX-gates the manager | Connection manager over the browser-owned (IndexedDB) list; Add and pairing deep links continue to `/connections/new` |
| `/connections/new` | Connection | narrow pre-auth first-run lane | Pairing-first remote onboarding wizard. It verifies the candidate before browser persistence, stores it as active, and continues to Chat; manual address entry is the secondary path. With `?onboarding=1` on a host-capable process its first screen is the install-or-connect choice (the retired `/start` route folded into it), and Back steps back to that choice rather than leaving |
| `/host` | Host | host capability gate + auth | Dashboard (tabbed); mounts the chat-free `Navbar` shell (#555); honors `?tab=diagnostics` (Systems tab). On a host with **no install** it renders a not-installed notice plus a link to `/setup` instead of the tabs, and starts no loaders or polling — page-rendered by `(app)/host/+page.server.ts`, not a guard (see below) |
| `/admin`, `/admin/*` | — | none | **404.** Dead namespace since Phase 4 (the Phase 2 `/admin/endpoints` → `/connections` alias is gone too) |

## API routes

| Namespace | Surface | Guard | Endpoints |
|---|---|---|---|
| `/api/runtime` | Entry | **public** | GET context for the process serving this UI; not a remote-OpenPalm handshake |
| `/api/runtime/landing` | Entry | **public**, `no-store` | GET the current server-side landing decision without a document redirect |
| `/api/runtime-config` | Entry | **public**, `no-store` | GET the launcher-scoped, credential-free connection seed; 404 selects the assistant container's static `/runtime-config.json` fallback |
| `/health` | Entry | public | Liveness probe |
| `/guardian/health` | Entry | public | Guardian reachability probe |
| `/api/auth/{login,logout}` | Entry | public (login) / session | Session lifecycle. Deliberately **outside** `/api/host` — a capability guard on login would lock a served (non-admin) deployment out before it could authenticate |
| `/api/setup/*` | Host | `host:setup` + setup localhost; admin session after completion | 18 endpoints: `status`, `system-check`, `recommend`, `detect-providers`, `current-config`, `complete`, `deploy-status`, `retry-deploy`, `host-status`, `import-host`, `models/[provider]`, `ollama-profiles`, `voice-profiles`, `opencode/{ensure,status,providers,provider/[provider]/oauth/{authorize,callback}}` |
| `/api/connections/pairing` | Connection | requireAdmin + `requireCapability('host:stack:write')` | POST-only: host-mints a one-time QR/pairing code against the LOCAL guardian (#511). Another device uses an external camera/QR app or pastes the code; the UI has no embedded camera scanner. The connection LIST itself is browser-owned (IndexedDB) — there is no server-side connection CRUD |
| `/api/assistant/*` | Assistant | requireAdmin + `requireCapability('assistant-settings:read'/'write')` | Assistant-owned settings — editable from a non-admin served build: `persona` (config/assistant/persona.md), `akm` (config/akm/config.json), `model` (OpenCode default/small model) |
| `/api/host/*` | Host | requireAdmin + `requireCapability('host:…')` per endpoint | Privileged host control plane (see below); 403 `capability_not_available` in a non-admin process even with a valid session |
| `/oc/[...path]` | Assistant | requireAdmin (session only — no capability) | Transparent same-origin pass-through to **this process's own** OpenCode (`getAssistantOpencodeTarget()`), Basic auth attached server-side when `OPENCODE_AUTH` is on. Not to be confused with Guardian's own `/oc/*` — a different server, port, and auth model, reached only by external/portal clients, never by this route; see [`api-spec.md`](api-spec.md#oc-proxy-disambiguation) for the full disambiguation |
| `/voice/[...path]` | Assistant | requireAdmin (session only — no capability) | Transparent same-origin pass-through to the local voice container's OpenAI surface (the chat client's "OpenPalm Voice" provider transport); 503 when the process can't serve it |

`/api/host/*` JSON endpoints (each carries requireAdmin + the listed
`requireCapability` guard):

- Stack (`host:setup`/`host:stack:*`/`host:recovery`/`host:logs`): `install`,
  `uninstall`, `update`, `unlock`, `health`, `logs`, `config/validate`,
  `backups`, `stack` (project name + bind address — the host half of the old
  assistant tab)
- Containers (`host:containers`): `containers/{list,up,down,restart,pull,stats,events}`
- Versions (`host:updates`): `versions`, `versions/releases`
- Add-ons (`host:addons`): `addons`, `addons/[name]`, `addons/[name]/credentials`
  — voice is a normal addon here (enable/disable + hardware profile +
  bring-up job polling); client TTS/STT provider choice is browser-owned
  (see `voice-settings-architecture.md`), so there is no host voice-config
  endpoint and no `/api/speak`/`/api/transcribe` relay
- Automations (`host:stack:*`/`host:logs`): `automations`, `automations/[name]/{file,log,run}`
- AKM host-level (`host:containers`, `host:akm-sharing`, `host:stack:read`):
  `akm/{health,health-report,stats,reindex,host-sharing}`,
  `akm/embedding/{detect,test}` — the assistant-scoped AKM config lives at
  `/api/assistant/akm`
- Providers (`host:secrets`): `providers`, `providers/[id]`,
  `providers/{host-status,import-host}`,
  `providers/oauth/{start,finish}`, `providers/oauth/[providerId]/callback`,
  `opencode/providers/[id]/{auth,models}`
- Secrets (`host:secrets`): `secrets`, `secrets/[name]`, `secrets/user-env`, `secret-notice`

## Chrome composition (#555)

| Module | Used by | Imports chat modules? |
|---|---|---|
| `lib/components/chrome/Navbar.svelte` | `/chat`, `/advanced`, `/connections`, `/host` | **No** — shared brand and surface-control shell |
| `lib/components/chrome/SurfaceToolbar.svelte` | `/chat`, `/advanced`, `/connections`, `/host` | **No** — four route-exclusive `IconButton` destinations: Chat, Advanced, Settings, Host |
| `lib/components/chrome/ChatNavbar.svelte` | `/chat`, `/advanced` | Yes — composes the shell with `EndpointSwitcher` and `SessionPicker` where conversation context is shown |

Hygiene is enforced by unit tests:
`src/lib/features-admin-hygiene.vitest.ts` (no component reads the legacy
admin flag), `src/lib/components/chrome/chrome-untangle-hygiene.vitest.ts`
(the chrome the admin surface mounts imports no chat modules),
`src/routes/api/host/guard-hygiene.vitest.ts` (every
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
