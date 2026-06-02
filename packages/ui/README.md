# packages/ui

Optional SvelteKit UI and API for OpenPalm.
OpenPalm remains compose-first and manual-first; the admin addon is a convenience layer for inspecting state and performing stack actions through Docker Socket Proxy.

## Responsibilities

- Web UI for stack status, addons, connections, and automations
- Authenticated `/admin/*` API used by the UI and assistant tools
- Thin control-plane consumer built on `@openpalm/lib`
- Reads the shipped addon catalog from `registry/addons/` and enabled runtime overlays from `stack/addons/`
- Exposes addon schema details and points operators to `knowledge/env/user.env` for values

## Notes on internals

- Some module names still use historical terms like `staging`
- The current runtime model is direct write + Docker Compose over `~/.openpalm/`
- `registry/` is the shipped catalog source; `stack/addons/` are active runtime addon overlays; `knowledge/tasks/` holds active AKM task files
- Compose overlays under `stack/addons/` are deployment truth; admin does not replace that model

## Structure

```text
src/
├── lib/server/        # server-side wrappers around @openpalm/lib + admin helpers
├── lib/components/    # Svelte UI components
└── routes/admin/      # admin API endpoints
```

## Development

The recommended local-dev loop uses Vite HMR pointed at an isolated
`.dev/` `OP_HOME` so your real install at `~/.openpalm/` is never touched.

### Quick start: `ui:dev:isolated` against `.dev/`

```bash
# Once, from repo root — seeds .dev/ with stack.env, dev login password,
# and offset ports. Idempotent; safe to re-run after stack.env changes.
bun run dev:setup

# Iterate:
bun run ui:dev:isolated
```

This is `OP_HOME=$(pwd)/.dev vite dev --port 8100` under the hood. Vite
binds to **`http://localhost:8100/`** — the port matches the host
allowlist (`helpers.ts:checkHostHeader` accepts only the configured
`ADMIN_PORT`, default `8100`); using Vite's default 5173 would 400 on
every request.

**Login**: the password lives in `.dev/knowledge/secrets/op_ui_login_password`:

```bash
tr -d '\n' < .dev/knowledge/secrets/op_ui_login_password
```

**Assistant URL**: by default `.dev/knowledge/env/stack.env` sets
`OP_ASSISTANT_PORT=3800` — so the proxy reaches **your existing prod
assistant container** (no second stack required for UI iteration).
If you want full isolation, spin up the dev compose stack alongside:

```bash
bun run dev:stack
```

That brings up a separate assistant/guardian on the dev ports
(8100/3800/8180 mapped to the dev project) and the UI's proxy still
hits `localhost:3800` — same URL, isolated containers via Docker
project name.

### Why isolated?

`OP_HOME=$(pwd)/.dev` keeps **every** filesystem write the dev server
might make (`config/`, `data/`, `knowledge/`, `workspace/`) inside the gitignored
`.dev/` tree. `~/.openpalm/` is your production install and the
[heightened-caution paths in CLAUDE.md](../../CLAUDE.md) forbid touching
it during dev work.

### Iteration tips

- **HMR works**: edit `.svelte` / `.ts` → page reloads in <1s.
- **Mic works**: Vite serves a real browser context, so the Web Speech
  API isn't gated behind Electron's bundled Chromium. The MediaRecorder
  fallback in `voice-state.svelte.ts` exercises the same `/api/transcribe`
  path the Electron app uses — useful for verifying STT end-to-end.
- **Switching to the prod build**: `bun run ui:build` produces
  `packages/ui/build/` which can be swapped into `~/.openpalm/data/ui/`
  for live testing in the Electron app.

### Other variants

```bash
# Vite HMR with no .dev (default OP_HOME = ~/.openpalm — touches prod, AVOID):
bun run ui:dev

# Run the Electron app in dev mode (no HMR; rebuilds UI + bundles main.ts):
bun run electron:dev
```

### Type / unit / build checks

```bash
bun run ui:check     # svelte-check + tsc
bun run ui:test:unit # vitest
bun run ui:build     # production SvelteKit build
```

## API auth

Protected endpoints require an `op_session` cookie. The browser obtains the
cookie by POSTing the operator password to `/admin/auth/login`. The legacy
`x-admin-token` / `Authorization: Bearer` header fallbacks were removed in
Phase 2 of `docs/technical/auth-and-proxy-refactor-plan.md`.

In a normal install the source of truth for the password is
`~/.openpalm/knowledge/secrets/op_ui_login_password`. Local dev with
`bun run ui:dev:isolated` reads `OP_UI_LOGIN_PASSWORD` from the process
environment seeded by the dev setup helpers.

## Key environment variables

| Variable | Purpose |
|---|---|
| `OP_HOME` | OpenPalm root. Prod: `~/.openpalm`. Dev: `$(pwd)/.dev` via `ui:dev:isolated`. |
| `OP_UI_LOGIN_PASSWORD` | Operator-facing admin password. Stored in `${OP_HOME}/knowledge/secrets/op_ui_login_password` and promoted into the admin process environment. |
| `OP_OPENCODE_URL` / `OP_ASSISTANT_PORT` | Where the proxy forwards `/proxy/assistant/*`. Default `http://localhost:3800`. |
| `OP_OPENCODE_PASSWORD` | Basic-auth password for OpenCode endpoints. Empty in dev (matches the `OPENCODE_AUTH=false` default). |
| `DOCKER_HOST` | Docker Socket Proxy URL inside the addon network. |
