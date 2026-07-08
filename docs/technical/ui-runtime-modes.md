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
- Hosted-origin remote connections require HTTPS guardians and matching `GUARDIAN_CORS_ALLOWED_ORIGINS` entries.
- Assistant-container mode remains isolated from Docker and broad `OP_HOME` access.

## Related Files

| File | Role |
|---|---|
| `packages/ui/src/lib/server/features.ts` | Server runtime-context and host-mode resolution |
| `packages/lib/src/control-plane/client-app-url.ts` | Stable localhost client origin (`3890` / `OP_HOST_CLIENT_PORT`) |
| `packages/cli/src/commands/app.ts` | `openpalm app` entrypoint |
| `packages/cli/src/lib/client-server.ts` | Harness localhost client server |
| `containers/assistant/entrypoint.sh` | Assistant-container artifact install + `runtime-config.json` write |
| `packages/client/vite.config.ts` | PWA manifest and service-worker caching rules |
