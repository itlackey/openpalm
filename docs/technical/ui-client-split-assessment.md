# UI Client Split — Decision Record

**Date:** 2026-07-06
**Status:** RATIFIED
**Repo:** `itlackey/openpalm`
**Revises:** `docs/technical/ui-runtime-modes-plan.md` (Phases 5–6 scope)
**Related issues:** #486 (remote-only install), #509 (RuntimeContext), #510 (assistant-container), #511 (PWA), #506 (styling), #435 (guardian auth)

---

## 1. Decision

**Split the client, not the admin.**

- `packages/ui` (`@openpalm/ui`) remains what it already is: the **host control plane** — an
  `adapter-node` SvelteKit app (setup wizard, `/host` admin, secrets, Docker lifecycle,
  connection CRUD) served loopback-only by the harness (Electron or CLI). It is not split
  into a new package; it *sheds* the chat surface instead.
- A new **`packages/client`** (`@openpalm/client`) carries the end-user surface: chat,
  connection switching, assistant settings views. It is a static, PWA-installable SvelteKit
  app (`adapter-static` + `@vite-pwa/sveltekit`) with **one uniform transport**: connect to a
  guardian/OpenCode base URL with credentials — same code whether that URL is
  `127.0.0.1`, a LAN host, or a remote instance.
- Shared look and feel lives in **`packages/ui-kit`** (components, icons, theme tokens),
  consumed as a raw-source workspace package (no publish step; inlined at build time by
  both apps).
- The PWA ships with **two primary install origins**:
  1. **Localhost** — the harness/CLI serves the static client on a stable loopback port;
     `http://127.0.0.1:<port>` is a secure context, so it installs with zero TLS setup.
  2. **Official hosted URL** — e.g. `https://app.openpalm.dev`: a canonical, centrally
     TLS-terminated origin serving the same static client, giving phones/tablets a single
     install that connects to any of the user's instances.
- Phases 1–4 of `ui-runtime-modes-plan.md` (RuntimeContext/capabilities, `/connections`,
  landing resolver, `/host` + control-plane API split) proceed **unchanged** — they are
  prerequisites for the split and for every alternative considered.
