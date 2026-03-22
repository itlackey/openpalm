# packages/admin

Optional SvelteKit admin UI and API for OpenPalm.
OpenPalm remains compose-first and manual-first; the admin addon is a convenience layer for inspecting state and performing stack actions through Docker Socket Proxy.

## Responsibilities

- Web UI for stack status, addons, connections, automations, and memory settings
- Authenticated `/admin/*` API used by the UI and assistant tools
- Thin control-plane consumer built on `@openpalm/lib`
- Registry catalog bundling for built-in addons and automations

## Notes on internals

- Some module names still use historical terms like `staging`
- The current runtime model is direct write + Docker Compose over `~/.openpalm/`
- Compose overlays under `stack/addons/` are deployment truth; admin does not replace that model

## Structure

```text
src/
├── lib/server/        # server-side wrappers around @openpalm/lib + admin helpers
├── lib/components/    # Svelte UI components
└── routes/admin/      # admin API endpoints
```

## Development

Local dev is package-local only; it does not represent the deployed admin addon port mapping.

```bash
cd packages/admin
npm install
npm run dev
npm run check
```

Repo-root shortcuts:

```bash
bun run admin:dev
bun run admin:check
```

`npm run dev` uses Vite's local dev server. The deployed admin addon is served on `http://localhost:3880` by default.

## API auth

Protected endpoints require `x-admin-token`.
In a normal install the token source of truth is `~/.openpalm/vault/stack/stack.env` as `OP_ADMIN_TOKEN`.

## Key environment variables

| Variable | Purpose |
|---|---|
| `OP_HOME` | OpenPalm root mounted into the container, usually `~/.openpalm` |
| `ADMIN_TOKEN` | Runtime admin API token (compose-mapped from `OP_ADMIN_TOKEN` in stack.env) |
| `DOCKER_HOST` | Docker Socket Proxy URL inside the addon network |
| `MEMORY_AUTH_TOKEN` | Memory service bearer token (compose-mapped from `OP_MEMORY_TOKEN` in stack.env) |
