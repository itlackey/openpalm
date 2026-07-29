# @openpalm/ui

`@openpalm/ui` is the SvelteKit browser UI used by OpenPalm's assistant image,
host CLI, and Electron harness.

It provides chat and connection experiences everywhere. Host stack management
is exposed only when the server process has the host-admin capability.

## Route Contract

| Route | Purpose |
|---|---|
| `/chat`, `/connections`, `/advanced` | User-facing application |
| `/host` | Host dashboard in an admin-capable CLI/Electron process |
| `/api/auth/*` | Login, logout, and session |
| `/api/host/*` | Host control plane, capability-gated server-side |
| `/api/assistant/*` | Assistant-owned model, persona, and AKM settings |
| `/oc/*` | Same-origin OpenCode proxy |

`/admin/*` is intentionally unimplemented and returns `404`; there is no alias
for old pages or APIs. Guardian's separate `:3831/admin/principals` listener is
not a UI route.

## Runtime Modes

### Assistant Image

The production assistant image bakes the candidate-local compiled UI at build
time and serves it as a supervised non-admin co-process on container port `3000`
(host default `3800`). Startup does not install or resolve a runtime UI tarball;
skeleton delivery is host-side.

### Host CLI and Electron

Host processes can serve the package from their bundled build or from the
host-managed `OP_HOME/data/ui` build. `openpalm admin` enables host capabilities
and remains loopback-only. Bare `openpalm` and `openpalm app` are non-admin.

The UI is a consumer of `@openpalm/lib`; portable Compose/lifecycle logic stays
in the shared library.

## Source Layout

```text
src/
├── lib/components/          Svelte components
├── lib/api/                 Browser API clients
├── lib/server/              Server-only auth, capability, and control-plane adapters
└── routes/
    ├── (app)/               Chat, connections, advanced, and host pages
    ├── api/auth/            Session routes
    ├── api/host/            Host control-plane routes
    ├── api/assistant/       Assistant-owned settings routes
    ├── api/setup/           Host setup routes
    └── oc/                  Same-origin OpenCode proxy
```

## Development

Package-local Vite development uses port `5173` by default:

```bash
cd packages/ui
npm install
npm run dev
```

From the repository root, the isolated script uses `.dev/` and port `3880`:

```bash
bun run dev:setup
bun run ui:dev:isolated
```

Open <http://localhost:3880/> for the isolated root script. Its login password
is stored at:

```text
.dev/private/secrets/op_ui_login_password
```

Read it on Unix without printing an extra newline:

```bash
tr -d '\n' < .dev/private/secrets/op_ui_login_password
```

The isolated `OP_HOME` keeps generated config, state, private credentials,
knowledge, data, cache, and workspace writes out of the user's real
`~/.openpalm/` installation.

Start the isolated Compose stack when UI work needs live OpenCode/Guardian
services:

```bash
bun run dev:stack
```

## Checks

```bash
bun run ui:check
bun run ui:test:unit
bun run ui:build
```

Use `bun run ui:test:e2e` from the repository root for Playwright integration
tests.

## Authentication

Post the operator password to `/api/auth/login`. Successful authentication
issues the `op_session` cookie with `HttpOnly`, `SameSite=Lax`, path `/`, and
`Secure` on HTTPS.

The production password file is:

```text
${OP_HOME}/private/secrets/op_ui_login_password
```

There is no browser bearer-token fallback and no `localStorage` admin token.

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `OP_HOME` | OpenPalm home used by host-capable processes |
| `PORT` | UI server port; package dev defaults to `5173`, OpenPalm host serving to `3880` |
| `OP_UI_LOGIN_PASSWORD` | Password injected into the serving process from the private secret file |
| `OP_OPENCODE_URL` | Server-side OpenCode target for the same-origin proxy |
| `OP_ASSISTANT_PORT` | Host assistant port fallback, normally `3810` |
| `OP_ENABLE_ADMIN` | Internal host-harness capability flag; do not set on remote/container serving |

The host admin process accesses Docker directly on the host. No container or
Docker socket proxy is part of the UI runtime.
