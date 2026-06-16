# Package Management

## Single Lock File Policy

This repo uses **one lock file**: the root `bun.lock`. All other lock files (`package-lock.json`, nested `bun.lock` files) are either gitignored or deleted.

### Why one lock file

- Bun workspaces resolve all workspace packages from the root `bun.lock`. Nested lock files conflict with this and cause drift.
- `package-lock.json` was a leftover from the v0.5.0 migration. No CI workflow or Dockerfile ever referenced it.
- Multiple lock files cause CI failures (`--frozen-lockfile`) when they drift, confusing diffs, and cognitive overhead.

### Rules

1. **`bun install` at repo root** is the only install command that modifies the lock file.
2. **`--frozen-lockfile`** is used in CI to catch forgotten installs after dependency changes.
3. **`.npmrc`** at repo root contains `package-lock=false` to prevent npm from generating `package-lock.json` when `npm install` runs inside `packages/ui/`.
4. **`package-lock.json`** is in `.gitignore` as a safety net.

### Adding or updating a dependency

```bash
# From repo root:
bun add <package>                        # root dependency
bun add <package> --cwd packages/foo     # workspace package dependency

# Then verify:
bun install --frozen-lockfile            # should pass — lock file is already updated
```

## Cross-Package References

All `@openpalm/*` cross-references in `dependencies`, `devDependencies`, and `peerDependencies` use **real semver ranges** (e.g. `"^0.7.0-rc1"`), not `workspace:*`.

### Why real ranges, not `workspace:*`

- Bun workspaces resolve dependencies by **package name**. When a dependency matches a workspace package, Bun uses the local copy regardless of the version range. A real range like `"^0.7.0-rc1"` works identically to `"workspace:*"` during local development.
- `workspace:*` is a Bun/pnpm-specific protocol. npm cannot resolve it, so published packages would ship the literal string `workspace:*` — breaking consumers.
- Docker builds that `bun install --production` after copying SDK source also resolve by name, so real ranges work there too.

### Keeping ranges in sync

Platform packages (root, `packages/lib`, `containers/guardian`, `packages/cli`, `packages/electron`, `packages/electron/admin-tools`) share a coordinated version (`.github/release-package-groups.json` → `platformManifests`). The full coordinated set — platform + the independents — is `coordinatedManifests`, stamped by `scripts/set-version.mjs` (`scripts/bump-platform.sh` wraps it for the platform-only subset). **All npm publishing flows through a single workflow, `.github/workflows/platform-release.yml`** (the npm trusted publisher for every package — npm allows only one per package and validates the *calling* workflow, so there is one entry point). A coordinated release publishes the npm-bearing platform artifacts plus the Docker images; `@openpalm/ui` remains independently versioned and published through that same workflow entry point. Cross-references between groups use real semver ranges, updated manually when a dependency's API changes — except the CLI's internal `@openpalm/lib` floor range, which `set-version.mjs` keeps in lockstep automatically.

See [`docs/operations/release-management.md`](../operations/release-management.md) for the full release process.

### Why Docker builds don't use lock files

Docker builds install dependencies without `--frozen-lockfile`:

- **Guardian** and **portal** Dockerfiles use `bun install --production` after copying only the source files they need. They don't mount the root lock file because they only install a small subset of workspace dependencies.
- **UI** is a host process (no Docker build). The SvelteKit app is built on the host via `bun run ui:build`; the `openpalm ui serve` command serves it.

This is intentional. The lock file guards the development workflow (ensuring reproducible local installs and CI checks). Docker builds produce immutable images and are tested by CI's `docker compose config` validation.
