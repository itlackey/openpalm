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
- **installable as a PWA** — from whichever origin serves it.

There is no second app. The old `@openpalm/client` SPA and the `UiHostMode`
"runtime modes" matrix are gone; the UI behaves the same everywhere it runs and
is only ever *more* capable when launched as an admin process (below).

## The UI is a self-contained browser app

The browser owns its own state:

- **Connections live in the browser.** A connection is exactly
  `{ id, label, baseUrl, auth }` — no connection "kinds", no `/oc` inference.
  The list is persisted in **IndexedDB** (`$lib/connections/store.ts`), seeded
  once from a `runtime-config.json` served next to the build.
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
| **CLI** (`openpalm admin` / `openpalm app`) | host process serves the build | admin only for `openpalm admin` |
| **PWA** | installed from the served origin | inherits that origin (no admin) |

The container co-process keeps the already-landed LAN-exposure safety gate:
it refuses to publish an unauthenticated UI when OpenCode is bound off-loopback
with `OPENCODE_AUTH` off.
