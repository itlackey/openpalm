# Development Workflow (v0.3.0)

## 1) Boot a local dev environment
```bash
bun install
bun run dev:setup
bun run dev:build
```

Use `bun run dev:up`, `bun run dev:down`, and `bun run dev:logs` for day-to-day control.

## 2) Make changes with clear ownership
- **core/admin**: setup/orchestration APIs and compose lifecycle.
- **core/gateway**: channel ingress, auth, intake, routing.
- **core/assistant**: bundled extensions and assistant runtime integration.
- **channels/***: platform adapters that normalize and forward to gateway.
- **packages/lib**: shared schemas/generation/validation.
- **packages/cli** and **packages/ui**: operator interfaces backed by lib/admin APIs.

## 3) Validate before commit
```bash
bun run typecheck
bun test
```

If you touch the UI:

```bash
bun run test:ui
```

If you touch Dockerfiles or compose behavior:

```bash
bun run test:docker
```

For faster iteration, run workspace-targeted tests (for example `cd core/gateway && bun test`).

## 4) Keep changes safe
- Keep `openpalm.yaml` intent-only.
- Keep gateway as the only channel ingress path to assistant.
- Keep secrets scoped through generated container `.env` files.
- Do not bypass compose allowlists in admin paths.

## 5) Debug checklist
- Confirm generated files under CONFIG/STATE paths match expected render output.
- Verify healthchecks and URL paths when touching compose or routing.
- For channel issues, inspect gateway audit logs first, then channel adapter logs.
