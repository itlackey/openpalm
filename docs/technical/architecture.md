# OpenPalm Architecture — One UI

> Authoritative overview of the app/UI architecture after the "One UI, delete the
> split" refactor. For the platform's filesystem/security contract see
> [`core-principles.md`](./core-principles.md); for the Guardian ingress boundary
> see [`openpalm-opencode-boundary.md`](./openpalm-opencode-boundary.md).

## One UI

There is a single front-end package, **`@openpalm/ui`** (SvelteKit,
`adapter-node`). The same build is:

- **container-served** — a supervised co-process inside the assistant container,
- **run in Electron** — the thin desktop harness loads it, and
- **origin-portable** — it derives its origin from the request and couples to no
  host, so any origin that serves it is a valid front door (this is the property
  a PWA install builds on).

There is no second app and no "runtime modes" matrix: the UI behaves the same
everywhere it runs and is only ever *more* capable when launched as an admin
process (below).

> **PWA install status:** a basic installable PWA ships in 0.13.0 (#511): a
> `manifest.webmanifest`
> with square + maskable icons (`packages/ui/static/`) is linked from
> `app.html`, and a SvelteKit-native service worker
> (`packages/ui/src/service-worker.ts`) caches only hashed build assets and
> static assets. Every page navigation, `/api/*` route (including auth and SSE),
> `/login`, and `/voice/*` stays network-only so no page, credentialed response,
> or stream is served stale. Offline queueing and offline chat are not shipped.

## The UI is a self-contained browser app

The browser owns its own state:

- **Connections live in the browser.** A connection is exactly
  `{ id, label, baseUrl, auth }` — no connection "kinds", no `/oc` inference.
  The list is persisted in **IndexedDB** (`$lib/connections/store.ts`). Host
  processes seed it through process-scoped `/api/runtime-config`; the assistant
  container retains a static `/runtime-config.json` fallback.
- **Credentials live in the browser, encrypted.** Basic passwords are wrapped
  with **WebCrypto AES-GCM** under a non-extractable per-storage key
  (`$lib/connections/secrets.ts`); the connection entry carries only a
  `secretRef`, never plaintext.
- **Locality / Guardian-ness is derived from the URL**, never a kind. The user
  supplies the exact base URL (including `/oc` when it points at a Guardian).

## One transport, one session model, one event parser

The browser talks to each connection's OpenCode API **directly**
(`$lib/transport/direct.ts`: `fetch(baseUrl + path)`, `credentials: 'omit'`,
per-connection Basic auth) — there is no host proxy. Session handling and event
parsing reuse the single existing `$lib/chat/*` helpers regardless of whether the
target is a raw OpenCode server or a Guardian. Multiple assistants and switching
between them work in every surface, always.

## Guardian is a transparent OpenCode proxy

The Guardian (`@openpalm/guardian`) is a **transparent 1:1 reverse proxy** in
front of an assistant's OpenCode server: it forwards every method/path/query/body
and streams responses (including SSE) untouched, stripping only hop-by-hop headers
and the inbound Guardian credentials (upstream credentials are injected
server-side). Because the proxy is transparent, the browser speaks native
OpenCode whether the URL is a raw OpenCode server or a Guardian `/oc` base.

The fail-closed policies remain, as **overlays** on the handful of tenant-scoped
paths — never an allowlist and never a second protocol:

- per-call HTTP Basic auth (the principal id is the Basic username),
- session + permission **ownership** (persisted in the Guardian SQLite state DB,
  so a restart no longer orphans live sessions),
- `/event` tenant filtering (own-session frames only, native framing +
  `Last-Event-ID` preserved), and
- fail-closed content moderation of the two prompt-bearing writes.

## Admin is an Electron/CLI-only security boundary

Admin (host stack management, setup) is **not a UI mode** — it is a boundary. A
process is admin-capable only when launched by Electron (`OP_INSIDE_ELECTRON=1`)
or the CLI (`openpalm admin`, `OP_ENABLE_ADMIN=1`). A served / container / PWA
build sets neither and therefore never receives any `host:*` capability — its
`host/setup/admin` routes 403/404. There is no `OP_UI_HOST_MODE` self-grant. The
`serverCapabilities` computation is a single boolean (`isAdminCapable()`), and the
CLI admin path stays direct.

## Serving surfaces

| Surface | How the same `@openpalm/ui` build runs | Admin? |
|---|---|---|
| **Assistant container** | supervised adapter-node co-process, loopback-first bind, rootless, no docker socket, no host `OP_HOME`/creds | no (`OP_ENABLE_ADMIN` unset) |
| **Electron** | thin native harness spawns the build; carries the admin boundary | yes |
| **CLI** (`openpalm admin`) | host process serves the build with the admin boundary | yes |
| **CLI** (`openpalm app`) | stack-less local client entry; serves the build without requiring or starting a local stack | no |
| **PWA** | installed from the canonical local origin `http://localhost:${OP_HOST_UI_PORT:-3880}` or an operator-provided HTTPS origin | inherits that origin (no admin) |

The user-facing local PWA URL uses `localhost`; the host process may still bind
and probe `127.0.0.1` internally. Remote HTTPS origins are operator-provided and
must be added exactly to Guardian's CORS allowlist. TLS terminates in external
infrastructure such as Tailscale or Caddy. OpenPalm does not deploy
`app.openpalm.dev` or grant it CORS access by default in 0.13.0.

Electron's embedded window preserves its existing exact
`http://127.0.0.1:<port>` origin so upgrades retain origin-scoped IndexedDB and
WebCrypto state. That internal compatibility surface does not define a second
PWA origin and is not a user-facing install URL.

When OpenCode is bound off-loopback with `OPENCODE_AUTH` off, the container logs
a prominent exposure warning and continues starting the UI.
