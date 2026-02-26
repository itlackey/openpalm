# OpenPalm UI (`packages/ui`)

This package contains the OpenPalm Admin web application (SvelteKit + TypeScript).

## What this UI does
- Drives setup and first-run workflows.
- Provides authenticated admin controls for configuration and operations.
- Calls Admin API endpoints for secrets, channels, and stack lifecycle actions.
- Provides a three-tab stack configuration workflow:
  - **Configure** for enabled containers
  - **Add** for searchable template discovery and instance creation
  - **Advanced** for direct YAML editing

## Development
From repo root:

```bash
bun install
cd packages/ui
bun run dev
```

By default, this starts the SvelteKit dev server. For full platform behavior, run the root stack scripts (`bun run dev:setup`, `bun run dev:up`) and use the UI through the OpenPalm gateway/caddy routes.

## Build and test
```bash
cd packages/ui
bun run check
bun test
bun run build
```

## Project notes
- Keep UI behavior aligned with Admin API contracts in `dev/docs/api-reference.md`.
- Security-sensitive validation must be enforced server-side; client checks are UX only.
- The config editor and related UX should remain aligned with OpenPalm's YAML-first stack model (`openpalm.yaml`).
