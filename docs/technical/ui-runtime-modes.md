# UI Runtime Modes

> **As built 2026-07-07**. This replaces `ui-runtime-modes-plan.md` as the current-state reference.

## Summary

OpenPalm now ships one UI product as two artifacts:

| Surface | Artifact | Runtime | Purpose |
|---|---|---|---|
| Host control plane | `@openpalm/ui` | Electron or `openpalm admin` host process | Host setup, lifecycle, logs, secrets, connections, assistant settings |
| Client app | `@openpalm/client` | Harness localhost server, assistant container static server, or hosted static origin | Chat, connection switching, installable PWA |

`@openpalm/ui-kit` is a shared raw-source workspace package consumed at build time by both apps. It is not published.

## Host Modes

`packages/ui/src/lib/server/features.ts` computes the server runtime context from `OP_UI_HOST_MODE` with these shipped values:

| `hostMode` | Served artifact | How it is entered | Server capabilities |
|---|---|---|---|
| `electron-host` | `@openpalm/ui` | Electron main process sets `OP_INSIDE_ELECTRON=1` / host mode env | Full host + assistant + connections surface |
| `host-ui` | `@openpalm/ui` | `openpalm admin` | Full host + assistant + connections surface without Electron IPC |
| `assistant-container` | `@openpalm/client` | Assistant container `start_client` co-process | Single locked connection chat surface; no host capabilities |
| `pwa-static` | `@openpalm/client` | Harness localhost app server or hosted static origin | Connection manager + chat; no host capabilities |

## Client Display Modes

The browser-side client context distinguishes:

| `clientDisplayMode` | Detection | Effect |
|---|---|---|
| `electron` | Electron user agent | Full server-provided host capabilities remain visible |
| `standalone-pwa` | `matchMedia('(display-mode: standalone)')` | PWA chrome/behavior |
| `browser` | Default | Regular browser behavior |

Capability resolution is centralized in the runtime-context store. The client artifact has no `host:*` capability types at all.

## Routing And Capability Shape

Current route baselines:

| Mode | Primary routes |
|---|---|
| `electron-host` / `host-ui` | `/host`, `/chat`, `/connections`, `/setup` |
| `assistant-container` | `/chat` |
| `pwa-static` | `/chat`, `/connections` |

Current namespaces:

| Namespace | Served by |
|---|---|
| `/api/runtime` | Host UI and host-served runtime context |
| `/api/auth/*` | Host UI |
| `/api/connections/*` | Host UI |
| `/api/assistant/*` | Host UI |
| `/api/host/*` | Host UI only |
| `/proxy/assistant/*` | Host UI only |

The assistant-container Slice A that shipped in Phase 5 is static-only. It serves `@openpalm/client` plus `runtime-config.json`; it does **not** ship the optional assistant-settings shim.

## Localhost Client Origin

There are two different client ports in the shipped system:

| Port | Owner | Meaning |
|---|---|---|
| `3890` | Harness localhost client server | Stable host-local origin for `openpalm app` and Electron's preferred client chat URL |
| `3810` by default | Assistant container compose port (`OP_CLIENT_PORT`) | Host-published port for the assistant container's own static client co-process |

The stable host-local origin is resolved by `packages/lib/src/control-plane/client-app-url.ts`:

- default: `http://127.0.0.1:3890/chat`
- override: `OP_HOST_CLIENT_PORT`
- deliberate non-input: `OP_CLIENT_PORT` does **not** affect this origin

That split is intentional. `OP_CLIENT_PORT` belongs to the assistant container artifact listener; `OP_HOST_CLIENT_PORT` belongs to the harness-served localhost app/PWA identity.

## Assistant-Container Mode

`containers/assistant/entrypoint.sh` installs runtime artifacts before booting OpenCode:

- `@openpalm/client`: `OP_CLIENT_VERSION` -> `PLATFORM_VERSION` -> hard error
- `@openpalm/skeleton`: `OP_SKELETON_VERSION` -> `PLATFORM_VERSION` -> hard error
- tools: `bun update --cwd /opt/openpalm/tools --production`

After install it writes `runtime-config.json` with one locked default connection pointing the browser at the host-published OpenCode URL:

- default URL: `http://127.0.0.1:${OP_ASSISTANT_PORT:-3800}`
- full override: `OP_CLIENT_DEFAULT_ASSISTANT_URL`

The static server itself binds `0.0.0.0` inside the container on port `3000`; Compose publishes it as `${OP_CLIENT_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_CLIENT_PORT:-3810}:3000`.

## PWA Delivery Modes

`packages/client` is an adapter-static SvelteKit app with `@vite-pwa/sveltekit` enabled.

Supported install paths in the shipped code/docs:

1. Localhost install from the harness-served client origin on `127.0.0.1:3890`.
2. Hosted static install from the canonical hosted origin used in tests/docs: `https://app.openpalm.dev`.