- `openpalm admin` (the plan's `host-ui` mode) ships **early**: the CLI already serves the
  UI loopback-only with password auth; enabling the admin capability there is a small,
  proven pattern (Syncthing, code-server, Prisma Studio all default to a loopback-only
  admin web UI).
- **Guardian edge TLS + CORS** becomes its own tracked workstream. It is a hard
  prerequisite for the hosted-origin install path connecting to LAN instances (mixed
  content), and independent of any packaging choice.

## 2. Context (verified 2026-07-06, v0.12.52)

- The UI package is one `adapter-node` app of ~44k LOC source. Admin/setup routes plus
  admin components are ~22.5k LOC; chat is ~6.6k. There are 59 `/admin/*` server endpoints
  and 19 `/api/setup/*` endpoints vs. one chat proxy. "Splitting out the admin" would mean
  moving four-fifths of the app; extracting the client moves one-fifth.
- Admin is already effectively harness-only: `features.admin` requires `OP_INSIDE_ELECTRON=1`
  or `OP_ENABLE_ADMIN=1` (`packages/ui/src/lib/server/features.ts`), and the CLI sets
  neither — a CLI-served UI today is chat + setup wizard only.
- The Electron app is a genuinely thin harness (~2,400 LOC; #495, shipped 0.12.0): it spawns
  the same SvelteKit build the CLI runs, on `127.0.0.1:3880`, and self-updates the control
  plane from npm. Nothing on the Electron side needs restructuring.
- Instance switching exists (`endpoints.json`, `EndpointSwitcher`, per-request resolution in
  `/proxy/assistant/[...path]`) but is **server-side per host process** — the chat client
  assumes same-origin + cookie auth. A phone PWA needs client-held connections and direct
  cross-origin calls; that transport does not transfer.
- `containers/assistant/entrypoint.sh` already installs `@openpalm/ui` + `@openpalm/skeleton`
  at startup and launches a UI co-process (unexposed; see plan §6.9 as-landed notes).
- No PWA assets exist (no manifest, no service worker, no `@vite-pwa/sveltekit`).
- Plan status: Phase 0 (`@openpalm/skeleton`, #508) landed (with deltas — see plan
  "As-landed corrections"); Phases 1–8 not started. `/admin`, `/splash`, `FeatureFlags`
  are still current.

## 3. Options considered

### A — One app, capability-gated everywhere (plan as originally written)

One `adapter-node` artifact for all four host modes; capabilities hide features; PWA is the
same build plus manifest + service worker.

- Cheapest incremental path; single release artifact; Open WebUI precedent.
- **Rejected as the Phase 5–6 shape** because: (a) the transport still forks internally —
  host modes chat through a same-origin server proxy with cookies while PWA mode needs
  direct cross-origin guardian calls with Basic/Bearer, so the "one code path" claim breaks
  exactly where it matters; (b) every deployment (including the assistant container) ships
  all host-admin server endpoints and the inlined control-plane lib, relying on runtime
  403s (Phase 7 negative tests become permanently load-bearing); (c) an official hosted
  install origin is impossible — you cannot host a machine-bound `adapter-node` control
  plane at `app.openpalm.dev`.

### B — Split admin/setup into a new package now

- **Rejected.** Admin+setup is ~80% of the app with the deepest server coupling
  (`hooks.server.ts`, sessions, Docker, secrets, `@openpalm/lib`). The destination would
  look exactly like what `packages/ui` already is: an adapter-node control-plane app served
  loopback-only by the harness. Weeks of churn to arrive where we already are, and the
  entanglements that make it expensive (Navbar↔chat imports, `endpoints-state`↔`chat-state`,
  the `$lib/api.js` barrel) are removed by Phases 1–4 anyway.

### C — Phases 1–4 unchanged + `openpalm admin` now; extract a thin client at the Phase 5/6 fork — **RATIFIED**

- The split happens *after* Phases 2–4 have moved connections out of chat state and split
  the API namespaces — at that point it is mostly moving files, not untangling them.
- Each artifact ends with one transport model, one audience, one reason to change:
  - host app: server-proxied, cookie-auth, loopback, privileged;
  - client app: direct API consumer with client-held connections, static, unprivileged.
- Enables both PWA install origins (§1) — the hosted origin *requires* a static client.
- Structural exclusion of host-admin code from containers and from the PWA bundle
  (defense in depth beyond runtime 403s), smaller container npm pull, no `@openpalm/lib`
  in the client at all.
- Honest costs: a second build/release unit; a shared `ui-kit` package to keep healthy;
  assistant-container mode needs a small server for `/api/assistant/*` writes (static
  client cannot write persona files) — a minimal sidecar rather than the full control
  plane; a version-skew handshake between hosted client and instance APIs (`/api/runtime`
  contract version, already in the plan).

### D — Minimal: `openpalm admin` + TLS docs only, defer PWA/container modes

- Fine as a stopgap; abandons #510/#511 and leaves mobile as an un-installed browser tab.
  Only right if 0.13.0 must shrink. Not chosen, but note that its two cheap items
  (`openpalm admin`, TLS docs) are included in C anyway.

## 4. Evidence

External findings that decided the shape (researched 2026-07-06):

1. **PWA install requires a secure context** — HTTPS or `localhost`/`127.0.0.1`. A UI served
   over plain HTTP from a LAN IP is not installable, period.
   (MDN: Making PWAs installable — developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
2. **Mixed content:** an HTTPS-served page cannot `fetch()` plain-HTTP LAN endpoints. So the
   hosted-origin install path requires TLS on any guardian it connects to (Tailscale
   `ts.net` certs and Caddy are the proven homelab paths). A `http://127.0.0.1` origin is
   *not* subject to mixed-content blocking and — being the most-trusted tier under Chrome's
   Private Network Access model — may call plain-HTTP LAN guardians. This is why the
   localhost install path works with zero TLS setup and the hosted path needs the TLS
   workstream.
3. **PWA identity is per-origin** (one installed app = one origin; `start_url` must be
   same-origin). Multi-instance switching must be an in-app connection switcher against
   multiple backend APIs — which `/connections` + IndexedDB already design correctly — and
   a single canonical hosted origin means one install serves all instances.
   (web.dev/articles/multi-origin-pwas)
4. **SvelteKit has no supported per-build route exclusion** (`config.kit.routes` was removed;
   kit#6031). Route groups gate access but ship the code. Two thin apps sharing a workspace
   component package is the grain-of-the-tool pattern (official Turborepo Svelte example;
   `svelte-package` or raw-source workspace exports).
5. **Electron security guidance** — privileged windows load local/loopback content, never
   remote; OpenPalm already complies and nothing about the harness changes under this
   decision. (electronjs.org/docs/latest/tutorial/security)
6. **Prior art:** Open WebUI keeps one capability-gated app, but its "admin" is same-process
   settings, not host Docker control. Platforms whose admin holds host-level power (Umbrel,
   CasaOS, Rancher Desktop) separate the platform UI from app UIs. Loopback-only
   CLI-launched admin web UIs are a proven pattern (Syncthing, code-server, Prisma Studio,
   Drizzle Studio). Expo's sunset web UI is the cautionary tale: keep the second surface
   thin — which the client (not the admin) is.
7. **`@vite-pwa/sveltekit`** is the mature tooling path for the client app (SvelteKit 2,
   Workbox precache, adapter-static + SPA fallback).

## 5. Consequences

1. `ui-runtime-modes-plan.md` Phases 5–6 are re-scoped (see the plan's revision note):
   assistant-container pulls `@openpalm/client` (+ a minimal assistant-settings API sidecar)
   instead of the full `@openpalm/ui`; PWA work lands in `packages/client`.
2. New release units: `@openpalm/client` (npm, exact-pin delivery like the UI) and the
   hosted static deploy (CI publish of the client build to the official URL). `ui-kit` is
   workspace-internal and not published.
3. Guardian grows a CORS allowlist (the official origin + configurable extras) and the TLS
   workstream lands at its edge. Coordinates with #435 (auth) — credentials over HTTPS only
   for remote connections.
4. The `/api/runtime` public endpoint doubles as the version-skew handshake for the hosted
   client (client checks the instance's advertised contract version before enabling
   features).
5. `packages/ui` keeps a chat surface only until the client app reaches parity in Electron
   (the harness serves the client build alongside the host app; Electron users keep one
   window). After that, chat code is deleted from `packages/ui`.

## 6. What this does **not** change

- Electron thin-harness architecture (#495), the harness contract, and the artifact
  delivery pattern (exact-pin npm for platform components) all stay as-is; `@openpalm/client`
  simply becomes one more exact-pinned artifact.
- Host admin remains loopback-only with the `op_session` cookie. The client app never
  holds host credentials.
- `resolveCapabilities()` remains the single capability-resolution point *within each app*;
  the split reduces how much it must express (the client never resolves `host:*`).
