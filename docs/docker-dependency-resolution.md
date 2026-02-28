# Docker Dependency Resolution

## Problem

The monorepo uses Bun workspaces locally, where `bun install` at the repo root
hoists all dependencies so module resolution works seamlessly. Docker builds
don't have this luxury — each service builds in isolation, and the workspace
structure isn't available.

The admin service uses a Vite alias to resolve `@openpalm/lib` to source:

```
"@openpalm/lib": resolve(__dirname, "../../packages/lib/src")
```

When Vite processes `packages/lib/src/shared/env.ts`, that file imports `dotenv`.
Standard Node module resolution walks **up the directory tree** from the
importing file looking for `node_modules/dotenv`. If `node_modules` isn't at a
common ancestor of both the admin source and the lib source, resolution fails.

## Solution: Admin (SvelteKit/Node build)

Install admin's dependencies at the **workspace root** (`/workspace/`) so
`node_modules` sits at a common ancestor of both `core/admin/` and
`packages/lib/`:

```
/workspace/
├── node_modules/        ← npm install puts deps here (real dirs, no symlinks)
│   └── dotenv/          ← resolvable from any subdirectory
├── core/admin/          ← SvelteKit source + vite.config.ts
├── packages/lib/src/    ← aliased via @openpalm/lib
├── assets/
└── registry/
```

Resolution from `packages/lib/src/shared/env.ts`:
```
/workspace/packages/lib/src/shared/node_modules/ → no
/workspace/packages/lib/src/node_modules/        → no
/workspace/packages/lib/node_modules/            → no
/workspace/packages/node_modules/                → no
/workspace/node_modules/                         → dotenv found (real directory)
```

Key details:
- `npm install` (not Bun) creates standard flat `node_modules/` — real
  directories, no symlinks
- `ENV PATH="/workspace/node_modules/.bin:$PATH"` makes build tool binaries
  (svelte-kit, vite) available to `npm run build` from the `core/admin/` subdirectory
- No Bun binary, no workspace protocol, no lockfile coupling
- The output is a self-contained SvelteKit adapter-node bundle — no runtime
  `node_modules` needed

## Solution: Guardian + Channels (Bun runtime)

These services copy `packages/lib` source directly into
`/app/node_modules/@openpalm/lib` and run on Bun. To resolve lib's own
transitive dependencies (e.g. dotenv), each Dockerfile runs:

```dockerfile
RUN cd /app/node_modules/@openpalm/lib && bun install --production
```

This installs lib's declared dependencies into
`/app/node_modules/@openpalm/lib/node_modules/`. Since these services run on
Bun (which created the install), there's no cross-tool resolution concern.

## Why not Bun workspace install in Docker?

Bun's `node_modules` layout uses symlinks to a `.bun/` cache directory. While
this works with Bun's own resolver, it couples the Docker build to Bun's
internal implementation detail. The admin build runs on Node.js/Vite, so
depending on Bun's symlink structure for Node module resolution is fragile.

## Files changed

| File | What | Why |
|------|------|-----|
| `core/admin/Dockerfile` | npm install at workspace root | Common ancestor for module resolution |
| `core/guardian/Dockerfile` | Install lib's deps after copy | Fix missing dotenv (pre-existing bug) |
| `channels/*/Dockerfile` | Install lib's deps after copy | Robustness for future lib dependencies |