The PWA build excludes `runtime-config.json` from precache and treats it as `NetworkFirst`. Credentialed remote responses are excluded from runtime caching.

## Security Boundaries

- Host admin remains loopback-only.
- The client artifact does not bundle `@openpalm/lib` and exposes no host APIs.
- The guardian CORS allowlist (`GUARDIAN_CORS_ALLOWED_ORIGINS`) is the only
  **shipped, code-enforced** boundary on browser-direct remote connections —
  a request from an origin not on the allowlist is rejected.
- HTTPS for remote (non-loopback) guardian connections is now **enforced
  client-locally** (#557): `validateConnectionUrl()`
  (`packages/client/src/lib/connections/url-policy.ts`) refuses a plain-HTTP
  connection URL for a non-loopback host whenever the app itself runs on an
  `https:` origin — the platform mixed-content rule, computed from
  `globalThis.location` rather than from any server-declared flag. The
  `/connections` add/edit form refuses the entry before it's saved (error
  deep-links `docs/remote-access-tls.md`), and `probeHealth()` reports an
  existing insecure entry as `'insecure'` (`needs HTTPS` badge) instead of a
  misleading `'unreachable'`. Loopback targets, the loopback-origin desktop
  default, and the LAN-served plain-HTTP client tier are deliberately
  unaffected — see `docs/remote-access-tls.md` for the full tier breakdown.
  `features.ts`'s `requiresHttpsForRemoteConnections` flag remains the
  host-side declaration of this same policy (unchanged; available to a
  future `/api/runtime` handshake) — the client computes the same condition
  itself rather than depending on that flag, since the static client cannot
  read host server context.
- LAN posture (review 2026-07-10 finding I3, fixed): the stack never emits
  `--cors *`; binding a service to a non-loopback address without auth
  configured produces a prominent warning and the client chat co-process is
  not started.
- Assistant-container mode remains isolated from Docker and broad `OP_HOME` access.

## Electron Default Surface (A1/J2/J3)

Electron's `resolveInitialUrl` (`packages/electron/src/main.ts`) defaults every
launch to the full host chat (`@openpalm/ui` at `UI_PORT/chat`). The client SPA
chat is reachable only via an explicit opt-in (`OP_CLIENT_CHAT_OPT_IN=1` or the
desktop settings checkbox, surfaced from the tray) — and even then only once
its own health probe answers; a dead/missing client build silently falls back
to the host chat. This is deliberate: the client chat does not yet meet the
§12.2 chat-parity subset contract in full (see
`docs/technical/ui-runtime-modes-plan.md` §12.2 and
`docs/reviews/ui-admin-migration-review-2026-07-10.md`).

The routing decision itself is delegated to the same landing resolver the host
UI's own navigation guard uses (public `GET /api/runtime/landing`): any landing
other than `/chat` (setup, `/host`, `/host?tab=diagnostics`, `/attention`)
always wins and opens the host app, opt-in or not, because the client artifact
has none of those surfaces. A pending blocking migration (`/attention`) is not
yet reachable in practice because nothing produces the `pending` status —
see `ui-runtime-modes-plan.md` §12 for the follow-up to wire host-UI route
gating ahead of the first real migration.

## Not Yet Shipped (deliberate, scheduled — not regressions)

The following are known Phase 6-8 deferrals, called out explicitly so a user
or reviewer doesn't misreport their absence as something that broke. None of
them regressed from a prior working state; they were never built:

- **Assistant-settings editing from the container surface** (the optional
  "Slice B" settings shim, plan §6.9) — `assistant-container` mode is
  chat-only; ship only when browser-editable assistant settings are actually
  wanted.
- **Phone / hosted install** at `app.openpalm.dev` — CI deploy of the static
  client build to a canonical hosted origin (plan §12.3 item 3).
- **Pairing / QR connection setup** (plan §6.6) — host app `/connections`
  minting a QR + one-time code, client `/connections/new` accepting
  paste-or-scan.

Tracking: #511 (PWA/hosted install, pairing). #557 (guardian edge TLS guide +
client-side HTTPS refusal) shipped — see `docs/remote-access-tls.md` and the
Security Boundaries section above. See
`docs/technical/ui-runtime-modes-plan.md` §12.3-12.4 for the full work-item
breakdown.

## Related Files

| File | Role |
|---|---|
| `packages/ui/src/lib/server/features.ts` | Server runtime-context and host-mode resolution |
| `packages/lib/src/control-plane/client-app-url.ts` | Stable localhost client origin (`3890` / `OP_HOST_CLIENT_PORT`) |
| `packages/cli/src/commands/app.ts` | `openpalm app` entrypoint |
| `packages/cli/src/lib/client-server.ts` | Harness localhost client server |
| `containers/assistant/entrypoint.sh` | Assistant-container artifact install + `runtime-config.json` write |
| `packages/client/vite.config.ts` | PWA manifest and service-worker caching rules |
